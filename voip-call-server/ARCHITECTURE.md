# VoIP Call Server Architecture

## Responsibility

This service owns simulated-number routing, mobile endpoint registration, call lifecycle state, and signaling. It is the coordination layer between callers and the mobile app; it does not generate voice, process microphone audio, or place PSTN/SIM calls.

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| HTTP API boundary | `httpRoutes.js` | Registers REST endpoints, API discovery/OpenAPI routes, and protected artifact handlers. Receives state and lifecycle functions through explicit dependencies. |
| Socket.IO boundary | `server.js` | Registers participants, accepts call-control events, and relays WebRTC descriptions and ICE candidates. |
| Routing and lifecycle | `server.js` | Validates simulated destinations, selects an available endpoint, applies reject/queue policy, reserves phones, advances call state, and releases reservations at end. |
| API contract | `apiContract.js` | Defines the discovery document and OpenAPI 3.1 HTTP/Socket.IO contract separately from runtime handlers. |
| State adapter | `stateStore.js` | Provides one interface over local in-memory maps or Redis for endpoint presence, reservations, queued calls, sessions, call records, transcripts, media metadata, and signals. |
| ICE configuration | `iceConfig.js` | Supplies STUN/TURN settings to RTC participants. The call server does not relay the audio media. |
| Deployment adapter | `api/server.js`, `vercel.json` | Exposes the same Node server through Vercel routes. The local server listens on port `4100`. |

`server.js` composes the Socket.IO transport and routing decisions. `httpRoutes.js` owns HTTP registration. `stateStore.js` owns storage mechanics; it does not decide who should receive a call.

## Main call flow

1. The phone connects over Socket.IO and emits `participant:register` with role `phone`. The server returns a private endpoint ID and keeps endpoint presence refreshed.
2. A caller or agent registers, then emits `call:start` with a simulated destination and an availability policy (`reject` or `queue`).
3. The router reserves an idle phone, records the session, and emits `call:incoming` to that phone and `call:outgoing` to the caller. If no phone is available, the server rejects or queues according to policy.
4. The phone accepts with `call:accept`. Caller and phone exchange `rtc:offer`, `rtc:answer`, and `rtc:ice` through the server. Audio travels directly over WebRTC between the RTC participants.
5. `call:active` marks media as connected. On `call:end`, rejection, or participant disconnect, the server closes the session, clears participant call mappings, releases the phone reservation, and dispatches waiting calls.

```mermaid
sequenceDiagram
    participant Phone as Mobile app
    participant Server as Call server
    participant Agent as Gemini agent
    Phone->>Server: participant:register(phone)
    Agent->>Server: participant:register(agent)
    Agent->>Server: call:start(number, policy)
    Server->>Phone: call:incoming
    Phone->>Server: call:accept
    Agent->>Server: rtc:offer / rtc:ice
    Server->>Phone: rtc:offer / rtc:ice
    Phone->>Server: rtc:answer / rtc:ice
    Server->>Agent: rtc:answer / rtc:ice
    Note over Agent,Phone: WebRTC audio flows directly; signaling stays on the server
    Phone->>Server: call:end (or caller ends)
    Server-->>Phone: call:ended; reservation released
```

## State and persistence

- Local development without `REDIS_URL` uses in-memory state; restarting the server clears it.
- Vercel must use the configured Redis store. Redis shares endpoint presence, reservations, call state, queue order, and signaling across instances.
- Transcripts and call-asset metadata are stored as metadata. Protected transcript and asset-metadata routes require `INTERNAL_AGENT_TOKEN`.
- Audio bytes are not stored in Redis or Vercel. The external agent writes per-speaker WAV files to its configured recordings directory and submits metadata to this service.

## Runtime boundaries

Vercel is useful for API and deployment checks, but its function lifecycle and WebSocket limits make it unsuitable as the authoritative always-on voice runtime. For longer calls, run this server and the external agent on persistent hosts with shared state and reachable WebRTC ICE/TURN configuration. See [the Gemini agent architecture](../mock-external-service/ARCHITECTURE.md) and [the mobile client architecture](../voip-mobile-app/ARCHITECTURE.md).

## Entry points and checks

- Agent discovery: `GET /api` gives the protocol overview; `GET /api/openapi.json` describes REST inputs and Socket.IO events.
- Local: `npm start`; API health: `GET /health`.
- Vercel adapter: `api/server.js` plus `vercel.json`.
- Signaling and routing tests: `test/signaling.test.js`; run `npm test`.
- Public API examples and deployment notes: [README.md](README.md).
