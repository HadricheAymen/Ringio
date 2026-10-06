const { randomUUID, timingSafeEqual } = require('crypto');
const { readIceConfigFromEnv } = require('./iceConfig');
const { discoveryDocument, openApiDocument } = require('./apiContract');

function createAgentTokenMiddleware(token) {
  return (req, res, next) => {
    if (!token) return res.status(503).json({ error: 'Internal agent artifact access is not configured.' });
    const authorization = req.get('authorization') || '';
    const received = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(token);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
  };
}

function registerApiDiscoveryRoutes(app) {
  app.get('/api', (_req, res) => res.json(discoveryDocument));
  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));
}

function registerHttpApiRoutes(app, {
  state,
  io,
  getEndpointSnapshot,
  incomingCallPayload,
  createOutboundCall,
  dispatchQueuedCalls,
  endSession,
  internalAgentToken,
}) {
  const requireAgentToken = createAgentTokenMiddleware(internalAgentToken);

  app.get('/health', async (_req, res) => {
    try {
      const [phoneEntries, calls, queuedCalls] = await Promise.all([
        state.listEndpoints(),
        state.listCalls(),
        state.listQueuedCalls(),
      ]);
      return res.json({
        status: state.shared || !process.env.VERCEL ? 'ok' : 'degraded',
        sharedState: state.shared ? 'redis' : 'local-memory',
        ...(process.env.VERCEL && !state.shared ? { warning: 'REDIS_URL is required for reliable Vercel calls and persistent history.' } : {}),
        mobileAppsOnline: phoneEntries.length,
        queuedCalls: queuedCalls.length,
        activeCalls: calls.filter((call) => ['queued', 'ringing', 'accepted', 'active'].includes(call.status)).length,
      });
    } catch (error) {
      return res.status(503).json({ error: error.message });
    }
  });

  app.get('/api/ice-config', (_req, res) => {
    try {
      return res.json(readIceConfigFromEnv());
    } catch (error) {
      return res.status(503).json({ error: error.message });
    }
  });

  app.get('/api/numbers', async (_req, res) => {
    const entries = await state.listEndpoints();
    const list = (await Promise.all(entries.map(([endpointId]) => getEndpointSnapshot(endpointId)))).filter(Boolean);
    return res.json(list);
  });

  app.get('/api/mobile-apps', async (_req, res) => {
    const [entries, order] = await Promise.all([state.listEndpoints(), state.listAppOrder()]);
    const priorities = new Map(order.map((appId, index) => [appId, index]));
    const apps = await Promise.all(entries.map(async ([endpointId]) => {
      const [registeredAppId, snapshot] = await Promise.all([
        state.getEndpointAppId(endpointId),
        getEndpointSnapshot(endpointId),
      ]);
      if (!snapshot) return null;
      const appId = registeredAppId || endpointId;
      const metadata = await state.getAppMetadata(appId);
      return {
        appId,
        name: metadata?.name || 'Ringio mobile app',
        platform: metadata?.platform || 'unknown',
        status: snapshot.status,
        available: snapshot.available,
        blocked: snapshot.blocked ?? !!metadata?.blocked,
        priority: (priorities.get(appId) ?? order.length) + 1,
      };
    }));
    return res.json(apps.filter(Boolean).sort((left, right) => left.priority - right.priority));
  });

  app.post('/api/mobile-apps/:appId/priority', async (req, res) => {
    const { appId } = req.params;
    const { direction } = req.body || {};
    if (!['up', 'down'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be up or down.' });
    }
    if (!await state.getAppMetadata(appId)) return res.status(404).json({ error: 'Mobile app not found.' });
    const order = await state.withRoutingLock(() => state.moveApp(appId, direction));
    io?.emit('directory:changed', { apps: true });
    return res.json({ appId, priority: order.indexOf(appId) + 1 });
  });

  app.post('/api/mobile-apps/:appId/block', async (req, res) => {
    const { appId } = req.params;
    const { blocked } = req.body || {};
    if (typeof blocked !== 'boolean') return res.status(400).json({ error: 'blocked must be a boolean.' });
    const app = await state.withRoutingLock(() => state.setAppBlocked(appId, blocked));
    if (!app) return res.status(404).json({ error: 'Mobile app not found.' });
    io?.emit('directory:changed', { apps: true });
    if (!blocked) await dispatchQueuedCalls?.();
    return res.json({ appId, blocked: app.blocked });
  });

  app.post('/api/mobile-apps/:appId/name', async (req, res) => {
    const { appId } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 48) return res.status(400).json({ error: 'name must contain 1 to 48 characters.' });
    const app = await state.renameApp(appId, name);
    if (!app) return res.status(404).json({ error: 'Mobile app not found.' });
    io?.emit('directory:changed', { apps: true });
    return res.json({ appId, name: app.name });
  });

  app.get('/api/queued-calls', async (_req, res) => {
    const callIds = await state.listQueuedCalls();
    const queuedCalls = await Promise.all(callIds.map(async (callId) => {
      const call = await state.getCall(callId);
      if (!call || call.status !== 'queued' || call.dispatchState !== 'waiting') return null;
      const queuedAt = call.timestamps.createdAt;
      return {
        callId,
        number: call.to.number,
        caller: call.from.metadata?.name || call.from.role || 'Caller',
        mediaSource: call.from.mediaSource,
        queuedAt,
        waitSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(queuedAt)) / 1000)),
      };
    }));
    return res.json(queuedCalls.filter(Boolean));
  });

  app.get('/api/available-numbers', async (_req, res) => {
    const entries = await state.listEndpoints();
    const list = (await Promise.all(entries.map(([endpointId]) => getEndpointSnapshot(endpointId))))
      .filter((entry) => entry && entry.available)
      .map((entry) => ({ status: entry.status }));
    return res.json(list);
  });

  app.get('/api/capacity', async (_req, res) => {
    const [entries, queuedCalls] = await Promise.all([
      state.listEndpoints(),
      state.listQueuedCalls(),
    ]);
    const snapshots = await Promise.all(entries.map(([endpointId]) => getEndpointSnapshot(endpointId)));
    const onlineMachines = snapshots.filter(Boolean).length;
    const availableMachines = snapshots.filter((entry) => entry?.available).length;
    const busyMachines = snapshots.filter((entry) => entry?.status === 'busy').length;
    const blockedMachines = snapshots.filter((entry) => entry?.blocked).length;
    return res.json({
      onlineMachines,
      availableMachines,
      busyMachines,
      blockedMachines,
      queuedCalls: queuedCalls.length,
      canLaunchCall: availableMachines > 0 && queuedCalls.length === 0,
    });
  });

  app.get('/api/endpoints/:endpointId/incoming', async (req, res) => {
    const phoneSocketId = await state.getEndpoint(req.params.endpointId);
    if (!phoneSocketId) return res.json({ call: null });
    const callId = await state.getSocketCall(phoneSocketId);
    if (!callId) return res.json({ call: null });
    const call = await state.getCall(callId);
    if (!call || call.status !== 'ringing') return res.json({ call: null });
    return res.json({ call: incomingCallPayload(call) });
  });

  app.post('/api/calls/:callId/transcripts', requireAgentToken, async (req, res) => {
    const { callId } = req.params;
    if (!await state.getCall(callId)) return res.status(404).json({ error: 'Call not found.' });
    const { speaker, text, timestamp } = req.body || {};
    if (!['agent', 'mobile'].includes(speaker) || typeof text !== 'string' || !text.trim() || text.length > 10000) {
      return res.status(400).json({ error: 'speaker and text are required; speaker must be agent or mobile.' });
    }
    const occurredAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
    const entry = {
      id: randomUUID(),
      callId,
      speaker,
      text: text.trim(),
      timestamp: occurredAt,
      provider: 'gemini-3.8-live',
    };
    entry.sequence = await state.appendTranscript(callId, entry);
    return res.status(201).json({ id: entry.id, sequence: entry.sequence });
  });

  app.get('/api/calls/:callId/transcripts', requireAgentToken, async (req, res) => {
    if (!await state.getCall(req.params.callId)) return res.status(404).json({ error: 'Call not found.' });
    return res.json(await state.getTranscripts(req.params.callId));
  });

  app.post('/api/calls/:callId/assets', requireAgentToken, async (req, res) => {
    const { callId } = req.params;
    if (!await state.getCall(callId)) return res.status(404).json({ error: 'Call not found.' });
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || assets.length > 2 || assets.some((asset) => (
      !asset || !['agent', 'mobile'].includes(asset.speaker)
      || typeof asset.fileName !== 'string'
      || asset.fileName !== `${asset.speaker}.wav`
      || asset.contentType !== 'audio/wav'
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 44
      || !Number.isFinite(asset.durationMs) || asset.durationMs < 0
    ))) {
      return res.status(400).json({ error: 'Provide valid private WAV metadata for each call speaker.' });
    }
    await state.setCallAssets(callId, assets.map((asset) => ({
      speaker: asset.speaker,
      fileName: asset.fileName,
      contentType: asset.contentType,
      bytes: asset.bytes,
      durationMs: asset.durationMs,
      sampleRate: asset.sampleRate,
      channelCount: asset.channelCount,
      savedAt: new Date().toISOString(),
    })));
    return res.status(201).json({ count: assets.length });
  });

  app.get('/api/calls/:callId/assets', requireAgentToken, async (req, res) => {
    if (!await state.getCall(req.params.callId)) return res.status(404).json({ error: 'Call not found.' });
    return res.json(await state.getCallAssets(req.params.callId));
  });

  app.get('/api/calls', async (_req, res) => res.json(await state.listCalls()));

  app.get('/api/calls/:callId', async (req, res) => {
    const record = await state.getCall(req.params.callId);
    if (!record) return res.status(404).json({ error: 'Call not found' });
    return res.json(record);
  });

  app.get('/api/calls/:callId/recording', async (req, res) => {
    const record = await state.getCall(req.params.callId);
    if (!record) return res.status(404).json({ error: 'Call not found' });
    const recording = record.recording?.recordingId
      ? await state.getRecording(record.recording.recordingId)
      : null;
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    return res.json(recording);
  });

  app.get('/api/recordings', async (_req, res) => res.json(await state.listRecordings()));

  app.get('/api/calls/:callId/media', async (req, res) => res.json(await state.getMediaEvents(req.params.callId)));

  app.get('/api/calls/:callId/signals/:recipient', async (req, res) => {
    const { callId, recipient } = req.params;
    if (!['caller', 'phone'].includes(recipient)) {
      return res.status(400).json({ error: 'Recipient must be caller or phone.' });
    }
    if (!await state.getCall(callId)) return res.status(404).json({ error: 'Call not found' });
    return res.json(await state.getSignals(callId, recipient, req.query.offset));
  });

  app.post('/api/calls/:callId/media', async (req, res) => {
    const { participantId, role, mediaSource, kind, payload = {} } = req.body || {};
    const callId = req.params.callId;
    const callRecord = await state.getCall(callId);
    if (!callRecord) return res.status(404).json({ error: 'Call not found' });

    const event = {
      id: randomUUID(),
      callId,
      participantId: participantId || `${role || 'unknown'}-${Date.now()}`,
      role: role || 'agent',
      mediaSource: mediaSource || 'tts',
      kind: kind || 'ai-audio',
      payload,
      createdAt: new Date().toISOString(),
    };
    const callEvents = await state.addMediaEvent(callId, event);
    callRecord.media = callRecord.media || {};
    callRecord.media.events = callEvents;
    if (kind === 'ai-audio') {
      callRecord.media.aiAudio = { source: mediaSource || 'tts', eventId: event.id, payload };
    }
    await state.setCall(callRecord);
    return res.status(201).json(event);
  });

  app.post('/api/calls/:callId/recording', async (req, res) => {
    const callRecord = await state.getCall(req.params.callId);
    if (!callRecord) return res.status(404).json({ error: 'Call not found' });
    if (!callRecord.recording?.recordingId) return res.status(409).json({ error: 'This call has no browser recording enabled.' });
    const current = await state.getRecording(callRecord.recording.recordingId);
    if (!current) return res.status(404).json({ error: 'Recording metadata not found' });
    const recording = {
      ...current,
      status: 'downloaded',
      fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : null,
      mimeType: typeof req.body?.mimeType === 'string' ? req.body.mimeType : null,
      bytes: Number.isFinite(req.body?.bytes) ? req.body.bytes : 0,
      durationMs: Number.isFinite(req.body?.durationMs) ? req.body.durationMs : 0,
      downloadedAt: new Date().toISOString(),
    };
    callRecord.recording.status = recording.status;
    callRecord.recording.fileName = recording.fileName;
    callRecord.recording.bytes = recording.bytes;
    await Promise.all([state.setRecording(recording), state.setCall(callRecord)]);
    return res.status(200).json(recording);
  });

  app.post('/api/calls', async (req, res) => {
    const { from = {}, to = {}, recording, media } = req.body || {};
    const number = String(to.number || to.target || req.body?.number || '').trim().replace(/[\s().-]/g, '');
    const availabilityPolicy = req.body?.availabilityPolicy === undefined || req.body.availabilityPolicy === 'reject' || req.body.availabilityPolicy === 'queue'
      ? req.body?.availabilityPolicy || 'reject'
      : null;
    if (!/^\+?\d{7,15}$/.test(number)) return res.status(400).json({ error: 'Enter a valid destination phone number.' });
    if (!availabilityPolicy) return res.status(400).json({ error: 'availabilityPolicy must be reject or queue.' });

    try {
      const { callRecord } = await createOutboundCall({ from, number, availabilityPolicy, recordingEnabled: false, media });
      if (recording?.enabled) {
        callRecord.recording = {
          enabled: false,
          mode: 'browser-download',
          recordBothSides: !!recording.recordBothSides,
          format: 'webm',
          storage: 'caller-device',
          status: 'browser-participant-required',
        };
        await state.setCall(callRecord);
      }
      return res.status(201).json(callRecord);
    } catch (error) {
      const status = error.code === 'LINE_BUSY' ? 409 : error.code === 'APPS_UNAVAILABLE' ? 503 : 500;
      return res.status(status).json({ error: error.message, code: error.code || 'CALL_CREATE_FAILED' });
    }
  });

  app.post('/api/calls/:callId/end', async (req, res) => {
    const callId = req.params.callId;
    if (!await state.getCall(callId)) return res.status(404).json({ error: 'Call not found' });
    await endSession(callId, 'ended', req.body?.socketId || null);
    return res.json({ success: true, callId, status: 'ended' });
  });
}

module.exports = { registerApiDiscoveryRoutes, registerHttpApiRoutes };
