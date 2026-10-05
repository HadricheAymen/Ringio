const express = require('express');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const { createStateStore } = require('./stateStore');
const { registerApiDiscoveryRoutes, registerHttpApiRoutes } = require('./httpRoutes');

const PORT = Number(process.env.PORT || 4100);
const HOST = process.env.HOST || '0.0.0.0';
const INTERNAL_AGENT_TOKEN = process.env.INTERNAL_AGENT_TOKEN || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});
const state = createStateStore(io, process.env.REDIS_URL);

io.use((_socket, next) => state.ready.then(() => {
  if (process.env.VERCEL && !state.shared) {
    return next(new Error('Configure REDIS_URL to enable shared call state on Vercel.'));
  }
  return next();
}).catch(next));

app.use((_req, _res, next) => state.ready.then(() => next()).catch(next));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
registerApiDiscoveryRoutes(app);
app.use('/api', (_req, res, next) => {
  if (process.env.VERCEL && !state.shared) {
    return res.status(503).json({ error: 'Configure REDIS_URL to enable shared call state on Vercel.' });
  }
  return next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function sendError(socket, code, message) {
  socket.emit('call:error', { code, message });
}

function normalizePhoneNumber(value) {
  const text = String(value ?? '').trim();
  const number = text.replace(/[\s().-]/g, '');
  return /^\+?\d{7,15}$/.test(number) ? number : null;
}

function normalizeAvailabilityPolicy(value) {
  return value === 'queue' ? 'queue' : value === undefined || value === 'reject' ? 'reject' : null;
}

async function getEndpointSnapshot(endpointId) {
  const socketId = await state.getEndpoint(endpointId);
  if (!socketId) return null;
  const busy = await state.getSocketCall(socketId);
  return {
    status: busy ? 'busy' : 'online',
    available: !busy,
    lastSeen: new Date().toISOString(),
  };
}

function incomingCallPayload(callRecord) {
  return {
    callId: callRecord.callId,
    number: callRecord.to.number,
    caller: callRecord.from.role === 'agent'
      ? 'AI agent'
      : callRecord.from.role === 'caller' ? 'PC caller' : 'Service caller',
    recording: callRecord.recording,
  };
}

async function assignCall(callRecord, session, endpoint) {
  session.endpointId = endpoint.endpointId;
  session.state = 'RINGING';
  session.participants.set('phone', endpoint.socketId);
  callRecord.status = 'ringing';
  callRecord.dispatchState = 'assigned';
  const phoneParticipant = callRecord.participants.find((participant) => participant.role === 'mobile');
  phoneParticipant.id = 'mobile-app';
  phoneParticipant.number = callRecord.to.number;
  await Promise.all([
    state.setSocketCall(endpoint.socketId, callRecord.callId),
    state.setSession(session),
    state.setCall(callRecord),
  ]);
  io.emit('directory:changed', { online: true, available: false });
  io.to(endpoint.socketId).emit('call:incoming', incomingCallPayload(callRecord));
  const callerSocketId = session.participants.get('caller');
  if (callerSocketId && !callerSocketId.startsWith('api:')) {
    io.to(callerSocketId).emit('call:outgoing', {
      callId: callRecord.callId,
      number: callRecord.to.number,
      state: session.state,
    });
  }
}

async function dispatchQueuedCalls() {
  await state.withRoutingLock(async () => {
    for (const callId of await state.listQueuedCalls()) {
      const callRecord = await state.getCall(callId);
      const session = await state.getSession(callId);
      if (!callRecord || !session || callRecord.dispatchState !== 'waiting') {
        await state.removeQueuedCall(callId);
        continue;
      }
      const endpoint = await state.reserveAvailableEndpoint(callId);
      if (!endpoint) return;
      await state.removeQueuedCall(callId);
      await assignCall(callRecord, session, endpoint);
    }
  });
}

async function createOutboundCall({ from, number, availabilityPolicy, callerSocketId, recordingEnabled = false, media }) {
  const callId = randomUUID();
  const sourceRole = from.role || 'service';
  const caller = callerSocketId || `api:${sourceRole}`;
  const recordingMeta = recordingEnabled
    ? createRecordingArtifact(callId, { enabled: true, recordBothSides: true })
    : null;
  const callRecord = {
    callId,
    direction: 'outbound',
    status: 'queued',
    dispatchState: 'waiting',
    availabilityPolicy,
    from: {
      role: sourceRole,
      mediaSource: from.mediaSource || 'generated',
      type: from.type || 'caller',
      metadata: from.metadata || {},
    },
    to: { type: 'mobile', number },
    media: {
      transport: media?.transport || 'webrtc',
      sessionType: media?.sessionType || 'voice',
      audioCodec: media?.audioCodec || 'opus',
      sampleRate: media?.sampleRate || 48000,
      live: media?.live ?? true,
      events: [],
    },
    recording: {
      enabled: recordingEnabled,
      mode: recordingEnabled ? 'browser-download' : 'disabled',
      recordBothSides: recordingEnabled,
      format: recordingEnabled ? 'webm' : null,
      storage: recordingEnabled ? 'caller-device' : null,
      status: recordingEnabled ? 'pending' : 'disabled',
      ...(recordingMeta ? { recordingId: recordingMeta.recordingId } : {}),
    },
    timestamps: { createdAt: new Date().toISOString(), acceptedAt: null, startedAt: null, endedAt: null },
    participants: [{
      id: `caller-${callerSocketId || callId}`,
      role: sourceRole,
      mediaSource: from.mediaSource || 'generated',
      type: from.type || 'caller',
      endpointId: null,
      number: null,
      socketId: callerSocketId || null,
    }, {
      id: `phone-${callId}`,
      role: 'mobile',
      mediaSource: 'phone-mic',
      type: 'callee',
      number,
    }],
  };
  const session = {
    id: callId,
    number,
    endpointId: null,
    state: 'QUEUED',
    participants: new Map([['caller', caller]]),
  };

  let endpoint = null;
  let queued = false;
  await state.withRoutingLock(async () => {
    if (callerSocketId && await state.getSocketCall(callerSocketId)) {
      throw Object.assign(new Error('The caller is already in a call.'), { code: 'LINE_BUSY' });
    }
    const waitingCalls = await state.listQueuedCalls();
    if (!waitingCalls.length) endpoint = await state.reserveAvailableEndpoint(callId);
    if (!endpoint && availabilityPolicy === 'reject') {
      throw Object.assign(new Error('No mobile app is available right now.'), { code: 'APPS_UNAVAILABLE' });
    }
    if (callerSocketId) await state.setSocketCall(callerSocketId, callId);
    if (endpoint) {
      session.participants.set('phone', endpoint.socketId);
    } else {
      queued = true;
      await state.enqueueCall(callId);
    }
    await Promise.all([
      state.setSession(session),
      state.setCall(callRecord),
      recordingMeta ? state.setRecording(recordingMeta) : Promise.resolve(),
    ]);
    if (endpoint) await assignCall(callRecord, session, endpoint);
  });

  if (!endpoint && callerSocketId) io.to(callerSocketId).emit('call:queued', { callId, number, policy: availabilityPolicy });
  return { callRecord, queued };
}

function createRecordingArtifact(callId, recordingConfig) {
  const recordingId = `rec_${callId}`;
  return {
    recordingId,
    callId,
    enabled: !!recordingConfig?.enabled,
    mode: 'browser-download',
    recordBothSides: !!recordingConfig?.recordBothSides,
    format: recordingConfig?.format || 'webm',
    storage: 'caller-device',
    status: 'pending',
    createdAt: new Date().toISOString(),
    fileName: null,
    mimeType: null,
    bytes: 0,
    durationMs: 0,
    downloadedAt: null,
  };
}

async function endSession(callId, reason, actorSocketId, disconnectedParticipantRole = null) {
  let ended = false;
  let releasedEndpointId = null;
  await state.withRoutingLock(async () => {
    const session = await state.getSession(callId);
    const callRecord = await state.getCall(callId);
    if (!session && !callRecord) return;
    ended = true;
    if (session) await state.removeSession(callId);
    await state.removeQueuedCall(callId);
    if (callRecord) {
      callRecord.status = reason === 'rejected' ? 'rejected' : reason === 'participant-disconnected' ? 'failed' : 'ended';
      callRecord.dispatchState = 'finished';
      if (reason === 'participant-disconnected') callRecord.disconnectedParticipantRole = disconnectedParticipantRole;
      callRecord.timestamps.endedAt = new Date().toISOString();
      const startedAt = callRecord.timestamps.startedAt || callRecord.timestamps.acceptedAt || callRecord.timestamps.createdAt;
      callRecord.durationMs = Math.max(0, Date.parse(callRecord.timestamps.endedAt) - Date.parse(startedAt));
      if (callRecord.recording?.enabled && callRecord.recording.status === 'pending') {
        callRecord.recording.status = 'not-downloaded';
      }
      await state.setCall(callRecord);
    }

    if (session) {
      for (const socketId of session.participants.values()) {
        if (!socketId || socketId.startsWith('api:')) continue;
        await state.removeSocketCall(socketId, callId);
        if (socketId !== actorSocketId) io.to(socketId).emit('call:ended', {
          callId,
          reason,
          ...(disconnectedParticipantRole ? { disconnectedParticipantRole } : {}),
        });
      }
      if (session.endpointId) {
        releasedEndpointId = session.endpointId;
        await state.releaseEndpoint(session.endpointId, callId);
      }
    }
  });
  if (releasedEndpointId) io.emit('directory:changed', { online: true, available: true });
  if (ended) await dispatchQueuedCalls();
  return ended;
}

registerHttpApiRoutes(app, {
  state,
  getEndpointSnapshot,
  incomingCallPayload,
  createOutboundCall,
  endSession,
  internalAgentToken: INTERNAL_AGENT_TOKEN,
});

io.on('connection', (socket) => {
  socket.on('participant:register', async ({ role, mediaSource } = {}) => {
    if (role === 'phone') {
      const endpointId = randomUUID();
      await state.setEndpoint(endpointId, socket.id);
      socket.data.role = 'phone';
      socket.data.endpointId = endpointId;
      socket.data.presenceTimer = setInterval(() => {
        state.refreshEndpoint(endpointId, socket.id).catch((error) => console.error(error.message));
      }, 25000);
      socket.data.presenceTimer.unref?.();
      io.emit('directory:changed', { online: true, available: true });
      socket.emit('participant:registered', { role, endpointId });
      await dispatchQueuedCalls();
      return;
    }

    if (role === 'caller' || role === 'agent') {
      socket.data.role = role;
      socket.data.mediaSource = role === 'agent' ? 'agent' : (mediaSource || 'human-pc');
      socket.emit('participant:registered', { role, mediaSource: socket.data.mediaSource });
      return;
    }

    sendError(socket, 'INVALID_ROLE', 'Register as phone, caller, or agent.');
  });

  socket.on('directory:watch', async () => {
    const entries = await state.listEndpoints();
    const snapshots = await Promise.all(entries.map(([endpointId]) => getEndpointSnapshot(endpointId)));
    socket.emit('directory:snapshot', {
      onlineApps: entries.length,
      availableApps: snapshots.filter((entry) => entry?.available).length,
    });
  });

  socket.on('call:start', async ({ number: requestedNumber, availabilityPolicy = 'reject' } = {}) => {
    if (socket.data.role !== 'caller' && socket.data.role !== 'agent') {
      return sendError(socket, 'NOT_REGISTERED', 'Register as a caller before placing a call.');
    }
    const recordingEnabled = socket.data.role === 'caller' && socket.data.mediaSource === 'human-pc';
    const number = normalizePhoneNumber(requestedNumber);
    const policy = normalizeAvailabilityPolicy(availabilityPolicy);
    if (!number) return sendError(socket, 'INVALID_NUMBER', 'Enter a valid destination phone number.');
    if (!policy) return sendError(socket, 'INVALID_AVAILABILITY_POLICY', 'Choose reject or queue when no app is available.');
    try {
      await createOutboundCall({
        from: {
          role: socket.data.role,
          mediaSource: socket.data.mediaSource,
          type: 'caller',
          metadata: { source: socket.data.mediaSource },
        },
        number,
        availabilityPolicy: policy,
        callerSocketId: socket.id,
        recordingEnabled,
        media: { transport: 'webrtc' },
      });
    } catch (error) {
      sendError(socket, error.code || 'CALL_CREATE_FAILED', error.message);
    }
  });

  socket.on('call:accept', async ({ callId } = {}) => {
    const session = await state.getSession(callId);
    if (!session || session.participants.get('phone') !== socket.id || session.state !== 'RINGING') {
      return sendError(socket, 'CALL_NOT_AVAILABLE', 'That call is no longer available.');
    }
    session.state = 'CONNECTING';
    await state.setSession(session);
    const callRecord = await state.getCall(callId);
    if (callRecord) {
      callRecord.status = 'accepted';
      callRecord.timestamps.acceptedAt = new Date().toISOString();
      await state.setCall(callRecord);
    }
    io.to(session.participants.get('caller')).emit('call:accepted', { callId });
    socket.emit('call:accepted', { callId });
  });

  socket.on('call:reject', async ({ callId } = {}) => {
    const session = await state.getSession(callId);
    if (!session || session.participants.get('phone') !== socket.id || session.state !== 'RINGING') {
      return sendError(socket, 'CALL_NOT_AVAILABLE', 'That call is no longer available.');
    }
    io.to(session.participants.get('caller')).emit('call:rejected', { callId });
    await endSession(callId, 'rejected', socket.id);
  });

  socket.on('call:reconnect', async ({ callId, role } = {}) => {
    if (!callId) return sendError(socket, 'INVALID_RECONNECT', 'callId is required.');
    const session = await state.getSession(callId);
    if (!session) return sendError(socket, 'CALL_NOT_FOUND', 'Session not found for reconnect.');

    const participantRole = role === 'phone' ? 'phone' : 'caller';
    const oldSocketId = session.participants.get(participantRole);
    if (oldSocketId && oldSocketId !== socket.id) {
      await state.removeSocketCall(oldSocketId, callId);
    }
    session.participants.set(participantRole, socket.id);
    socket.data.role = role || (participantRole === 'phone' ? 'phone' : 'agent');
    socket.data.callId = callId;
    if (participantRole === 'phone' && session.endpointId) {
      socket.data.endpointId = session.endpointId;
      await state.setEndpoint(session.endpointId, socket.id);
    }

    await Promise.all([
      state.setSocketCall(socket.id, callId),
      state.setSession(session),
    ]);

    socket.emit('call:reconnected', { callId, role: socket.data.role, state: session.state });
    console.log(`Socket ${socket.id} reconnected and re-associated as ${participantRole} for call ${callId}`);
  });

  socket.on('call:end', async ({ callId } = {}) => {
    const session = await state.getSession(callId);
    if (!session) {
      return sendError(socket, 'CALL_NOT_FOUND', 'No active call found for this participant.');
    }
    await endSession(callId, 'ended', socket.id);
  });

  for (const eventName of ['rtc:offer', 'rtc:answer', 'rtc:ice']) {
    socket.on(eventName, async (payload = {}) => {
      const session = await state.getSession(payload.callId);
      if (!session) {
        return sendError(socket, 'CALL_NOT_FOUND', 'Signaling call was not found.');
      }
      const socketCall = await state.getSocketCall(socket.id);
      const isKnown = [...session.participants.values()].includes(socket.id) || socketCall === payload.callId;
      if (!isKnown) {
        return sendError(socket, 'CALL_NOT_FOUND', 'Signaling call was not found.');
      }
      if (session.state !== 'CONNECTING' && session.state !== 'ACTIVE') {
        return sendError(socket, 'CALL_NOT_READY', 'The call has not been accepted yet.');
      }
      const senderRole = socket.data.role === 'phone' ? 'phone' : 'caller';
      if (session.participants.get(senderRole) !== socket.id) {
        session.participants.set(senderRole, socket.id);
        await Promise.all([
          state.setSocketCall(socket.id, payload.callId),
          state.setSession(session),
        ]);
      }
      const targetRole = senderRole === 'phone' ? 'caller' : 'phone';
      const targetSocketId = session.participants.get(targetRole);
      const signal = {
        id: randomUUID(),
        eventName,
        payload: { ...payload, from: socket.id },
        createdAt: new Date().toISOString(),
      };
      await state.addSignal(payload.callId, targetRole, signal);
      if (targetSocketId && !targetSocketId.startsWith('api:')) {
        io.to(targetSocketId).emit(eventName, { ...signal.payload, signalId: signal.id });
      }
    });
  }

  socket.on('call:active', async ({ callId } = {}) => {
    const session = await state.getSession(callId);
    if (!session) return;
    const socketCall = await state.getSocketCall(socket.id);
    const isCaller = session.participants.get('caller') === socket.id || socket.data.role === 'agent' || socket.data.role === 'caller' || socketCall === callId;
    if (!isCaller) return;
    session.state = 'ACTIVE';
    await state.setSession(session);
    const callRecord = await state.getCall(callId);
    if (callRecord) {
      callRecord.status = 'active';
      callRecord.timestamps.startedAt = callRecord.timestamps.startedAt || new Date().toISOString();
      await state.setCall(callRecord);
    }
    const phoneSocket = session.participants.get('phone');
    if (phoneSocket && phoneSocket !== socket.id && !phoneSocket.startsWith('api:')) {
      io.to(phoneSocket).emit('call:active', { callId });
    }
  });

  socket.on('disconnect', async () => {
    if (socket.data.presenceTimer) clearInterval(socket.data.presenceTimer);
    let endpointRemoved = false;
    let sessionPreserved = false;
    const callId = await state.getSocketCall(socket.id);
    if (callId) {
      const session = await state.getSession(callId);
      if (session && (session.state === 'ACTIVE' || session.state === 'CONNECTING')) {
        sessionPreserved = true;
        console.log(`Socket ${socket.id} (${socket.data.role || 'unknown'}) disconnected from ${session.state} call ${callId}; preserving session.`);
      } else {
        await endSession(callId, 'participant-disconnected', socket.id, socket.data.role || 'unknown');
      }
    }
    if (socket.data.role === 'phone' && socket.data.endpointId && !sessionPreserved) {
      endpointRemoved = await state.withRoutingLock(() => state.removeEndpoint(socket.data.endpointId, socket.id));
      if (endpointRemoved) io.emit('directory:changed', { online: false, available: false });
    }
    if (endpointRemoved) {
      await dispatchQueuedCalls();
    }
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`VoIP call server listening on http://${HOST}:${PORT}`);
    console.log('Mobile apps register as private call endpoints.');
  });
}

module.exports = server;