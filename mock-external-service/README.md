# Ringio Gemini Live Agent

Server-side voice agent for simulated calls to the Ringio mobile app. It introduces itself in Tunisian Derja, then bridges two-way WebRTC audio between the phone and Gemini Live. Transcripts are sent to the call server; private speaker WAV files are written locally.

## Local console

1. Start `voip-call-server` on the development PC.
2. Ensure `.env` contains the server-side Gemini API key and the internal artifact token. Do not put these values in the browser or mobile app.
3. Run `npm start` and open `http://127.0.0.1:4200`.
4. Choose the local network server, enter a simulated mobile number, and start the Gemini call. The phone app must be open and registered.

The console controls the real Node agent process; the browser is not a caller and does not stream a prerecorded WAV. For command-line operation, use `npm run start:agent:local` or `npm run start:agent:vercel`. Local mode discovers the PC's LAN IPv4 automatically; set `RINGIO_LAN_IP` to override interface selection.

Run `npm test` for the agent, audio bridge, provider adapter, and artifact tests. For ownership, lifecycle phases, security boundaries, and data flow, see [ARCHITECTURE.md](ARCHITECTURE.md).
