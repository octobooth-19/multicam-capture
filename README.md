# Multicam Capture

Record a scene from multiple phone cameras, preview every angle on a laptop, and save the original videos locally. No packages or external services are required.

## Run

### Before you start

On the computer that will run the dashboard, install Node.js v18 or newer and make sure OpenSSL is available at `/usr/bin/openssl`. You can check with `node --version` and `/usr/bin/openssl version` in a terminal. No `npm install` is needed.

### Start the app

1. Open a terminal and clone the app branch, then enter the folder:

   ```sh
   git clone --branch octobooth-19-multicam-capture-app https://github.com/octobooth-19/multicam-capture.git
   cd multicam-capture
   ```

2. Start the server:

   ```sh
   npm start
   ```

   Leave this terminal open while using the app. On first run, the server generates a self-signed HTTPS certificate in `.cert/`. The terminal prints a **Dashboard** URL and a **Phone join URL**, for example:

   ```text
   Dashboard: https://localhost:8443/
   Phone join URL: https://192.168.1.10:8443/camera
   ```

   Your phone URL will contain your computer's detected LAN address.

3. Open the printed dashboard URL in a browser on the computer. Accept the self-signed certificate warning if prompted.
4. Connect each phone to the **same Wi-Fi** as the computer. On each phone, open the printed phone join URL (not the `localhost` dashboard URL). Use Safari on iOS or Chrome on Android.
5. Accept the self-signed certificate warning on each phone. Some devices may require you to install and trust the certificate instead of simply accepting the warning. Allow camera and microphone access when prompted.
6. On each phone, enter a camera name, choose the front or back lens and a resolution, and tap **Connect camera**. The dashboard shows each connected camera's live preview.
7. Enter a take name on the dashboard and click **Record**. Click **Stop recording** when finished. Keep the phone pages open while the videos upload.
8. Play or download each angle from **Recent takes** on the dashboard. The original video files and `take.json` are saved on the computer in `recordings/<take-id>/`.

To stop the server, press **Ctrl+C** in its terminal.

### Troubleshooting

- **A phone cannot reach the join URL:** check that both devices are on the same Wi-Fi, that the printed LAN address is reachable, and that the computer's firewall allows the connection. Guest and corporate networks may isolate devices from one another.
- **Camera access is blocked:** use the HTTPS phone join URL, accept or trust its certificate, and allow camera and microphone access in the browser and device settings.
- **Port 8443 is unavailable:** start the server with another port, for example `PORT=8444 npm start`, and use the newly printed URLs.

The certificate includes localhost and the detected LAN IPv4 address. The server regenerates it if the address changes or the certificate expires.

## How it works

The dashboard and phones use server-sent events and HTTP for signaling, and direct LAN WebRTC connections for previews (no STUN/TURN). Each phone records its camera and microphone locally using MediaRecorder, preferring MP4 when supported and otherwise WebM. The requested resolution is a preference; the actual resolution is shown in the dashboard. Preview quality is limited independently of the recording.

Phones estimate their clock offset using the lowest-latency of five server pings. The server schedules each start 1.5 seconds ahead; actual estimated server-time starts and durations in milliseconds are recorded in metadata for editing. This is not frame-accurate genlock; network, browser, and device timing can vary. An audible or visual slate can help align clips.

After stop, each phone uploads in 1 MiB chunks with automatic retries; use **Retry upload** if retries are exhausted. Keep the tab open: recordings awaiting upload live in the phone's browser memory and are lost if it reloads or closes. If a phone disconnects during a take, reconnect promptly; a missing file leaves the take incomplete. The server stores files and `take.json` under `recordings/<take-id>/`. Recordings, metadata, and the certificate are excluded from Git. Existing takes are loaded when the server restarts, but an interrupted recording cannot be resumed after a server restart.

**Use only on a trusted network.** The app has no authentication or encryption beyond its self-signed HTTPS connection; anyone who can reach the server can control cameras and access recordings. Camera and dashboard pages must remain open. Browsers and phones may throttle or stop background tabs; wake lock is requested when available.

## Development

Run `node --test` for the built-in Node.js tests. Source layout: `server.js` serves HTTPS, signaling, and storage; `public/` contains the dashboard, camera page, and shared styles/scripts; `test/` contains integration tests.
# Spiky

Spiky is a multi-cam capture system that can run on your local system

# Author
Name: Khalid Talakshi
GH Handle: @khalid.talakshi
