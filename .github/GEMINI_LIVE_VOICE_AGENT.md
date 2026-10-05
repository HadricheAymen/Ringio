# Gemini Live Voice Agent

## Objective

Implement a real interactive voice call between the VoIP mobile app and Google's Gemini Live model `gemini-3.8-live`, routed through the external agent service. The agent initiates a simulated-number call. After the mobile app answers, Gemini introduces itself first in Tunisian Derja; only after that greeting is played does the agent forward the mobile microphone audio to Gemini. Gemini's speech returns to the same mobile app, and the conversation continues interactively.

This must be an actual call through the project's mobile app and VoIP call server. A standalone Gemini/AI Studio test is not acceptance.

## End-to-End Flow

1. The external agent connects to the VoIP call server as an `agent` and starts a call to a simulated destination number.
2. The call server selects an available app endpoint and notifies the mobile app.
3. The mobile user answers; the external agent and app establish WebRTC media.
4. The external agent opens a server-to-server Gemini Live session and requests a short Tunisian Derja self-introduction.
5. Gemini audio is bridged to the mobile app. Upstream mobile microphone audio is gated until the introduction has completed playback.
6. The service then streams mobile audio to Gemini and returns Gemini's live speech to the mobile app. It captures Gemini input/output transcript events and saves transcript and audio assets.

## Architecture Boundaries

- `voip-call-server`: simulated-number call routing, private mobile endpoint selection, Socket.IO signaling, call lifecycle, Redis call/transcript metadata, and authenticated artifact metadata endpoints as needed.
- `mock-external-service`: long-running agent process, Gemini SDK adapter, WebRTC peer, PCM conversion/media bridge, interruption handling, transcript collection, and durable audio storage adapter.
- `voip-mobile-app`: receive and answer calls, capture microphone audio, play remote Gemini audio, show existing call states, and use configurable STUN/TURN ICE settings.
- Keep the Gemini SDK, WebRTC audio source/sink, call orchestration, and storage behind small replaceable interfaces. Use dependency injection/fakes for tests. Apply SOLID at real ownership boundaries; do not create a generic plugin framework or abstractions without a concrete need.
- Binary audio must not be stored in Redis. Persist it in durable private object/file storage and keep protected metadata/locations with call history.

## Constraints

- Destination numbers are simulated metadata; do not place cellular or PSTN calls.
- Gemini API credentials and TURN credentials must remain server-side and out of mobile/browser bundles.
- The mobile app's audio must be sent to the hosted Gemini service through the external agent. This is expected network egress; do not describe it as local-only audio.
- Mobile and agent may be on different networks. WebRTC requires STUN and a TURN relay fallback for restrictive NAT/firewalls.
- The current Vercel function limit is 60 seconds, and current call-server disconnect handling ends calls. Live call signaling must move to an always-on host for dependable calls beyond that limit. Vercel may remain for static UI if appropriate.
- Gemini Live's current documented audio contract is 16 kHz raw signed PCM input and 24 kHz raw signed PCM output. The model name is `gemini-3.8-live`.
- Arabic is listed as supported; Tunisian Derja is not a separately enumerated locale. A native-speaker quality trial is required before claiming acceptable dialect quality.
- Retain both audio and transcript as requested; protect retrieval and provide authorized deletion/retention controls.
- Do not modify `BackendStateDispatcherLogic/`, `mobile-gateway/`, or `WebInterface/`.

## Progress Snapshot

- Existing VoIP server routes real-looking simulated numbers to available private app endpoints and relays Socket.IO/WebRTC signaling.
- Existing mobile app captures the microphone for WebRTC and has call accept/end UI.
- `.github` brief is newly created to preserve scope and decisions.
- `mock-external-service/package.json` now declares `@google/genai`, `@roamhq/wrtc`, and `socket.io-client`; dependencies are installed locally.
- `mock-external-service/audioPcm.js` contains PCM mixing, resampling, byte conversion, and 10 ms frame chunking.
- `mock-external-service/test/audioPcm.test.js` has five passing PCM tests from its focused run.
- `mock-external-service/geminiLiveSession.js` contains an initial Gemini adapter and `test/geminiLiveSession.test.js` was just added, but its tests have not yet run. The user cancelled the latest test command; resume by running this suite before further implementation.
- `@roamhq/wrtc` peer, `RTCAudioSink`, `RTCAudioSource`, and Gemini SDK imports loaded successfully under the current local Node 26 runtime. Production host/platform compatibility remains to be confirmed.
- No agent call orchestrator, WebRTC media bridge, transcript/audio persistence, TURN configuration, or always-on production deployment has been completed yet.

## Checklist

- [x] Inspect current call, app, and mock service paths.
- [x] Add external agent dependency manifest and install dependencies.
- [x] Add and verify core PCM conversion helpers.
- [ ] Run PCM and Gemini adapter tests; repair failures before adding another layer.
- [ ] Add Gemini Live session adapter tests for greeting, audio input, output chunks, transcript events, errors, interruptions, and close.
- [ ] Add media bridge: WebRTC remote track -> PCM 16 kHz -> Gemini; Gemini PCM 24 kHz -> WebRTC source track.
- [ ] Add agent call orchestration with greeting-first mic gating and proper accept/reject/end cleanup.
- [ ] Add authenticated transcript and recording metadata paths; choose/configure durable private audio storage.
- [ ] Configure mobile and agent ICE with TURN fallback and secure short-lived credentials.
- [ ] Move live call signaling and agent to an always-on host; retain Vercel only for static UI/API where suitable.
- [ ] Extend VoIP integration tests while preserving simulated-number, queue/reject, and signaling behavior.
- [ ] Validate an actual mobile call, greeting-first order, both-way audio, transcript/audio persistence, >60-second duration, and a different-network TURN call.
- [ ] Run VoIP server tests, external-service tests, mobile lint/type/build checks, and the live native-speaker Derja trial.

## Acceptance Criteria

- A call is initiated by the external service and rings the selected mobile app using a simulated number.
- After answer, Gemini audibly introduces itself to that mobile app before mobile speech is forwarded upstream.
- A person speaking on the mobile can have a live Derja conversation with Gemini; Gemini responses are heard on the mobile speaker.
- Input/output transcripts and both audio directions are associated with the call and saved to durable private storage.
- TURN fallback works across separate networks; no SIM/PSTN call is attempted.
- API keys and recordings are not public; access/deletion is authorized.
- A call longer than 60 seconds remains active on the always-on call host.
- The excluded dispatcher/gateway/WebInterface folders remain untouched.
