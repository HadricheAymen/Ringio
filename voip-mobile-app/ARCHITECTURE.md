# VoIP Mobile App Architecture

## Responsibility

The mobile app is the phone-side user interface, registered endpoint, and WebRTC media participant. It receives simulated calls and exchanges audio with the caller/agent. It does not route numbers, connect directly to Gemini, or use the SIM/PSTN.

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Call UI and view state | `App.js` | Displays connection, registration, incoming-call, call, and ready states; collects the call-server address; provides answer, decline, end, and reconnect actions. |
| Signaling client | `App.js` using `socket.io-client` | Connects to the call server, registers with role `phone`, handles call events, and exchanges RTC offer/answer/ICE messages. Polling endpoints recover missed incoming-call or signaling events. |
| WebRTC and device audio | `App.js` using `react-native-webrtc` and `react-native-incall-manager` | Requests microphone access, attaches the local audio track, applies server ICE configuration, accepts the remote track, and lets the user switch between earpiece and speakerphone during a call. |
| Local development launcher | `scripts/start-local.js`, `scripts/lanAddress.js` | Detects the PC's outbound LAN IPv4 address and injects `EXPO_PUBLIC_CALL_SERVER_URL` for the local call server. Set `RINGIO_LAN_IP` to choose an interface explicitly. |
| Native app shell | `app.json`, `index.js`, `android/` | Configures the Expo development build and native microphone/WebRTC capabilities. Native WebRTC requires the installed development build, not Expo Go. |

## Incoming-call flow

1. On launch, `App.js` opens a Socket.IO connection to the selected call server.
2. After the socket connects, the app emits `participant:register` with role `phone`. It becomes an available endpoint only after the server acknowledges registration.
3. The app receives `call:incoming` through Socket.IO and polls its private incoming-call endpoint as a recovery path.
4. On answer, it emits `call:accept`, requests microphone permission, creates an `RTCPeerConnection`, and exchanges the offer, answer, and ICE candidates with the caller through the server.
5. The agent or browser caller sends a remote audio track. The app plays that track through the phone; the local microphone track flows in the opposite direction. The mobile app does not send audio directly to the Gemini API.
6. On end, rejection, or server-side hang-up, the app closes the peer connection and microphone tracks and returns to idle. Its Socket.IO registration remains in place, so it can receive the next call without reconnecting.

```mermaid
sequenceDiagram
    participant App as Mobile app
    participant Server as Call server
    participant Agent as Gemini agent
    App->>Server: Socket.IO connect + participant:register(phone)
    Server-->>App: participant:registered(endpointId)
    Agent->>Server: call:start(simulated number)
    Server-->>App: call:incoming
    App->>Server: call:accept
    Agent->>Server: rtc:offer + rtc:ice
    Server-->>App: rtc:offer + rtc:ice
    App->>Server: rtc:answer + rtc:ice
    Server-->>Agent: rtc:answer + rtc:ice
    Note over Agent,App: WebRTC audio flows directly after signaling completes
    App->>Server: call:end
    Server-->>App: Release reservation; phone stays registered
```

## Connection and recovery behavior

- Normal call completion resets call state and RTC resources but keeps the socket and endpoint registration connected. The UI reports readiness after `participant:registered`.
- Socket.IO transport loss marks the app disconnected. The client reconnects automatically; on the next `connect`, it registers as a phone again.
- If the process is force-closed or backgrounded, this prototype does not provide push-based incoming calls. Keep the app open in the foreground while testing.
- ICE configuration comes from `GET /api/ice-config`; same-network testing can work with STUN, while restrictive or cross-network NATs need an authenticated TURN service.

## Run modes

- Local LAN: `npm run start:local`. The script chooses the PC's LAN IPv4 dynamically and starts Expo in LAN mode.
- Vercel signaling: `npm run start:vercel`. This changes only the call-server URL; it does not change the mobile media architecture or remove Vercel's runtime limits.
- Native install: `npm run android` or a platform-specific Expo development build. The app must be built with the WebRTC native module.
- Checks: `npm run lint`.

## Related services

- Routing, call state, and signaling contract: [VoIP call server](../voip-call-server/ARCHITECTURE.md).
- Gemini provider, orchestration, media conversion, and audio storage: [external voice agent](../mock-external-service/ARCHITECTURE.md).
