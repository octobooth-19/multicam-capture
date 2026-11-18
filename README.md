# Multicam Capture

Record a scene from multiple phone cameras, preview every angle on a laptop, and save the original videos locally. No packages or external services are required.

## Run

1. Install Node.js (v18 or newer) and ensure `/usr/bin/openssl` is available. Run `npm start` in this folder.
2. Open the dashboard URL printed in the terminal. Open the printed phone join URL on each phone on the **same Wi-Fi**.
3. Accept the self-signed certificate warning on every device. On iOS, use Safari; on Android, use Chrome. Allow camera and microphone access.
4. Name each angle, choose the lens and desired resolution, and tap **Connect camera**. Choose a take name on the dashboard and press **Record**, then **Stop recording**. Keep the phone pages open while they upload. Play or download each angle from Recent takes.

The server creates `.cert/` on first run, with localhost and the detected LAN IPv4 address in the certificate's subject alternative names. It regenerates the certificate if the address changes or it expires. If the printed address is not reachable, check the laptop's network interface and firewall. Set `PORT` to change the default 8443 port. Guest, corporate, and other client-isolated networks can block the connections. A browser may require installing/trusting the certificate on the device rather than merely accepting the warning.

## How it works

The dashboard and phones use server-sent events and HTTP for signaling, and direct LAN WebRTC connections for previews (no STUN/TURN). Each phone records its camera and microphone locally using MediaRecorder, preferring MP4 when supported and otherwise WebM. The requested resolution is a preference; the actual resolution is shown in the dashboard. Preview quality is limited independently of the recording.

Phones estimate their clock offset using the lowest-latency of five server pings. The server schedules each start 1.5 seconds ahead; actual estimated server-time starts and durations in milliseconds are recorded in metadata for editing. This is not frame-accurate genlock; network, browser, and device timing can vary. An audible or visual slate can help align clips.

After stop, each phone uploads in 1 MiB chunks with automatic retries; use **Retry upload** if retries are exhausted. Keep the tab open: recordings awaiting upload live in the phone's browser memory and are lost if it reloads or closes. If a phone disconnects during a take, reconnect promptly; a missing file leaves the take incomplete. The server stores files and `take.json` under `recordings/<take-id>/`. Recordings, metadata, and the certificate are excluded from Git. Existing takes are loaded when the server restarts, but an interrupted recording cannot be resumed after a server restart.

**Use only on a trusted network.** The app has no authentication or encryption beyond its self-signed HTTPS connection; anyone who can reach the server can control cameras and access recordings. Camera and dashboard pages must remain open. Browsers and phones may throttle or stop background tabs; wake lock is requested when available.

## Development

Run `node --test` for the built-in Node.js tests. Source layout: `server.js` serves HTTPS, signaling, and storage; `public/` contains the dashboard, camera page, and shared styles/scripts; `test/` contains integration tests.
