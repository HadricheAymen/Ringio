# Ringio Voice Mobile App

React Native phone client for simulated VoIP calls. It registers with `voip-call-server`, receives calls, and exchanges microphone/speaker audio over WebRTC with the caller or Gemini agent. It does not call the Gemini API directly and does not make SIM/PSTN calls.

## Local development

1. Start the call server in `voip-call-server` with `npm start`.
2. Install the native development build when needed with `npm run android`.
3. Run `npm run start:local`. The launcher detects the PC's LAN IPv4 address and configures this app to use the local call server. Keep the phone on the same reachable network and open the Ringio development app.

Use `npm run start:vercel` to bundle the app against the Vercel signaling URL. Set `RINGIO_LAN_IP` before `npm run start:local` if automatic interface selection chooses the wrong network adapter.

Run `npm run lint` for lint validation. For module ownership, call flow, signaling recovery, and media boundaries, see [ARCHITECTURE.md](ARCHITECTURE.md).
