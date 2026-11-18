'use strict';

const dashboardId = crypto.randomUUID();
const cameras = new Map();
const peers = new Map();
const pendingCandidates = new Map();
const takes = new Map();
const grid = document.querySelector('#cameras');
const empty = document.querySelector('#empty');
const recordButton = document.querySelector('#record');
const timer = document.querySelector('#timer');
const message = document.querySelector('#message');
let activeTake = null;
let connected = false;
let busy = false;

function showError(error) { message.textContent = error.message || String(error); }
function signal(cameraId, kind, payload) {
  return post('/api/signal', { from: 'dashboard', dashboardId, cameraId, kind, payload });
}
function closePeer(id) {
  peers.get(id)?.close();
  peers.delete(id);
  pendingCandidates.delete(id);
}
function renderCamera(camera) {
  cameras.set(camera.id, camera);
  let tile = document.getElementById(`camera-${camera.id}`);
  if (!tile) {
    tile = document.createElement('article');
    tile.id = `camera-${camera.id}`;
    tile.className = 'camera-tile';
    const videoArea = document.createElement('div'); videoArea.className = 'video-area';
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    videoArea.append(video, text('span', 'WAITING FOR PREVIEW', 'preview-placeholder'));
    const details = document.createElement('div'); details.className = 'camera-details';
    const info = document.createElement('div'); info.className = 'camera-info';
    info.append(text('h3', '', 'camera-name'), text('p', '', 'camera-meta'));
    const actions = document.createElement('div'); actions.className = 'tile-actions';
    const rename = text('button', 'Rename'); rename.type = 'button';
    rename.addEventListener('click', async () => {
      const name = prompt('Camera name', cameras.get(camera.id)?.name);
      if (name === null) return;
      try { await post('/api/camera', { id: camera.id, name }); } catch (error) { showError(error); }
    });
    const remove = text('button', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm('Remove this camera?')) return;
      try { await post('/api/remove', { id: camera.id }); } catch (error) { showError(error); }
    });
    actions.append(rename, remove); details.append(info, actions); tile.append(videoArea, details);
    grid.append(tile);
  }
  tile.querySelector('.camera-name').textContent = camera.name;
  tile.querySelector('.camera-meta').textContent = `${camera.connected ? camera.status : 'Disconnected'}${camera.status === 'Uploading' ? ` ${camera.progress}%` : ''} · ${camera.resolution || 'Resolution pending'}`;
  if (!camera.connected) closePeer(camera.id);
  document.querySelector('#camera-count').textContent = cameras.size;
  empty.hidden = cameras.size > 0;
  updateControls();
}
function updateControls() {
  recordButton.disabled = busy || !connected || (!activeTake && (![...cameras.values()].some(c => c.connected) ||
    [...cameras.values()].some(c => c.connected && !['Armed', 'Done'].includes(c.status))));
  recordButton.classList.toggle('is-recording', Boolean(activeTake));
  recordButton.querySelector('span:last-child').textContent = activeTake ? 'Stop recording' : 'Record';
}
async function handleSignal(data) {
  const { cameraId, kind, payload } = data;
  if (kind === 'error') { showError(new Error(`Preview: ${payload}`)); return; }
  if (kind === 'offer') {
    const queued = pendingCandidates.get(cameraId) || [];
    closePeer(cameraId);
    pendingCandidates.set(cameraId, queued);
    const pc = new RTCPeerConnection({ iceServers: [] });
    peers.set(cameraId, pc);
    pc.ontrack = event => {
      const tile = document.getElementById(`camera-${cameraId}`);
      if (!tile) return;
      tile.querySelector('video').srcObject = event.streams[0] || new MediaStream([event.track]);
      tile.classList.add('has-preview');
    };
    pc.onicecandidate = event => { if (event.candidate) signal(cameraId, 'candidate', event.candidate).catch(showError); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        const tile = document.getElementById(`camera-${cameraId}`);
        if (tile) { tile.classList.remove('has-preview'); tile.querySelector('.preview-placeholder').textContent = 'PREVIEW CONNECTION FAILED'; }
      }
    };
    await pc.setRemoteDescription(payload);
    for (const candidate of pendingCandidates.get(cameraId) || []) await pc.addIceCandidate(candidate);
    pendingCandidates.delete(cameraId);
    await pc.setLocalDescription(await pc.createAnswer());
    await signal(cameraId, 'answer', pc.localDescription);
  } else if (kind === 'candidate') {
    const pc = peers.get(cameraId);
    if (pc?.remoteDescription) await pc.addIceCandidate(payload);
    else {
      const queue = pendingCandidates.get(cameraId) || [];
      queue.push(payload); pendingCandidates.set(cameraId, queue);
    }
  }
}
function renderTake(take) {
  takes.set(take.id, take);
  const list = document.querySelector('#takes'); list.replaceChildren();
  if (!takes.size) { list.append(text('p', 'Your recordings will appear here after your first take.', 'subtle')); return; }
  for (const item of [...takes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const card = document.createElement('article'); card.className = 'take-card';
    const header = document.createElement('div'); header.className = 'take-header';
    const title = document.createElement('div');
    title.append(text('h3', item.name), text('p', new Date(item.createdAt).toLocaleString(), 'fine'));
    header.append(title, text('span', item.status.toUpperCase(), `take-status ${item.status}`));
    const angles = document.createElement('div'); angles.className = 'angles';
    for (const camera of item.cameras) {
      const angle = document.createElement('div'); angle.className = 'angle';
      angle.append(text('strong', camera.name), text('span', camera.error || camera.status, 'fine'));
      if (camera.file) {
        const url = `/recordings/${encodeURIComponent(item.id)}/${encodeURIComponent(camera.file)}`;
        const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = url;
        const link = text('a', 'Download original ↓'); link.href = url; link.download = camera.file;
        angle.append(video, link);
      }
      angles.append(angle);
    }
    card.append(header, angles); list.append(card);
  }
}
recordButton.addEventListener('click', async () => {
  busy = true; updateControls(); message.textContent = '';
  try {
    if (activeTake) await post('/api/takes/stop', {});
    else await post('/api/takes/start', { name: document.querySelector('#take-name').value });
  } catch (error) { showError(error); }
  finally { busy = false; updateControls(); }
});
setInterval(() => { timer.textContent = activeTake ? formatTime((Date.now() - activeTake.startAt) / 1000) : '00:00'; }, 250);
fetch('/api/config').then(r => { if (!r.ok) throw new Error('Could not load join URL'); return r.json(); }).then(config => {
  const link = document.querySelector('#join-url'); link.textContent = config.joinUrl; link.href = config.joinUrl;
}).catch(showError);
const events = new EventSource(`/events?role=dashboard&id=${dashboardId}`);
events.onopen = () => { connected = true; document.querySelector('#connection').textContent = 'Studio online'; updateControls(); };
events.onerror = () => { connected = false; document.querySelector('#connection').textContent = 'Reconnecting'; updateControls(); };
events.addEventListener('snapshot', event => {
  const data = JSON.parse(event.data);
  for (const id of cameras.keys()) { closePeer(id); document.getElementById(`camera-${id}`)?.remove(); }
  cameras.clear(); takes.clear(); grid.replaceChildren();
  data.cameras.forEach(renderCamera); data.takes.forEach(take => takes.set(take.id, take));
  if (data.takes.length) renderTake(data.takes[0]); else document.querySelector('#takes').replaceChildren(text('p', 'Your recordings will appear here after your first take.', 'subtle'));
  document.querySelector('#camera-count').textContent = cameras.size; empty.hidden = cameras.size > 0;
  activeTake = data.activeTake ? takes.get(data.activeTake) : null; updateControls();
});
events.addEventListener('camera', event => renderCamera(JSON.parse(event.data)));
events.addEventListener('camera-removed', event => {
  const { id } = JSON.parse(event.data); cameras.delete(id); closePeer(id); document.getElementById(`camera-${id}`)?.remove();
  document.querySelector('#camera-count').textContent = cameras.size; empty.hidden = cameras.size > 0; updateControls();
});
events.addEventListener('take', event => renderTake(JSON.parse(event.data)));
events.addEventListener('active-take', event => { activeTake = JSON.parse(event.data); updateControls(); });
events.addEventListener('signal', event => { handleSignal(JSON.parse(event.data)).catch(showError); });
