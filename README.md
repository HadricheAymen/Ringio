# Ringio

Ringio is an app-only simulated VoIP calling prototype. A Node.js signaling server routes **simulated** destination numbers to a registered React Native mobile app, and callers — a browser call desk or an external voice agent — exchange live audio directly with the phone over WebRTC. Socket.IO carries registration, call control, and signaling; audio never flows through the server.

Destination numbers are simulation data only. Ringio does not use a SIM, the PSTN, or real phone numbers.

## Repository layout

| Folder | Role |
| --- | --- |
| [`voip-call-server/`](voip-call-server/) | Standalone call signaling server (Express + Socket.IO). Owns endpoint registration, simulated-number routing, call lifecycle, FIFO queue, and the REST / Socket.IO contract. Serves the browser call desk at its root. Listens on port `4100`. Optional Vercel deployment with Upstash Redis. |
| [`voip-mobile-app/`](voip-mobile-app/) | React Native (Expo development build) phone client. Registers as an endpoint, receives calls, and exchanges microphone/speaker audio over WebRTC. |
| [`mock-external-service/`](mock-external-service/) | Reference **consumer** of Ringio's public interface (see note below): a server-side Gemini Live voice agent plus a local operator console on port `4200`. |

> **Note on `mock-external-service`:** it is *just an interface consumer* — a stand-in for any external system that calls the Ringio API. It is **not part of Ringio's core** (the call server and mobile app have no dependency on it), and it is **irrelevant to Ordely**. Any consumer-side integration code inside it (for example the Ordely callback client) belongs to that consumer and can be ignored, replaced, or deleted without affecting Ringio.

## Requirements

- Node.js 22 or newer (the mock agent requires `>=22 <27`)
- npm
- An Android phone with USB debugging enabled, on the same LAN as the PC
- Android SDK with `adb` available (for the one-time native build of the mobile app)

## Launch the VoIP call server

```bash
cd voip-call-server
npm install
cp .env.example .env   # then edit .env (see "Environment files" below)
npm start
```

- The server listens on **port 4100**. Check `GET /health` once it is up.
- Local runs keep state in memory; no Redis is required. Set `REDIS_URL` only if you want shared state.
- API discovery for external consumers: `GET /api` and `GET /api/openapi.json`.
- Run the test suite with `npm test`.

## Launch the mobile app

The app uses `react-native-webrtc`, which requires a **native development build** — it does not run in Expo Go.

1. Start the call server first (see above).
2. Build and install the native development app on the phone (first time only, phone connected via USB):

   ```bash
   cd voip-mobile-app
   npm install
   npm run android
   ```

3. Start the app against the local server:

   ```bash
   npm run start:local
   ```

   The launcher detects the PC's LAN IPv4 address and configures the app to use the local call server. Set `RINGIO_LAN_IP` first if automatic interface selection picks the wrong adapter (VPN, multiple NICs). Keep the phone on the same reachable network and the app open in the foreground.
4. Alternatively, `npm run start:vercel` bundles the app against the Vercel signaling deployment.

Run `npm run lint` for lint validation.

## Place a call

**Human caller (browser call desk):** open `http://<PC-LAN-IP>:4100` in a desktop browser, allow microphone access, enter a simulated destination number (for example `+15551234567`), choose whether to reject or queue when no app is available, then answer on the phone. Audio flows directly between browser and phone over WebRTC; the desk can download a mixed WebM recording locally.

**AI caller (mock external service, optional):** start the mock service console and let the Gemini Live agent place the call:

```bash
cd mock-external-service
npm install
cp .env.example .env   # then edit .env (needs a Gemini API key)
npm start              # open http://127.0.0.1:4200
```

Choose the local call server (or the Vercel deployment), enter a simulated number, and start the call. The agent introduces itself in Tunisian Derja, then bridges two-way audio between the phone and Gemini Live, posts transcripts to the call server, and writes per-speaker WAV artifacts under `mock-external-service/recordings/`. For headless runs use `npm run start:agent:local` or `npm run start:agent:vercel`.

Any other external system can place calls the same way using the public contract documented in [`voip-call-server/README.md`](voip-call-server/README.md) — that is exactly what the mock service demonstrates.

## Environment files

**The real `.env` files are not committed.** They contain live credentials and are excluded via `.gitignore`. Instead, each service ships a sanitized copy named **`.env.example`** — placeholder values only, safe for GitHub (it passes secret scanning because it contains no real credentials).

Set up your local environment by copying the example and filling in real values:

```bash
# voip-call-server/.env
INTERNAL_AGENT_TOKEN=<random string>        # shared secret for protected artifact/transcript routes

# mock-external-service/.env
GEMINI_API_KEY=<your Google AI Studio key>
CALL_SERVER_URL=http://<your-PC-LAN-IP>:4100
SIMULATED_DESTINATION_NUMBER=+15550001234
INTERNAL_AGENT_TOKEN=<must match voip-call-server/.env>
```

Because this repository is public: never commit real keys, and rotate any credential that was ever pushed.

## Tests and checks

| Service | Command |
| --- | --- |
| `voip-call-server` | `npm test` (signaling and routing), `npm start` + `GET /health` |
| `voip-mobile-app` | `npm run lint` |
| `mock-external-service` | `npm test` (agent lifecycle, audio bridge, provider adapter, artifacts) |

## Documentation

- [`voip-call-server/ARCHITECTURE.md`](voip-call-server/ARCHITECTURE.md) — layer ownership, call flow, state, deployment adapter
- [`voip-call-server/INTERNAL_API.md`](voip-call-server/INTERNAL_API.md) — internal mobile recovery / artifact routes
- [`voip-mobile-app/ARCHITECTURE.md`](voip-mobile-app/ARCHITECTURE.md) — app layers, incoming-call flow, run modes
- [`mock-external-service/ARCHITECTURE.md`](mock-external-service/ARCHITECTURE.md) — agent orchestration, trust boundaries, data flow

## Development limits

- Prototype scope: no accounts, authentication, push-based incoming calls, or public telephone numbers. The phone app must stay in the foreground.
- STUN-only ICE works for same-network testing; restrictive NATs/firewalls need an authenticated TURN service.
- LAN HTTP is for local development only. Production use requires HTTPS/WSS, authenticated registration, call authorization, and rate limits.
- The Vercel deployment uses WebSockets in beta with a 60-second function duration limit; long conversations belong on persistent hosts.
