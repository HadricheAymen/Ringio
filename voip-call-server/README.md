# Ringio VoIP Call Server

Standalone call signaling server for the separate `voip-mobile-app`. It does not use or modify the existing SIM gateway or backend.

See [ARCHITECTURE.md](ARCHITECTURE.md) for layer ownership and end-to-end call flow.

## API discovery for agents

`GET /api` returns the service capabilities and transport overview. `GET /api/openapi.json` returns the caller-facing OpenAPI 3.1 contract, including endpoint purposes, request parameters, defaults, effects, responses, and the Socket.IO event contract for live calls. Internal mobile recovery, artifact, and browser-recording routes are kept in the repository's separate internal reference and are not included in this public contract. Discovery remains available if Vercel's Redis state is not configured; stateful API routes still require shared Redis on Vercel.

## Local test

1. In this folder, run `npm install` and then `npm start`.
2. The server listens on port `4100`; mobile apps register as private server endpoints without a user-facing extension.
3. In `voip-mobile-app`, install the native Android development app with `npm run android` if needed, then run `npm run start:local`. The launcher detects the PC's LAN IPv4 and configures the app for the local server; keep the phone on a reachable network.
4. Open `http://<PC-LAN-IP>:4100` on the PC to monitor connected apps, their availability and priority, blocked apps, and queued calls.

The server root is an operations dashboard and does not place calls. External callers and agents continue to create simulated calls through the REST and Socket.IO APIs. Destination numbers are simulation data only: no SIM or PSTN call is made. Socket.IO relays registration, call control, and WebRTC signaling; audio flows directly between call participants.

## Deploy to Vercel

Deploy this directory as the Vercel project root. `api/server.js` exports the Node.js HTTP server, and `vercel.json` routes all requests through it while preserving their paths. The operations dashboard is available at the deployment root; REST and Socket.IO paths stay unchanged. Enable Fluid Compute because Vercel WebSocket support requires it. The mobile app fallback URL and the Gemini Live console's Vercel mode use `https://voip-ringio-prototype.vercel.app`.

The production project uses the free Upstash Redis integration with auto-upgrade disabled. Vercel supplies `REDIS_URL`; the Socket.IO Redis adapter shares app presence and signaling across function instances, while Redis stores endpoint reservations, the FIFO waiting-call queue, call history, media events, and recording metadata. Local runs without `REDIS_URL` use in-memory state. Do not remove the production Redis variable: the Vercel API and Socket.IO endpoints return an error instead of silently using isolated memory if it is missing.

Vercel WebSockets are in beta. This project sets the function duration to 300 seconds, the current Hobby plan maximum; active connections may reconnect at that limit. WebRTC audio flows directly between external caller/agent clients and the phone; the operations dashboard does not join calls or receive media. The Upstash free plan has usage limits; monitor its dashboard, and auto-upgrade is disabled.

## Public API contract

The server exposes a simplified REST API for external systems. The same call model supports either a human caller or an AI agent; the difference is the value of `role` and `mediaSource`, not the core call flow.

### 1) List registered mobile apps

GET `/api/numbers`

Example response:

```json
[
  {
    "status": "online",
    "available": true,
    "lastSeen": "2026-09-30T10:00:00.000Z"
  }
]
```

### 2) List currently available mobile apps

GET `/api/available-numbers`

Example response:

```json
[
  {
    "status": "online"
  }
]
```

### Check whether a call can launch immediately

GET `/api/capacity`

```json
{
  "onlineMachines": 3,
  "availableMachines": 2,
  "busyMachines": 1,
  "queuedCalls": 0,
  "canLaunchCall": true
}
```

`canLaunchCall` is false if there are no idle apps or if existing calls are waiting in the FIFO queue. Poll this endpoint from an external service before requesting a call; call creation can still race with another caller, so handle a `503` from `POST /api/calls` as the final authority.

Mobile apps register over Socket.IO with `participant:register` and `{ "role": "phone" }`. The server returns a private `endpointId`; callers never use that ID as a destination.

The mobile app also registers a persistent installation ID, display name, and platform. Open `/` to view connected apps, their status and priority, and calls waiting in FIFO order. Rename an installation from its dashboard row to tell multiple phones apart. `GET /api/mobile-apps` lists connected apps; `POST /api/mobile-apps/:appId/name` updates its display name; `POST /api/mobile-apps/:appId/priority` moves one up or down; `POST /api/mobile-apps/:appId/block` accepts `{ "blocked": true }` or `{ "blocked": false }`. Blocking leaves the app connected but prevents new calls from being assigned to it; unblocking can dispatch waiting calls. `GET /api/queued-calls` returns the waiting-call snapshot. These management routes are unauthenticated. Preferences persist across reconnects and server instances when Redis is configured.

Socket.IO callers emit `call:start` with a destination `number` and `availabilityPolicy`. If queued, the caller receives `call:queued`; when an app is assigned, it receives `call:outgoing`, and the app receives `call:incoming` with the same simulated number. The app polls `GET /api/endpoints/:endpointId/incoming` as a recovery path.

### 3) Create a call to a simulated destination number

POST `/api/calls`

Human caller payload:

```json
{
  "from": {
    "role": "human",
    "mediaSource": "browser-mic",
    "type": "caller",
    "metadata": {
      "name": "Support Agent"
    }
  },
  "to": {
    "type": "mobile",
    "number": "+15551234567"
  },
  "availabilityPolicy": "reject",
  "recording": {
    "enabled": false,
    "mode": "browser-download",
    "recordBothSides": false,
    "format": "webm",
    "storage": "caller-device"
  },
  "media": {
    "transport": "webrtc",
    "sessionType": "voice",
    "audioCodec": "opus",
    "sampleRate": 48000,
    "live": true
  }
}
```

Use `"queue"` instead of `"reject"` to wait FIFO for an available app. When no app is available, `reject` returns HTTP `503`; `queue` returns a call record with `status: "queued"`. The policy defaults to `reject` if omitted.

AI caller payload:

```json
{
  "from": {
    "role": "agent",
    "mediaSource": "tts",
    "type": "caller",
    "metadata": {
      "name": "AI Sales Agent",
      "model": "mock-ai"
    }
  },
  "to": {
    "type": "mobile",
    "number": "+15551234567"
  },
  "availabilityPolicy": "queue",
  "recording": {
    "enabled": false,
    "mode": "browser-download",
    "recordBothSides": false,
    "format": "webm",
    "storage": "caller-device"
  },
  "media": {
    "transport": "webrtc",
    "sessionType": "voice",
    "audioCodec": "opus",
    "sampleRate": 48000,
    "live": true
  }
}
```

Example response:

```json
{
  "callId": "c1b7b3a0-0d7f-4a70-8b83-4c2fa39d73fd",
  "status": "ringing",
  "dispatchState": "assigned",
  "from": {
    "role": "agent",
    "mediaSource": "tts",
    "type": "caller"
  },
  "to": {
    "type": "mobile",
    "number": "+15551234567"
  },
  "recording": {
    "enabled": false,
    "mode": "browser-download",
    "recordBothSides": false,
    "status": "disabled"
  }
}
```

### 4) Read a call record

GET `/api/calls/:callId`

### 5) Add a media event for AI/generated audio

POST `/api/calls/:callId/media`

Example payload:

```json
{
  "participantId": "mock-ai-agent",
  "role": "agent",
  "mediaSource": "tts",
  "kind": "ai-audio",
  "payload": {
    "text": "Hello, this is the mock AI calling the simulated number."
  }
}
```

Example response:

```json
{
  "id": "d2394f77-4a9d-46ce-a0f0-770f90f12d4b",
  "callId": "c1b7b3a0-0d7f-4a70-8b83-4c2fa39d73fd",
  "participantId": "mock-ai-agent",
  "role": "agent",
  "mediaSource": "tts",
  "kind": "ai-audio",
  "payload": {
    "text": "Hello, this is the mock AI calling the simulated number."
  },
  "createdAt": "2026-09-30T10:00:00.000Z"
}
```

### 6) Read call media events

GET `/api/calls/:callId/media`

### 7) Read recording metadata

GET `/api/calls/:callId/recording`

For a call placed from the bundled browser desk, that desk downloads the mixed WebM audio to the caller PC and posts only metadata to `POST /api/calls/:callId/recording`. The server never receives the audio bytes. REST-only calls do not create recording metadata because they have no browser media participant.

Metadata payload:

```json
{
  "fileName": "ringio-call-c1b7b3a0.webm",
  "mimeType": "audio/webm;codecs=opus",
  "bytes": 204800,
  "durationMs": 32000
}
```

### 8) List all saved recordings

GET `/api/recordings`

## Extension point for an AI caller

Call identity and routing are independent of the media source. Socket.IO callers send `call:start` with a simulated `number` and an `availabilityPolicy` of `reject` or `queue`; the server selects an idle mobile app. The app receives the dialed number in `call:incoming`. REST calls can ring and be queued, but REST by itself is not a live media participant. For live generated audio, use a Socket.IO agent and exchange WebRTC offers, answers, and ICE candidates. Local audio recording is available only when the bundled browser desk participates in the WebRTC call.

## Gemini Live call console

The separate `mock-external-service` directory runs the Gemini Live voice agent and a local-only browser console. The console starts and stops the actual agent process; the browser does not handle call audio or receive provider credentials. The agent dials a simulated number, waits for the mobile app to answer, speaks a Tunisian Derja introduction first, then bridges two-way WebRTC audio to Gemini Live. Transcript entries are sent to the call server, while per-speaker WAV artifacts are written under `mock-external-service/recordings` and their metadata is uploaded to the call server.

Run the console with:

```bash
cd C:\Ringio\mock-external-service
npm start
```

Open `http://127.0.0.1:4200`. Choose the local LAN call server or the Vercel deployment, enter a simulated mobile number, then start the call. Local mode detects the PC's LAN IPv4 address for the agent; set `RINGIO_LAN_IP` when a VPN or multiple adapters require an explicit interface. Keep `GEMINI_API_KEY` and `INTERNAL_AGENT_TOKEN` in the agent's server-side `.env`; they are never sent to the browser. For command-line runs, use `npm run start:agent:local` or `npm run start:agent:vercel` instead.

## Development limits

- Vercel call history and live signaling state use the connected Upstash Redis resource; local development without `REDIS_URL` uses memory. The phone app must stay open in the foreground. There are no persistent accounts, authentication, push-based incoming calls, or public telephone numbers.
- STUN-only ICE is sufficient for basic same-network testing, not reliable internet calling. Configure an authenticated TURN service for calls across restrictive NATs and firewalls.
- LAN HTTP is for local development. Production use requires HTTPS/WSS, authenticated registration and call authorization, rate limits, and TURN credentials that are not embedded in the client.
- `react-native-webrtc` requires a native development build; it does not run in Expo Go. Rebuild the development app after native config or dependency changes.