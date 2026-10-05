# Internal HTTP Route Reference

This file describes HTTP routes intentionally omitted from `GET /api/openapi.json`. It is repository documentation only and is not served by the call server.

**Important:** omission from OpenAPI is not access control. These routes remain registered and their current authentication behavior is unchanged. Do not treat a hidden route name or UUID as authorization.

## Mobile Recovery

### `GET /api/endpoints/{endpointId}/incoming`

- **Consumer:** Registered mobile app.
- **Purpose:** Recovery poll for a ringing incoming call if the Socket.IO event was missed.
- **Path parameter:** `endpointId`, the private endpoint ID returned by `participant:registered` when the phone registers.
- **Response:** `{ "call": null }` when idle, otherwise an incoming-call object containing `callId`, simulated `number`, `caller`, and recording metadata.
- **Current access:** No HTTP authentication middleware. Endpoint IDs are opaque, not credentials.

### `GET /api/calls/{callId}/signals/{recipient}?offset={offset}`

- **Consumers:** Mobile app and caller/agent signaling recovery code.
- **Purpose:** Poll missed `rtc:offer`, `rtc:answer`, or `rtc:ice` events. Socket.IO is the primary signaling path.
- **Path parameters:** `callId` (call UUID); `recipient` (`caller` or `phone`).
- **Query parameter:** `offset` (zero-based integer; defaults to zero). Use the response's `nextOffset` on the next poll.
- **Response:** `{ "events": [...], "nextOffset": number }`.
- **Current access:** No HTTP authentication middleware.

## Agent Artifacts

### `GET /api/calls/{callId}/transcripts`

- **Consumer:** Internal agent/service tooling.
- **Purpose:** Read ordered transcript entries for a call.
- **Path parameter:** `callId` (call UUID).
- **Response:** Transcript entries with speaker, text, timestamp, provider, and sequence.
- **Current access:** Requires `Authorization: Bearer <INTERNAL_AGENT_TOKEN>`.

### `POST /api/calls/{callId}/transcripts`

- **Consumer:** Gemini Live agent.
- **Purpose:** Append a transcript entry.
- **Path parameter:** `callId` (call UUID).
- **JSON body:** `speaker` (`agent` or `mobile`) and nonblank `text` (up to 10,000 characters); optional `timestamp` (ISO date-time). Invalid or missing timestamps use server time.
- **Response:** Created entry `id` and sequence number.
- **Current access:** Requires `Authorization: Bearer <INTERNAL_AGENT_TOKEN>`.

### `GET /api/calls/{callId}/assets`

- **Consumer:** Internal agent/service tooling.
- **Purpose:** Read metadata for privately stored per-speaker WAV assets; audio bytes are not returned.
- **Path parameter:** `callId` (call UUID).
- **Response:** Asset metadata array.
- **Current access:** Requires `Authorization: Bearer <INTERNAL_AGENT_TOKEN>`.

### `POST /api/calls/{callId}/assets`

- **Consumer:** Gemini Live agent.
- **Purpose:** Store metadata for private WAV files already written by the agent service.
- **Path parameter:** `callId` (call UUID).
- **JSON body:** `assets` array with at most two entries. Each entry uses speaker `agent` or `mobile`, filename `<speaker>.wav`, content type `audio/wav`, byte count at least 44, and nonnegative duration; sample rate and channel count are optional.
- **Response:** Accepted metadata count.
- **Current access:** Requires `Authorization: Bearer <INTERNAL_AGENT_TOKEN>`.

## Diagnostics and Browser Recording Metadata

### `GET /api/calls/{callId}/media`

- **Consumer:** Internal diagnostics.
- **Purpose:** Read JSON media metadata events. This endpoint does not return audio bytes.
- **Path parameter:** `callId` (call UUID).
- **Current access:** No HTTP authentication middleware.

### `POST /api/calls/{callId}/media`

- **Consumer:** Internal diagnostic/media integrations.
- **Purpose:** Append a media event to the call record. Optional body fields are `participantId`, `role`, `mediaSource`, `kind`, and `payload`; `kind: "ai-audio"` also updates the call's AI-audio summary. This is metadata only, not an audio upload.
- **Path parameter:** `callId` (call UUID).
- **Current access:** No HTTP authentication middleware.

### `GET /api/calls`

- **Consumer:** Internal operator/diagnostic tools.
- **Purpose:** List call records currently available in the state store.
- **Parameters:** None; currently not paginated.
- **Current access:** No HTTP authentication middleware.

### `GET /api/calls/{callId}/recording`

- **Consumer:** Built-in browser call desk.
- **Purpose:** Read browser recording metadata; it does not return audio bytes.
- **Path parameter:** `callId` (call UUID).
- **Current access:** No HTTP authentication middleware.

### `POST /api/calls/{callId}/recording`

- **Consumer:** Built-in browser call desk.
- **Purpose:** Mark an existing caller-device recording as downloaded and store filename, MIME type, byte count, and duration.
- **Path parameter:** `callId` (call UUID).
- **JSON body:** Optional `fileName`, `mimeType`, `bytes`, and `durationMs`.
- **Current access:** No HTTP authentication middleware.

### `GET /api/recordings`

- **Consumer:** Internal operator/diagnostic tools.
- **Purpose:** List recording metadata. It does not return audio bytes.
- **Parameters:** None.
- **Current access:** No HTTP authentication middleware.
