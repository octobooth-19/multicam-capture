'use strict';

const preview = document.querySelector('#preview');
const status = document.querySelector('#status span:nth-child(2)');
const errorBox = document.querySelector('#error');
const connectButton = document.querySelector('#connect');
const retryButton = document.querySelector('#retry');
const settings = ['name', 'lens', 'resolution'].map(id => document.getElementById(id));
const peers = new Map();
const pendingCandidates = new Map();
let stream, cameraId, events, wakeLock, recorder, currentTake, pendingUpload;
let clockOffset = 0;
let startTimer, stopTimer;
let statusUpdates = Promise.resolve();

function setStatus(value) { status.textContent = value; }
function showError(error) { errorBox.textContent = error.message || String(error); }
function reportStatus(value, progress) {
  setStatus(progress === undefined ? value : `${value} ${progress}%`);
  if (cameraId) {
    statusUpdates = statusUpdates.catch(showError).then(() =>
      post('/api/camera', { id: cameraId, status: value, ...(progress === undefined ? {} : { progress }) }));
    statusUpdates.catch(showError);
  }
}
async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    const response = await fetch('/time', { cache: 'no-store' });
    if (!response.ok) throw new Error('Clock synchronization failed');
    const { serverTime } = await response.json();
    const after = Date.now();
    if (after - before < best) { best = after - before; clockOffset = serverTime - (before + after) / 2; }
  }
}
async function acquireWakeLock() {
  if ('wakeLock' in navigator && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch (error) { showError(new Error(`Screen wake lock unavailable: ${error.message}`)); }
  }
}
document.addEventListener('visibilitychange', () => { if (cameraId && document.visibilityState === 'visible') acquireWakeLock(); });
function signal(dashboardId, kind, payload) {
  return post('/api/signal', { from: 'camera', cameraId, dashboardId, kind, payload });
}
function closePeer(id) {
  peers.get(id)?.close(); peers.delete(id); pendingCandidates.delete(id);
}
async function connectPreview(dashboardId) {
  closePeer(dashboardId);
  const pc = new RTCPeerConnection({ iceServers: [] });
  peers.set(dashboardId, pc);
  const candidates = [];
  let offerSent = false;
  pc.onicecandidate = event => {
    if (!event.candidate) return;
    if (!offerSent) candidates.push(event.candidate);
    else signal(dashboardId, 'candidate', event.candidate).catch(showError);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      showError(new Error('Preview connection failed. Check that both devices are on the same Wi-Fi.'));
      signal(dashboardId, 'error', 'Connection failed').catch(showError);
    }
  };
  for (const track of stream.getVideoTracks()) {
    const sender = pc.addTrack(track, stream);
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 600000;
    parameters.encodings[0].scaleResolutionDownBy = Math.max(1, (track.getSettings().height || 720) / 720);
    try { await sender.setParameters(parameters); }
    catch (error) { console.warn('Could not limit preview quality:', error); }
  }
  await pc.setLocalDescription(await pc.createOffer());
  await signal(dashboardId, 'offer', pc.localDescription);
  offerSent = true;
  for (const candidate of candidates) await signal(dashboardId, 'candidate', candidate);
}
async function handleSignal(data) {
  const { dashboardId, kind, payload } = data;
  const pc = peers.get(dashboardId);
  if (!pc) return;
  if (kind === 'answer') {
    await pc.setRemoteDescription(payload);
    for (const candidate of pendingCandidates.get(dashboardId) || []) await pc.addIceCandidate(candidate);
    pendingCandidates.delete(dashboardId);
  } else if (kind === 'candidate') {
    if (pc.remoteDescription) await pc.addIceCandidate(payload);
    else {
      const queue = pendingCandidates.get(dashboardId) || [];
      queue.push(payload); pendingCandidates.set(dashboardId, queue);
    }
  }
}
function mimeType() {
  return ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
}
function reportTake(data) { return post('/api/takes/report', { takeId: currentTake.id, cameraId, ...data }); }
async function upload() {
  const { blob, takeId, mime } = pendingUpload;
  const chunkSize = 1024 * 1024;
  retryButton.classList.add('hidden');
  reportStatus('Uploading', 0);
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = blob.slice(offset, offset + chunkSize);
    const query = new URLSearchParams({ take: takeId, camera: cameraId, offset, total: blob.size, mime });
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(`/api/upload?${query}`, { method: 'POST', body: chunk });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
        lastError = null; break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    if (lastError) throw lastError;
    reportStatus('Uploading', Math.round(Math.min(offset + chunk.size, blob.size) / blob.size * 100));
  }
  pendingUpload = null; currentTake = null; recorder = null;
  reportStatus('Done'); errorBox.textContent = '';
}
async function uploadOrShowError() {
  try { await upload(); }
  catch (error) { showError(new Error(`Upload failed: ${error.message}. Keep this page open and retry.`)); retryButton.classList.remove('hidden'); reportStatus('Error'); }
}
retryButton.addEventListener('click', uploadOrShowError);
function startTake(data) {
  if (currentTake?.id === data.takeId) return;
  if (currentTake || pendingUpload) { showError(new Error('Cannot start: previous take is not finished.')); return; }
  currentTake = { id: data.takeId, startAt: data.startAt };
  const delay = Math.max(0, data.startAt - (Date.now() + clockOffset));
  setStatus('Starting…');
  startTimer = setTimeout(async () => {
    try {
      const type = mimeType();
      if (!type) throw new Error('This browser does not support MP4 or WebM recording.');
      const chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: type });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => {
        const error = event.error || new Error('Recording failed');
        showError(error); reportStatus('Error'); reportTake({ error: error.message }).catch(showError);
      };
      recorder.onstop = async () => {
        const duration = Math.max(0, Date.now() + clockOffset - currentTake.actualStartTime);
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) {
          const error = new Error('Recording is empty.');
          showError(error); reportStatus('Error'); reportTake({ error: error.message }).catch(showError); return;
        }
        pendingUpload = { blob, takeId: currentTake.id, mime: recorder.mimeType.split(';')[0] };
        try { await reportTake({ duration }); } catch (error) { showError(error); }
        await uploadOrShowError();
      };
      recorder.start(1000);
      currentTake.actualStartTime = Date.now() + clockOffset;
      reportStatus('Recording');
      await reportTake({ actualStartTime: currentTake.actualStartTime });
    } catch (error) {
      showError(error); reportStatus('Error'); reportTake({ error: error.message }).catch(showError);
    }
  }, delay);
}
function stopTake(data) {
  if (!currentTake || currentTake.id !== data.takeId || pendingUpload) return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (recorder?.state === 'recording') recorder.stop();
    else if (!recorder) { showError(new Error('Recording could not start.')); reportStatus('Error'); }
  }, Math.max(0, data.stopAt - (Date.now() + clockOffset)));
}
setInterval(() => {
  document.querySelector('#phone-timer').textContent = recorder?.state === 'recording' ?
    formatTime((Date.now() + clockOffset - currentTake.actualStartTime) / 1000) : '';
}, 250);
connectButton.addEventListener('click', async () => {
  connectButton.disabled = true; errorBox.textContent = '';
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.RTCPeerConnection) throw new Error('Camera, recording, or WebRTC is unavailable. Use a supported browser over HTTPS.');
    const height = Number(document.querySelector('#resolution').value);
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: { ideal: document.querySelector('#lens').value }, width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height } } });
    preview.srcObject = stream; document.querySelector('#preview-label').hidden = true;
    const trackSettings = stream.getVideoTracks()[0].getSettings();
    const resolution = trackSettings.width && trackSettings.height ? `${trackSettings.width} × ${trackSettings.height}` : `${height}p requested`;
    await syncClock();
    const result = await post('/api/cameras', { name: document.querySelector('#name').value, resolution, device: navigator.userAgent });
    cameraId = result.id;
    settings.forEach(input => { input.disabled = true; });
    connectButton.classList.add('hidden');
    await acquireWakeLock();
    events = new EventSource(`/events?role=camera&id=${cameraId}`);
    events.onopen = () => { if (!currentTake && !pendingUpload) reportStatus('Armed'); };
    events.onerror = () => { setStatus('Reconnecting…'); };
    events.addEventListener('dashboards', event => { JSON.parse(event.data).forEach(id => connectPreview(id).catch(showError)); });
    events.addEventListener('dashboard-joined', event => { connectPreview(JSON.parse(event.data).id).catch(showError); });
    events.addEventListener('dashboard-left', event => closePeer(JSON.parse(event.data).id));
    events.addEventListener('signal', event => handleSignal(JSON.parse(event.data)).catch(showError));
    events.addEventListener('camera-updated', event => { document.querySelector('#name').value = JSON.parse(event.data).name; });
    events.addEventListener('start', event => startTake(JSON.parse(event.data)));
    events.addEventListener('stop', event => stopTake(JSON.parse(event.data)));
    events.addEventListener('removed', () => {
      events.close(); clearTimeout(startTimer); clearTimeout(stopTimer);
      for (const id of peers.keys()) closePeer(id);
      stream.getTracks().forEach(track => track.stop()); wakeLock?.release();
      setStatus('Removed'); showError(new Error('This camera was removed. Reload the page to reconnect.'));
    });
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop()); showError(error); connectButton.disabled = false;
  }
});
