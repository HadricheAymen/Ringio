const VERSION = '1.0.0';
const jsonResponse = (description, schema) => ({
  description,
  content: { 'application/json': { schema } },
});
const jsonBody = (schema, example) => ({
  required: true,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (name) => ({ $ref: `#/components/responses/${name}` });
const callId = {
  name: 'callId',
  in: 'path',
  required: true,
  description: 'Call UUID returned by a call-create response or Socket.IO call event.',
  schema: { type: 'string', format: 'uuid' },
};

const discoveryDocument = {
  schemaVersion: '1.0',
  service: {
    id: 'ringio-voip-call-server',
    name: 'Ringio VoIP Call Server',
    version: VERSION,
    description: 'Routes simulated calls to registered mobile apps and relays Socket.IO WebRTC signaling. It does not place PSTN calls or relay audio media.',
  },
  specifications: {
    openapi: {
      version: '3.1.0',
      url: '/api/openapi.json',
      description: 'Machine-readable HTTP endpoint, parameter, response, and Socket.IO contract.',
    },
  },
  transports: {
    http: { basePath: '/', contentType: 'application/json' },
    socketIo: {
      path: '/socket.io',
      namespace: '/',
      description: 'Participant registration, call lifecycle, and WebRTC signaling. Audio flows directly between WebRTC participants.',
      clientEvents: {
        'participant:register': {
          payload: { role: 'phone | caller | agent', mediaSource: 'optional string' },
          effect: 'Registers the socket. A phone receives a private endpointId; callers and agents can place outbound calls.',
        },
        'call:start': {
          payload: { number: 'simulated destination number', availabilityPolicy: 'reject | queue (default reject)' },
          roles: ['caller', 'agent'],
          effect: 'Reserves and rings an idle phone, rejects when none is idle, or queues FIFO.',
        },
        'call:accept': { roles: ['phone'], payload: { callId: 'UUID' }, effect: 'Accepts a ringing call and enables RTC signaling.' },
        'call:reject': { roles: ['phone'], payload: { callId: 'UUID' }, effect: 'Rejects a ringing call and releases its phone reservation.' },
        'call:reconnect': { roles: ['phone', 'caller', 'agent'], payload: { callId: 'UUID', role: 'phone | caller | agent' }, effect: 'Re-associates a reconnected socket with an active or connecting call.' },
        'call:end': { roles: ['current call participants'], payload: { callId: 'UUID' }, effect: 'Ends the call and releases its phone reservation.' },
        'rtc:offer | rtc:answer | rtc:ice': { payload: { callId: 'UUID', description: 'RTCSessionDescription or RTCIceCandidate' }, effect: 'Relays WebRTC signaling to the other participant after acceptance.' },
        'call:active': { roles: ['caller', 'agent'], payload: { callId: 'UUID' }, effect: 'Marks the media connection active.' },
        'directory:watch': { payload: {}, effect: 'Requests a snapshot of online and available phone counts.' },
      },
      serverEvents: {
        'participant:registered': 'Registration acknowledgement; phone role includes endpointId.',
        'call:reconnected': 'Acknowledgement that a reconnected socket has been re-associated with the call session.',
        'call:incoming': 'Incoming simulated call delivered to a phone.',
        'call:outgoing': 'Call assignment delivered to a socket caller or agent.',
        'call:queued': 'Call is waiting for an available phone.',
        'call:accepted | call:rejected | call:ended | call:active': 'Call lifecycle updates.',
        'rtc:offer | rtc:answer | rtc:ice': 'Relayed WebRTC signaling.',
        'call:error': 'Structured call-control or signaling error.',
        'directory:snapshot | directory:changed': 'Phone availability updates.',
      },
    },
  },
  semantics: {
    destinationNumber: 'Simulation data only; no SIM or PSTN call is made.',
    availabilityPolicy: {
      reject: 'Return 503 when no phone is idle.',
      queue: 'Keep the call in FIFO order until a phone becomes available.',
    },
    media: 'Socket.IO relays call control and RTC signaling. WebRTC audio is peer-to-peer between the caller/agent and mobile.',
    recordings: 'Browser call-desk recordings remain on the caller device. Gemini agent WAV files are stored by the agent service; this server stores only their metadata.',
  },
  security: {
    secretHandling: 'Never send Gemini API keys or server-side credentials to a mobile or browser client.',
  },
};

const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Ringio VoIP Call Server API',
    version: VERSION,
    summary: 'Caller-facing simulated-number routing and call management endpoints.',
    description: 'No endpoint places a telephone/PSTN call. For live calls, connect with Socket.IO as caller or agent and use x-socketio-contract. REST-created calls can ring or queue a phone but do not provide a live caller media socket.',
  },
  servers: [{ url: '/', description: 'Resolve relative paths against the current server origin.' }],
  tags: [
    { name: 'Discovery', description: 'Machine-readable API and transport contract.' },
    { name: 'Health', description: 'Server and WebRTC network configuration.' },
    { name: 'Phones', description: 'Registered mobile endpoint availability and incoming-call recovery.' },
    { name: 'Calls', description: 'Create, inspect, and end simulated calls.' },
    { name: 'Signaling', description: 'Poll RTC events when Socket.IO delivery was missed.' },
    { name: 'Artifacts', description: 'Transcript, audio-asset, and browser recording metadata.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        operationId: 'getHealth',
        summary: 'Get server health',
        description: 'Returns state backend, online mobile count, waiting queue size, and active call count. Local development without Redis reports local-memory; Vercel should report redis.',
        responses: {
          '200': jsonResponse('Health snapshot.', {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded'] },
              sharedState: { type: 'string', enum: ['redis', 'local-memory'] },
              mobileAppsOnline: { type: 'integer' },
              queuedCalls: { type: 'integer' },
              activeCalls: { type: 'integer' },
            },
          }),
        },
      },
    },
    '/api': {
      get: {
        tags: ['Discovery'],
        operationId: 'discoverApi',
        summary: 'Discover available protocols and API schema',
        description: 'Returns the OpenAPI URL, Socket.IO path/events, simulation semantics, and security notes.',
        responses: { '200': jsonResponse('API discovery document.', { type: 'object' }) },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['Discovery'],
        operationId: 'getOpenApiDocument',
        summary: 'Get the complete OpenAPI contract',
        description: 'Documents HTTP paths, parameters, defaults, effects, responses, and the Socket.IO event contract extension.',
        responses: { '200': jsonResponse('OpenAPI 3.1 document.', { type: 'object' }) },
      },
    },
    '/api/ice-config': {
      get: {
        tags: ['Health'],
        operationId: 'getIceConfig',
        summary: 'Get WebRTC ICE servers',
        description: 'Returns STUN/TURN server configuration for the mobile and external agent. Credentials, when configured, are time-limited by the ICE provider.',
        responses: {
          '200': jsonResponse('ICE configuration.', {
            type: 'object',
            required: ['iceServers'],
            properties: {
              iceServers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    urls: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                    username: { type: 'string' },
                    credential: { type: 'string' },
                  },
                },
              },
              expiresAt: { type: ['string', 'null'], format: 'date-time' },
            },
          }),
          '503': errorResponse('ServiceUnavailable'),
        },
      },
    },
    '/api/numbers': {
      get: {
        tags: ['Phones'],
        operationId: 'listPhones',
        summary: 'List registered phones',
        description: 'Returns one status snapshot per connected app endpoint. These are app endpoints, not public telephone numbers; private endpoint IDs are intentionally omitted.',
        responses: {
          '200': jsonResponse('Registered endpoint snapshots.', { type: 'array', items: schemaRef('PhoneSnapshot') }),
        },
      },
    },
    '/api/available-numbers': {
      get: {
        tags: ['Phones'],
        operationId: 'listAvailablePhones',
        summary: 'List available phone capacity',
        description: 'Returns one `{status: "online"}` entry per idle app. Entries represent available app capacity, not dialable numbers.',
        responses: {
          '200': jsonResponse('Available endpoint snapshots.', {
            type: 'array',
            items: { type: 'object', properties: { status: { type: 'string', const: 'online' } } },
          }),
        },
      },
    },
    '/api/capacity': {
      get: {
        tags: ['Phones'],
        operationId: 'getCallCapacity',
        summary: 'Check whether a call can launch immediately',
        description: 'Returns online, idle, and busy mobile-app capacity plus the waiting queue size. canLaunchCall is false while queued calls have priority.',
        responses: {
          '200': jsonResponse('Current call routing capacity.', {
            type: 'object',
            required: ['onlineMachines', 'availableMachines', 'busyMachines', 'queuedCalls', 'canLaunchCall'],
            properties: {
              onlineMachines: { type: 'integer', minimum: 0 },
              availableMachines: { type: 'integer', minimum: 0 },
              busyMachines: { type: 'integer', minimum: 0 },
              queuedCalls: { type: 'integer', minimum: 0 },
              canLaunchCall: { type: 'boolean' },
            },
          }),
        },
      },
    },
    '/api/endpoints/{endpointId}/incoming': {
      get: {
        tags: ['Phones'],
        operationId: 'getIncomingCall',
        summary: 'Poll a phone endpoint for its ringing call',
        description: 'Recovery path for the registered phone app. Returns `{call: null}` when no call is ringing.',
        parameters: [{
          name: 'endpointId',
          in: 'path',
          required: true,
          description: 'Private ID returned by `participant:registered` for role `phone`.',
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: {
          '200': jsonResponse('Incoming call or null.', {
            type: 'object',
            properties: { call: { oneOf: [schemaRef('IncomingCall'), { type: 'null' }] } },
          }),
        },
      },
    },
    '/api/calls': {
      get: {
        tags: ['Calls'],
        operationId: 'listCalls',
        summary: 'List call records',
        description: 'Returns call records visible to the current state store. This endpoint currently has no pagination.',
        responses: { '200': jsonResponse('Call record array.', { type: 'array', items: schemaRef('CallRecord') }) },
      },
      post: {
        tags: ['Calls'],
        operationId: 'createCall',
        summary: 'Create a simulated outbound call',
        description: 'Reserves and rings an idle phone, or applies the availability policy. REST creation does not create a live caller socket; use Socket.IO registration and call:start for a live browser/agent WebRTC caller.',
        requestBody: jsonBody(schemaRef('CreateCallRequest'), {
          from: { role: 'agent', mediaSource: 'gemini-live', type: 'caller' },
          to: { type: 'mobile', number: '+15551234567' },
          availabilityPolicy: 'queue',
          media: { transport: 'webrtc', sessionType: 'voice', audioCodec: 'opus', sampleRate: 48000, live: true },
        }),
        responses: {
          '201': jsonResponse('Created call record; ringing if assigned, queued if waiting.', schemaRef('CallRecord')),
          '400': errorResponse('BadRequest'),
          '409': jsonResponse('Socket caller already has an active call.', schemaRef('ApiError')),
          '503': jsonResponse('No phone available and availabilityPolicy is reject.', schemaRef('ApiError')),
        },
      },
    },
    '/api/calls/{callId}': {
      get: {
        tags: ['Calls'],
        operationId: 'getCall',
        summary: 'Get one call record',
        description: 'Returns routing, participant, media, recording metadata, and lifecycle timestamps.',
        parameters: [callId],
        responses: {
          '200': jsonResponse('Call record.', schemaRef('CallRecord')),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/end': {
      post: {
        tags: ['Calls'],
        operationId: 'endCall',
        summary: 'End a call by its ID',
        description: 'Ends the session, notifies its other socket participant, releases the phone reservation, and dispatches queued calls. Optional socketId suppresses call:ended for that socket.',
        parameters: [callId],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { socketId: { type: 'string' } } } } },
        },
        responses: {
          '200': jsonResponse('Call ended.', { type: 'object', properties: { success: { type: 'boolean' }, callId: { type: 'string' }, status: { type: 'string', const: 'ended' } } }),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/signals/{recipient}': {
      get: {
        tags: ['Signaling'],
        operationId: 'pollSignals',
        summary: 'Poll missed WebRTC signaling events',
        description: 'Socket.IO recovery path. Pass nextOffset from the previous response to avoid replaying earlier events.',
        parameters: [
          callId,
          { name: 'recipient', in: 'path', required: true, description: 'Which side receives the events.', schema: { type: 'string', enum: ['caller', 'phone'] } },
          { name: 'offset', in: 'query', required: false, description: 'Zero-based event offset; use previous nextOffset.', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': jsonResponse('Signaling events and next offset.', {
            type: 'object',
            properties: {
              events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, eventName: { type: 'string', enum: ['rtc:offer', 'rtc:answer', 'rtc:ice'] }, payload: { type: 'object' }, createdAt: { type: 'string', format: 'date-time' } } } },
              nextOffset: { type: 'integer' },
            },
          }),
          '400': errorResponse('BadRequest'),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/media': {
      get: {
        tags: ['Artifacts'],
        operationId: 'listMediaEvents',
        summary: 'List media metadata events',
        description: 'Returns JSON media events, not audio bytes.',
        parameters: [callId],
        responses: { '200': jsonResponse('Media event array.', { type: 'array', items: { type: 'object' } }) },
      },
      post: {
        tags: ['Artifacts'],
        operationId: 'createMediaEvent',
        summary: 'Add a media metadata event',
        description: 'Appends a JSON event. kind=ai-audio updates the call record AI audio summary. No binary audio is uploaded and this route does not require the internal token.',
        parameters: [callId],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            participantId: { type: 'string' },
            role: { type: 'string', enum: ['agent', 'mobile'] },
            mediaSource: { type: 'string' },
            kind: { type: 'string', default: 'ai-audio' },
            payload: { type: 'object' },
          },
        }),
        responses: {
          '201': jsonResponse('Created media event.', { type: 'object' }),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/transcripts': {
      get: {
        tags: ['Artifacts'],
        operationId: 'listTranscripts',
        summary: 'Read transcript entries',
        description: 'Returns ordered entries. Requires the server-side internal agent bearer token.',
        security: [{ InternalAgentToken: [] }],
        parameters: [callId],
        responses: {
          '200': jsonResponse('Transcript array.', { type: 'array', items: schemaRef('TranscriptEntry') }),
          '401': errorResponse('Unauthorized'),
          '404': errorResponse('NotFound'),
          '503': errorResponse('ServiceUnavailable'),
        },
      },
      post: {
        tags: ['Artifacts'],
        operationId: 'appendTranscript',
        summary: 'Append a transcript entry',
        description: 'Stores an agent or mobile utterance. The server sets provider and sequence. Requires the internal agent bearer token.',
        security: [{ InternalAgentToken: [] }],
        parameters: [callId],
        requestBody: jsonBody({
          type: 'object',
          required: ['speaker', 'text'],
          properties: {
            speaker: { type: 'string', enum: ['agent', 'mobile'] },
            text: { type: 'string', minLength: 1, maxLength: 10000 },
            timestamp: { type: 'string', format: 'date-time', description: 'Optional event time; invalid or missing values default to server time.' },
          },
        }),
        responses: {
          '201': jsonResponse('Transcript ID and sequence.', { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, sequence: { type: 'integer' } } }),
          '400': errorResponse('BadRequest'),
          '401': errorResponse('Unauthorized'),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/assets': {
      get: {
        tags: ['Artifacts'],
        operationId: 'getAudioAssets',
        summary: 'Read private audio asset metadata',
        description: 'Returns per-speaker WAV metadata only. Audio bytes remain in the agent private recordings directory. Requires the internal agent bearer token.',
        security: [{ InternalAgentToken: [] }],
        parameters: [callId],
        responses: {
          '200': jsonResponse('Audio asset metadata.', { type: 'array', items: schemaRef('AudioAsset') }),
          '401': errorResponse('Unauthorized'),
          '404': errorResponse('NotFound'),
        },
      },
      post: {
        tags: ['Artifacts'],
        operationId: 'saveAudioAssetMetadata',
        summary: 'Save private audio asset metadata',
        description: 'Stores at most two WAV metadata records, one per speaker; binary audio is not uploaded. Requires the internal agent bearer token.',
        security: [{ InternalAgentToken: [] }],
        parameters: [callId],
        requestBody: jsonBody({
          type: 'object',
          required: ['assets'],
          properties: { assets: { type: 'array', maxItems: 2, items: schemaRef('AudioAssetInput') } },
        }),
        responses: {
          '201': jsonResponse('Accepted metadata count.', { type: 'object', properties: { count: { type: 'integer' } } }),
          '400': errorResponse('BadRequest'),
          '401': errorResponse('Unauthorized'),
          '404': errorResponse('NotFound'),
        },
      },
    },
    '/api/calls/{callId}/recording': {
      get: {
        tags: ['Artifacts'],
        operationId: 'getBrowserRecordingMetadata',
        summary: 'Read browser recording metadata',
        description: 'Returns metadata created by the built-in browser call desk; it does not return audio bytes.',
        parameters: [callId],
        responses: { '200': jsonResponse('Recording metadata.', { type: 'object' }), '404': errorResponse('NotFound') },
      },
      post: {
        tags: ['Artifacts'],
        operationId: 'markBrowserRecordingDownloaded',
        summary: 'Record browser download metadata',
        description: 'Marks an existing browser recording as downloaded and stores filename, MIME type, byte count, and duration. It does not accept audio bytes.',
        parameters: [callId],
        requestBody: jsonBody({
          type: 'object',
          properties: { fileName: { type: 'string' }, mimeType: { type: 'string' }, bytes: { type: 'integer', minimum: 0 }, durationMs: { type: 'number', minimum: 0 } },
        }),
        responses: {
          '200': jsonResponse('Updated recording metadata.', { type: 'object' }),
          '404': errorResponse('NotFound'),
          '409': jsonResponse('Call has no browser recording.', schemaRef('ApiError')),
        },
      },
    },
    '/api/recordings': {
      get: {
        tags: ['Artifacts'],
        operationId: 'listRecordings',
        summary: 'List recording metadata',
        description: 'Returns recording metadata records; audio bytes are not served.',
        responses: { '200': jsonResponse('Recording metadata array.', { type: 'array', items: { type: 'object' } }) },
      },
    },
  },
  components: {
    securitySchemes: {
      InternalAgentToken: { type: 'http', scheme: 'bearer', description: 'Server-side INTERNAL_AGENT_TOKEN. Never expose it to browser or mobile clients.' },
    },
    responses: {
      BadRequest: jsonResponse('Input is missing, malformed, or outside documented constraints.', schemaRef('ApiError')),
      Unauthorized: jsonResponse('Missing or invalid internal agent bearer token.', schemaRef('ApiError')),
      NotFound: jsonResponse('Call or endpoint was not found.', schemaRef('ApiError')),
      ServiceUnavailable: jsonResponse('Required server configuration or dependency is unavailable.', schemaRef('ApiError')),
    },
    schemas: {
      ApiError: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } },
      PhoneSnapshot: {
        type: 'object',
        required: ['status', 'available'],
        properties: {
          status: { type: 'string', enum: ['online', 'busy'] },
          available: { type: 'boolean', description: 'Whether this app endpoint can be reserved now.' },
          lastSeen: { type: 'string', format: 'date-time' },
        },
      },
      IncomingCall: {
        type: 'object',
        required: ['callId', 'number', 'caller'],
        properties: { callId: { type: 'string', format: 'uuid' }, number: { type: 'string' }, caller: { type: 'string' }, recording: { type: 'object' } },
      },
      CreateCallRequest: {
        type: 'object',
        required: ['to'],
        properties: {
          from: {
            type: 'object',
            description: 'Optional call identity metadata; these labels do not create an RTC participant.',
            properties: {
              role: { type: 'string', enum: ['agent', 'caller', 'service'], default: 'service' },
              mediaSource: { type: 'string' },
              type: { type: 'string', default: 'caller' },
              metadata: { type: 'object' },
            },
          },
          to: {
            type: 'object',
            required: ['number'],
            properties: {
              type: { type: 'string', default: 'mobile' },
              number: { type: 'string', pattern: '^\\+?\\d{7,15}$', description: 'Simulated number; spaces, parentheses, periods, and hyphens are normalized away.' },
            },
          },
          availabilityPolicy: { type: 'string', enum: ['reject', 'queue'], default: 'reject', description: 'Reject with 503 if no phone is idle, or wait FIFO.' },
          media: {
            type: 'object',
            description: 'Descriptive media-session metadata; does not transport or upload audio.',
            properties: {
              transport: { type: 'string', default: 'webrtc' },
              sessionType: { type: 'string', default: 'voice' },
              audioCodec: { type: 'string', default: 'opus' },
              sampleRate: { type: 'integer', default: 48000 },
              live: { type: 'boolean', default: true },
            },
          },
          recording: {
            type: 'object',
            description: 'REST-created calls cannot capture audio. enabled=true marks browser-participant-required.',
            properties: { enabled: { type: 'boolean', default: false }, recordBothSides: { type: 'boolean', default: false } },
          },
        },
      },
      CallRecord: {
        type: 'object',
        properties: {
          callId: { type: 'string', format: 'uuid' },
          direction: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'ringing', 'accepted', 'active', 'ended', 'failed', 'rejected'] },
          dispatchState: { type: 'string', enum: ['waiting', 'assigned', 'finished'] },
          availabilityPolicy: { type: 'string', enum: ['reject', 'queue'] },
          from: { type: 'object' },
          to: { type: 'object' },
          participants: { type: 'array', items: { type: 'object' } },
          media: { type: 'object' },
          recording: { type: 'object' },
          timestamps: { type: 'object' },
        },
      },
      TranscriptEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          callId: { type: 'string', format: 'uuid' },
          speaker: { type: 'string', enum: ['agent', 'mobile'] },
          text: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          provider: { type: 'string' },
          sequence: { type: 'integer' },
        },
      },
      AudioAssetInput: {
        type: 'object',
        required: ['speaker', 'fileName', 'contentType', 'bytes', 'durationMs'],
        properties: {
          speaker: { type: 'string', enum: ['agent', 'mobile'] },
          fileName: { type: 'string', enum: ['agent.wav', 'mobile.wav'] },
          contentType: { type: 'string', const: 'audio/wav' },
          bytes: { type: 'integer', minimum: 44 },
          durationMs: { type: 'number', minimum: 0 },
          sampleRate: { type: 'integer' },
          channelCount: { type: 'integer' },
        },
      },
      AudioAsset: {
        allOf: [
          schemaRef('AudioAssetInput'),
          { type: 'object', properties: { savedAt: { type: 'string', format: 'date-time' } } },
        ],
      },
    },
  },
  'x-socketio-contract': discoveryDocument.transports.socketIo,
};

const publishedOperations = {
  '/health': ['get'],
  '/api': ['get'],
  '/api/openapi.json': ['get'],
  '/api/ice-config': ['get'],
  '/api/numbers': ['get'],
  '/api/available-numbers': ['get'],
  '/api/capacity': ['get'],
  '/api/calls': ['post'],
  '/api/calls/{callId}': ['get'],
  '/api/calls/{callId}/end': ['post'],
};

openApiDocument.paths = Object.fromEntries(Object.entries(publishedOperations).map(([path, methods]) => [
  path,
  Object.fromEntries(methods.map((method) => [method, openApiDocument.paths[path][method]])),
]));
const publishedTags = new Set(Object.values(openApiDocument.paths).flatMap((path) => (
  Object.values(path).flatMap((operation) => operation.tags || [])
)));
openApiDocument.tags = openApiDocument.tags.filter(({ name }) => publishedTags.has(name));
delete openApiDocument.components.securitySchemes;
delete openApiDocument.components.responses.Unauthorized;
delete openApiDocument.components.schemas.IncomingCall;
delete openApiDocument.components.schemas.TranscriptEntry;
delete openApiDocument.components.schemas.AudioAssetInput;
delete openApiDocument.components.schemas.AudioAsset;

module.exports = { discoveryDocument, openApiDocument };
