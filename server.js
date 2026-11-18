'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const MAX_CHUNK = 8 * 1024 * 1024;
const TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function certificate(address) {
  const dir = path.join(ROOT, '.cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let valid = false;
  if (fs.existsSync(key) && fs.existsSync(cert)) {
    try {
      const info = new crypto.X509Certificate(fs.readFileSync(cert));
      valid = Boolean(info.checkIP(address)) && Boolean(info.checkHost('localhost')) &&
        new Date(info.validTo).getTime() > Date.now();
    } catch (error) {
      console.warn('Existing certificate is invalid; generating a replacement:', error.message);
    }
  }
  if (!valid) {
    const config = path.join(dir, 'openssl.cnf');
    fs.writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Multicam Capture\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:${address}\n`);
    try {
      execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '365', '-config', config, '-extensions', 'ext'],
      { stdio: 'ignore' });
      fs.chmodSync(key, 0o600);
    } finally {
      fs.unlinkSync(config);
    }
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function safeName(value) {
  return String(value || '').trim().slice(0, 60).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'camera';
}
function label(value, fallback) {
  return String(value || '').trim().slice(0, 60) || fallback;
}

function createApp({ recordingsDir = path.join(ROOT, 'recordings') } = {}) {
  fs.mkdirSync(recordingsDir, { recursive: true });
  const cameras = new Map();
  const dashboards = new Map();
  const takes = new Map();
  const locks = new Map();
  let activeTake = null;
  let stopping = false;
  let closed = false;

  function send(response, type, data) {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function publicCamera(camera) {
    return { id: camera.id, name: camera.name, device: camera.device, resolution: camera.resolution,
      status: camera.status, connected: Boolean(camera.response), progress: camera.progress || 0 };
  }
  function broadcast(type, data) {
    for (const response of dashboards.values()) send(response, type, data);
  }
  function updateCamera(camera) { broadcast('camera', publicCamera(camera)); }
  function takeDir(id) { return path.join(recordingsDir, id); }
  async function saveTake(take) {
    await fsp.mkdir(takeDir(take.id), { recursive: true });
    const temp = path.join(takeDir(take.id), `take-${crypto.randomUUID()}.tmp`);
    await fsp.writeFile(temp, JSON.stringify(take, null, 2));
    await fsp.rename(temp, path.join(takeDir(take.id), 'take.json'));
  }
  function locked(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  }
  async function mutateTake(id, fn) {
    return locked(`take:${id}`, async () => {
      const take = takes.get(id);
      if (!take) throw Object.assign(new Error('Unknown take'), { status: 404 });
      const result = await fn(take);
      await saveTake(take);
      broadcast('take', take);
      return result;
    });
  }
  function json(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function body(req, limit = 64 * 1024) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readJSON(req) {
    try { return JSON.parse((await body(req)).toString()); }
    catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error('Invalid JSON'), { status: 400 });
    }
  }
  function requireCamera(id) {
    const camera = cameras.get(id);
    if (!camera) throw Object.assign(new Error('Unknown camera'), { status: 404 });
    return camera;
  }
  function requireEntry(take, cameraId) {
    const entry = take.cameras.find(item => item.id === cameraId);
    if (!entry) throw Object.assign(new Error('Camera is not part of this take'), { status: 404 });
    return entry;
  }
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'https://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/time') return json(res, 200, { serverTime: Date.now() });
      if (req.method === 'GET' && p === '/api/config') {
        return json(res, 200, { joinUrl: `https://${lanAddress()}:${req.socket.localPort}/camera` });
      }
      if (req.method === 'GET' && p === '/events') {
        const role = url.searchParams.get('role');
        const id = url.searchParams.get('id');
        if (role !== 'dashboard' && role !== 'camera') return json(res, 400, { error: 'Invalid role' });
        const camera = role === 'camera' ? requireCamera(id) : null;
        if (role === 'dashboard' && (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id))) return json(res, 400, { error: 'Invalid dashboard ID' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (camera) {
          if (camera.response && camera.response !== res) camera.response.end();
          clearTimeout(camera.disconnectTimer);
          camera.response = res;
          updateCamera(camera);
          send(res, 'dashboards', [...dashboards.keys()]);
          for (const take of takes.values()) {
            if (!take.cameras.some(entry => entry.id === camera.id)) continue;
            if (take.id === activeTake) send(res, 'start', { takeId: take.id, startAt: take.startAt });
            else if (take.status === 'uploading') send(res, 'stop', { takeId: take.id, stopAt: take.stopAt });
          }
        } else {
          if (dashboards.has(id)) dashboards.get(id).end();
          dashboards.set(id, res);
          send(res, 'snapshot', { cameras: [...cameras.values()].map(publicCamera), takes: [...takes.values()].reverse(), activeTake });
          for (const cam of cameras.values()) if (cam.response) send(cam.response, 'dashboard-joined', { id });
        }
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          if (camera && camera.response === res) {
            camera.response = null;
            updateCamera(camera);
            camera.disconnectTimer = setTimeout(() => {
              if (!camera.response) {
                const pending = [...takes.values()].some(take => ['recording', 'uploading'].includes(take.status) &&
                  take.cameras.some(entry => entry.id === camera.id && entry.status !== 'complete'));
                if (pending) return;
                cameras.delete(camera.id);
                broadcast('camera-removed', { id: camera.id });
              }
            }, 30000);
            camera.disconnectTimer.unref();
          } else if (!camera && dashboards.get(id) === res) {
            dashboards.delete(id);
            for (const cam of cameras.values()) if (cam.response) send(cam.response, 'dashboard-left', { id });
          }
        });
        return;
      }
      if (req.method === 'POST' && p === '/api/cameras') {
        const data = await readJSON(req);
        const camera = { id: crypto.randomUUID(), name: label(data.name, 'Camera'), device: String(data.device || '').slice(0, 300),
          resolution: String(data.resolution || '').slice(0, 50), status: 'Armed', response: null };
        cameras.set(camera.id, camera);
        updateCamera(camera);
        return json(res, 201, { id: camera.id });
      }
      if (req.method === 'POST' && p === '/api/camera') {
        const data = await readJSON(req);
        const camera = requireCamera(data.id);
        if (data.name !== undefined) camera.name = label(data.name, 'Camera');
        if (data.resolution !== undefined) camera.resolution = String(data.resolution).slice(0, 50);
        if (data.status !== undefined) {
          if (!['Armed', 'Recording', 'Uploading', 'Done', 'Error'].includes(data.status)) fail('Invalid status');
          camera.status = data.status;
        }
        if (data.progress !== undefined) {
          if (!Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100) fail('Invalid progress');
          camera.progress = data.progress;
        }
        updateCamera(camera);
        if (camera.response) send(camera.response, 'camera-updated', publicCamera(camera));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/remove') {
        const data = await readJSON(req);
        const camera = requireCamera(data.id);
        if (activeTake && takes.get(activeTake)?.cameras.some(item => item.id === camera.id)) fail('Cannot remove a camera during a take', 409);
        if (camera.response) { send(camera.response, 'removed', {}); camera.response.end(); }
        clearTimeout(camera.disconnectTimer);
        cameras.delete(camera.id);
        broadcast('camera-removed', { id: camera.id });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/signal') {
        const data = await readJSON(req);
        const camera = requireCamera(data.cameraId);
        if (!dashboards.has(data.dashboardId) || !camera.response) fail('Peer is disconnected', 409);
        if (!['offer', 'answer', 'candidate', 'error'].includes(data.kind)) fail('Invalid signal');
        const message = { cameraId: camera.id, dashboardId: data.dashboardId, kind: data.kind, payload: data.payload };
        if (data.from === 'camera') send(dashboards.get(data.dashboardId), 'signal', message);
        else if (data.from === 'dashboard') send(camera.response, 'signal', message);
        else fail('Invalid sender');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/takes/start') {
        if (activeTake || stopping) fail('A take is already recording', 409);
        const data = await readJSON(req);
        if (activeTake || stopping) fail('A take is already recording', 409);
        const available = [...cameras.values()].filter(c => c.response);
        if (!available.length) fail('Connect at least one camera', 409);
        if (available.some(c => !['Armed', 'Done'].includes(c.status))) fail('All connected cameras must be ready', 409);
        const id = crypto.randomUUID();
        const take = { id, name: label(data.name, 'Untitled take'), createdAt: new Date().toISOString(), startAt: Date.now() + 1500,
          status: 'recording', cameras: available.map(c => ({ id: c.id, name: c.name, device: c.device, resolution: c.resolution, status: 'waiting' })) };
        activeTake = id;
        takes.set(id, take);
        try { await saveTake(take); } catch (error) { activeTake = null; takes.delete(id); throw error; }
        for (const camera of available) {
          camera.status = 'Recording';
          updateCamera(camera);
          send(camera.response, 'start', { takeId: id, startAt: take.startAt });
        }
        broadcast('take', take);
        broadcast('active-take', { id, startAt: take.startAt });
        return json(res, 201, take);
      }
      if (req.method === 'POST' && p === '/api/takes/stop') {
        if (!activeTake || stopping) fail('No take is recording', 409);
        stopping = true;
        const id = activeTake;
        const take = takes.get(id);
        const stopAt = Math.max(Date.now(), take.startAt + 500);
        try { await mutateTake(id, t => { t.status = 'uploading'; t.stopAt = stopAt; }); }
        finally { stopping = false; }
        activeTake = null;
        for (const entry of take.cameras) {
          const camera = cameras.get(entry.id);
          if (camera) {
            camera.status = 'Uploading';
            updateCamera(camera);
            if (camera.response) send(camera.response, 'stop', { takeId: id, stopAt });
          }
        }
        broadcast('active-take', null);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/takes/report') {
        const data = await readJSON(req);
        await mutateTake(data.takeId, take => {
          const entry = requireEntry(take, data.cameraId);
          if (data.actualStartTime !== undefined) {
            if (!Number.isFinite(data.actualStartTime)) fail('Invalid start time');
            entry.actualStartTime = data.actualStartTime;
            entry.status = 'recording';
          }
          if (data.duration !== undefined) {
            if (!Number.isFinite(data.duration) || data.duration < 0) fail('Invalid duration');
            entry.duration = data.duration;
          }
          if (data.error !== undefined) { entry.status = 'error'; entry.error = String(data.error).slice(0, 500); }
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/upload') {
        const takeId = url.searchParams.get('take');
        const cameraId = url.searchParams.get('camera');
        const offset = Number(url.searchParams.get('offset'));
        const total = Number(url.searchParams.get('total'));
        const mime = url.searchParams.get('mime');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total < 1 || offset > total || !TYPES[mime]) fail('Invalid upload parameters');
        const take = takes.get(takeId);
        if (!take) fail('Unknown take', 404);
        const entry = requireEntry(take, cameraId);
        const bytes = await body(req, MAX_CHUNK);
        if (!bytes.length || offset + bytes.length > total) fail('Invalid chunk length');
        await locked(`upload:${takeId}:${cameraId}`, async () => {
          if (entry.uploadTotal !== undefined && (entry.uploadTotal !== total || entry.uploadMime !== mime)) fail('Upload parameters changed', 409);
          if (entry.file && (entry.mimeType !== mime || entry.fileSize !== total)) fail('Upload does not match completed file', 409);
          if (entry.uploadTotal === undefined) {
            await mutateTake(takeId, t => {
              const e = requireEntry(t, cameraId);
              e.uploadTotal = total;
              e.uploadMime = mime;
            });
          }
          const filename = `${safeName(entry.name)}-${entry.id.slice(0, 8)}.${TYPES[mime]}`;
          const target = path.join(takeDir(takeId), filename);
          const part = `${target}.part`;
          const existing = await fsp.stat(entry.file ? target : part).then(s => s.size, e => {
            if (e.code === 'ENOENT') return 0;
            throw e;
          });
          if (offset > existing || (offset < existing && offset + bytes.length > existing)) fail('Unexpected upload offset', 409);
          if (offset < existing) {
            const handle = await fsp.open(entry.file ? target : part, 'r');
            try {
              const previous = Buffer.alloc(bytes.length);
              const read = await handle.read(previous, 0, bytes.length, offset);
              if (read.bytesRead !== bytes.length || !previous.equals(bytes)) fail('Repeated chunk differs from saved data', 409);
            } finally { await handle.close(); }
          }
          if (offset === existing && !entry.file) await fsp.appendFile(part, bytes);
          const received = Math.max(existing, offset + bytes.length);
          if (received === total && !entry.file) {
            await fsp.rename(part, target);
            await mutateTake(takeId, t => {
              const e = requireEntry(t, cameraId);
              e.file = filename; e.mimeType = mime; e.fileSize = total; e.status = 'complete';
              if (t.cameras.every(c => c.status === 'complete')) t.status = 'complete';
            });
          }
          const camera = cameras.get(cameraId);
          if (camera) { camera.progress = Math.round(received / total * 100); updateCamera(camera); }
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/takes') return json(res, 200, [...takes.values()].reverse());
      if (req.method === 'GET' && p.startsWith('/recordings/')) {
        const parts = p.split('/');
        const take = takes.get(parts[2]);
        const entry = take?.cameras.find(c => c.file && c.file === parts[3]);
        if (parts.length !== 4 || !entry) fail('File not found', 404);
        const file = path.join(takeDir(take.id), entry.file);
        const size = (await fsp.stat(file)).size;
        const headers = { 'Content-Type': entry.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
          if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...headers, 'Content-Length': size });
        return fs.createReadStream(file).pipe(res);
      }
      const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/camera': ['camera.html', 'text/html; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'], '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
        '/camera.js': ['camera.js', 'text/javascript; charset=utf-8'], '/common.js': ['common.js', 'text/javascript; charset=utf-8'] };
      if (req.method === 'GET' && staticFiles[p]) {
        const [file, type] = staticFiles[p];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(path.join(ROOT, 'public', file)).pipe(res);
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error(`${req.method} ${req.url}:`, error.message);
      json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  }

  for (const entry of fs.readdirSync(recordingsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const take = JSON.parse(fs.readFileSync(path.join(recordingsDir, entry.name, 'take.json')));
      if (take.id === entry.name && Array.isArray(take.cameras)) {
        if (take.status === 'recording') take.status = 'interrupted';
        takes.set(take.id, take);
      }
    } catch (error) { console.warn(`Could not load take ${entry.name}: ${error.message}`); }
  }
  return { handler, close() {
    if (closed) return;
    closed = true;
    for (const camera of cameras.values()) { clearTimeout(camera.disconnectTimer); camera.response?.end(); }
    for (const response of dashboards.values()) response.end();
  } };
}

if (require.main === module) {
  const address = lanAddress();
  const port = Number(process.env.PORT || 8443);
  const app = createApp();
  const server = https.createServer(certificate(address), app.handler);
  server.listen(port, '0.0.0.0', () => {
    const actualPort = server.address().port;
    console.log(`Dashboard: https://localhost:${actualPort}/`);
    console.log(`Phone join URL: https://${address}:${actualPort}/camera`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close(); server.close(); });
}

module.exports = { createApp, safeName, lanAddress, certificate, MAX_CHUNK };
