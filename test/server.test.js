'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multicam-test-'));
  const app = createApp({ recordingsDir: dir });
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function post(url, data) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  async function stream(url) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let buffer = '';
    return { async next(type) {
      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index >= 0) {
          const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const name = /^event: (.+)$/m.exec(event)?.[1];
          if (name === type) return JSON.parse(/^data: (.+)$/m.exec(event)[1]);
          continue;
        }
        const result = await reader.read();
        if (result.done) throw new Error(`Stream ended before ${type}`);
        buffer += new TextDecoder().decode(result.value);
      }
    }, close: () => reader.cancel() };
  }
  return { dir, base, app, post, stream };
}

test('time, registry and signaling relay', async t => {
  const { base, post, stream } = await setup(t);
  const before = Date.now();
  const time = await (await fetch(`${base}/time`)).json();
  assert.ok(time.serverTime >= before && time.serverTime <= Date.now());
  const dashboard = await stream('/events?role=dashboard&id=dashboard-1');
  assert.deepEqual((await dashboard.next('snapshot')).cameras, []);
  const camera = await post('/api/cameras', { name: 'Wide', resolution: '1280 × 720', device: 'phone' });
  assert.equal(camera.status, 201);
  assert.equal((await dashboard.next('camera')).name, 'Wide');
  const phone = await stream(`/events?role=camera&id=${camera.data.id}`);
  assert.deepEqual(await phone.next('dashboards'), ['dashboard-1']);
  await post('/api/signal', { from: 'camera', cameraId: camera.data.id, dashboardId: 'dashboard-1', kind: 'offer', payload: { sdp: 'test' } });
  assert.deepEqual((await dashboard.next('signal')).payload, { sdp: 'test' });
  await post('/api/signal', { from: 'dashboard', cameraId: camera.data.id, dashboardId: 'dashboard-1', kind: 'answer', payload: { sdp: 'answer' } });
  assert.equal((await phone.next('signal')).payload.sdp, 'answer');
  await post('/api/camera', { id: camera.data.id, name: 'Close-up' });
  assert.equal((await phone.next('camera-updated')).name, 'Close-up');
  assert.equal((await post('/api/remove', { id: camera.data.id })).status, 200);
  assert.equal((await dashboard.next('camera-removed')).id, camera.data.id);
  await dashboard.close(); await phone.close();
});

test('scheduled take, chunk retries, metadata, file serving, and reload', async t => {
  const { dir, base, post, stream } = await setup(t);
  const camera = (await post('/api/cameras', { name: '../../Wide', device: 'test phone', resolution: '1920x1080' })).data;
  const phone = await stream(`/events?role=camera&id=${camera.id}`);
  const started = await post('/api/takes/start', { name: 'Scene one' });
  assert.equal(started.status, 201);
  assert.ok(started.data.startAt >= Date.now());
  assert.equal((await phone.next('start')).takeId, started.data.id);
  assert.equal((await post('/api/takes/start', {})).status, 409);
  const actualStartTime = started.data.startAt + 12;
  await post('/api/takes/report', { takeId: started.data.id, cameraId: camera.id, actualStartTime });
  assert.equal((await post('/api/takes/stop', {})).status, 200);
  assert.equal((await phone.next('stop')).takeId, started.data.id);
  await post('/api/takes/report', { takeId: started.data.id, cameraId: camera.id, duration: 1234 });
  async function upload(offset, content, total = 6) {
    const query = new URLSearchParams({ take: started.data.id, camera: camera.id, offset, total, mime: 'video/webm' });
    return fetch(`${base}/api/upload?${query}`, { method: 'POST', body: content });
  }
  assert.equal((await upload(3, 'def')).status, 409);
  assert.equal((await upload(0, 'abc')).status, 200);
  assert.equal((await upload(0, 'abc')).status, 200);
  assert.equal((await upload(0, 'xyz')).status, 409);
  assert.equal((await upload(3, 'def', 7)).status, 409);
  assert.equal((await upload(3, 'def')).status, 200);
  assert.equal((await upload(3, 'def')).status, 200);
  const metadata = JSON.parse(await fs.readFile(path.join(dir, started.data.id, 'take.json')));
  const entry = metadata.cameras[0];
  assert.equal(metadata.status, 'complete');
  assert.equal(entry.actualStartTime, actualStartTime);
  assert.equal(entry.duration, 1234);
  assert.equal(entry.fileSize, 6);
  assert.equal(entry.mimeType, 'video/webm');
  assert.match(entry.file, /^Wide-[a-f0-9]{8}\.webm$/);
  assert.equal(await fs.readFile(path.join(dir, started.data.id, entry.file), 'utf8'), 'abcdef');
  const media = await fetch(`${base}/recordings/${started.data.id}/${entry.file}`, { headers: { Range: 'bytes=1-3' } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), 'bcd');
  assert.equal((await fetch(`${base}/recordings/${started.data.id}/take.json`)).status, 404);
  const reloaded = createApp({ recordingsDir: dir });
  reloaded.close();
  await phone.close();
});

test('rejects invalid uploads and handles multi-camera completion', async t => {
  const { base, post, stream } = await setup(t);
  const ids = [];
  const streams = [];
  for (const name of ['One', 'Two']) {
    const id = (await post('/api/cameras', { name })).data.id;
    ids.push(id); streams.push(await stream(`/events?role=camera&id=${id}`));
  }
  const take = (await post('/api/takes/start', {})).data;
  await post('/api/takes/stop', {});
  const send = async (id, mime) => {
    const query = new URLSearchParams({ take: take.id, camera: id, offset: 0, total: 1, mime });
    return fetch(`${base}/api/upload?${query}`, { method: 'POST', body: 'x' });
  };
  assert.equal((await send(ids[0], 'text/plain')).status, 400);
  assert.equal((await send('unknown', 'video/mp4')).status, 404);
  assert.equal((await send(ids[0], 'video/mp4')).status, 200);
  assert.equal((await (await fetch(`${base}/api/takes`)).json())[0].status, 'uploading');
  assert.equal((await send(ids[1], 'video/mp4')).status, 200);
  assert.equal((await (await fetch(`${base}/api/takes`)).json())[0].status, 'complete');
  await Promise.all(streams.map(s => s.close()));
});
