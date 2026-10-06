const assert = require('node:assert/strict');
const { test } = require('node:test');
const { registerHttpApiRoutes } = require('../httpRoutes');
const { createStateStore } = require('../stateStore');

function createRouteHarness({
  internalAgentToken = 'agent-secret',
  state = {},
  getEndpointSnapshot = async () => null,
  dispatchQueuedCalls = async () => {},
} = {}) {
  const routes = new Map();
  const app = {
    get(path, handler) {
      routes.set(`GET ${path}`, [handler]);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
    },
  };

  const defaultState = {
    getCall: async () => ({ callId: 'call-123', status: 'ringing' }),
    appendTranscript: async (_callId, entry) => {
      defaultState.lastEntry = entry;
      return 1;
    },
    ...state,
  };

  registerHttpApiRoutes(app, {
    state: defaultState,
    getEndpointSnapshot,
    incomingCallPayload: (call) => call,
    createOutboundCall: async () => ({}),
    dispatchQueuedCalls,
    endSession: async () => {},
    internalAgentToken,
  });

  return {
    app,
    routes,
    get state() {
      return defaultState;
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    sent: false,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.sent = true;
      return this;
    },
  };
}

async function runRoute({ method, path, headers = {}, body }, routes) {
  const handlers = routes.get(`${method} ${path}`);
  assert.ok(handlers, `Route ${method} ${path} should be registered`);

  const req = {
    params: { callId: 'call-123', appId: 'app-two' },
    headers,
    body,
    query: {},
    get(name) {
      return this.headers[name.toLowerCase()] || undefined;
    },
  };
  const res = createResponse();
  let nextCalled = false;

  for (const handler of handlers) {
    await handler(req, res, () => {
      nextCalled = true;
    });
    if (res.sent) break;
  }

  return { res, nextCalled };
}

test('transcript route requires the internal agent token and persists Gemini metadata', async () => {
  const { routes, state } = createRouteHarness();

  const unauthorized = await runRoute({
    method: 'POST',
    path: '/api/calls/:callId/transcripts',
    body: { speaker: 'agent', text: 'عسلامة' },
  }, routes);
  assert.equal(unauthorized.res.statusCode, 401);
  assert.equal(unauthorized.res.body.error, 'Unauthorized.');

  const authorized = await runRoute({
    method: 'POST',
    path: '/api/calls/:callId/transcripts',
    headers: { authorization: 'Bearer agent-secret' },
    body: {
      speaker: 'mobile',
      text: 'عسلامة بيك',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  }, routes);

  assert.equal(authorized.res.statusCode, 201);
  assert.equal(state.lastEntry.provider, 'gemini-3.8-live');
  assert.equal(state.lastEntry.sequence, 1);
  assert.equal(state.lastEntry.speaker, 'mobile');
  assert.equal(state.lastEntry.text, 'عسلامة بيك');
});

test('lists connected apps in routing priority order', async () => {
  const { routes } = createRouteHarness({
    state: {
      listEndpoints: async () => [['endpoint-one', 'socket-one'], ['endpoint-two', 'socket-two']],
      listAppOrder: async () => ['app-two', 'app-one'],
      getEndpointAppId: async (endpointId) => endpointId === 'endpoint-one' ? 'app-one' : 'app-two',
      getAppMetadata: async (appId) => ({ appId, name: appId, platform: 'android' }),
    },
    getEndpointSnapshot: async () => ({ status: 'online', available: true }),
  });
  const { res } = await runRoute({ method: 'GET', path: '/api/mobile-apps' }, routes);
  assert.deepEqual(res.body.map(({ appId, priority }) => ({ appId, priority })), [
    { appId: 'app-two', priority: 1 },
    { appId: 'app-one', priority: 2 },
  ]);
});

test('moves app priority without requiring authentication', async () => {
  let order = ['app-one', 'app-two'];
  const { routes } = createRouteHarness({
    state: {
      getAppMetadata: async () => ({ appId: 'app-two' }),
      withRoutingLock: (callback) => callback(),
      moveApp: async (appId, direction) => {
        if (appId === 'app-two' && direction === 'up') order = ['app-two', 'app-one'];
        return order;
      },
    },
  });
  const { res } = await runRoute({
    method: 'POST',
    path: '/api/mobile-apps/:appId/priority',
    body: { direction: 'up' },
  }, routes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { appId: 'app-two', priority: 1 });
});

test('reserves apps by priority and falls back when the preferred app is busy', async () => {
  const state = createStateStore({}, '');
  await state.setEndpoint('endpoint-one', 'socket-one', { appId: 'app-one' });
  await state.setEndpoint('endpoint-two', 'socket-two', { appId: 'app-two' });
  await state.moveApp('app-two', 'up');

  assert.deepEqual(await state.reserveAvailableEndpoint('call-one'), {
    endpointId: 'endpoint-two',
    socketId: 'socket-two',
  });
  assert.deepEqual(await state.reserveAvailableEndpoint('call-two'), {
    endpointId: 'endpoint-one',
    socketId: 'socket-one',
  });
});

test('lists waiting calls in queue order with age and caller details', async () => {
  const createdAt = new Date().toISOString();
  const { routes } = createRouteHarness({
    state: {
      listQueuedCalls: async () => ['call-one', 'call-two'],
      getCall: async (callId) => ({
        callId,
        status: 'queued',
        dispatchState: 'waiting',
        to: { number: `+1555000${callId === 'call-one' ? '0001' : '0002'}` },
        from: { role: 'agent', mediaSource: 'gemini-live', metadata: { name: 'Support agent' } },
        timestamps: { createdAt },
      }),
    },
  });
  const { res } = await runRoute({ method: 'GET', path: '/api/queued-calls' }, routes);
  assert.deepEqual(res.body.map(({ callId, caller, mediaSource }) => ({ callId, caller, mediaSource })), [
    { callId: 'call-one', caller: 'Support agent', mediaSource: 'gemini-live' },
    { callId: 'call-two', caller: 'Support agent', mediaSource: 'gemini-live' },
  ]);
  assert.ok(res.body.every(({ waitSeconds }) => waitSeconds >= 0));
});

test('blocks and allows an app without authentication or disconnecting it', async () => {
  let blocked = false;
  let dispatches = 0;
  const { routes } = createRouteHarness({
    state: {
      withRoutingLock: (callback) => callback(),
      setAppBlocked: async (_appId, value) => {
        blocked = value;
        return { appId: 'app-two', blocked };
      },
    },
    dispatchQueuedCalls: async () => { dispatches += 1; },
  });
  const blockedResponse = await runRoute({
    method: 'POST',
    path: '/api/mobile-apps/:appId/block',
    body: { blocked: true },
  }, routes);
  assert.deepEqual(blockedResponse.res.body, { appId: 'app-two', blocked: true });

  const allowedResponse = await runRoute({
    method: 'POST',
    path: '/api/mobile-apps/:appId/block',
    body: { blocked: false },
  }, routes);
  assert.deepEqual(allowedResponse.res.body, { appId: 'app-two', blocked: false });
  assert.equal(blocked, false);
  assert.equal(dispatches, 1);
});

test('renames a mobile app without authentication and trims its label', async () => {
  let savedName = 'Ringio Voice';
  const { routes } = createRouteHarness({
    state: {
      renameApp: async (appId, name) => {
        savedName = name;
        return { appId, name };
      },
    },
  });
  const { res } = await runRoute({
    method: 'POST',
    path: '/api/mobile-apps/:appId/name',
    body: { name: '  Hallway phone  ' },
  }, routes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { appId: 'app-two', name: 'Hallway phone' });
  assert.equal(savedName, 'Hallway phone');
});

test('blocked state survives app reconnect and prevents new reservations', async () => {
  const state = createStateStore({}, '');
  await state.setEndpoint('endpoint-one', 'socket-one', { appId: 'app-one' });
  await state.setEndpoint('endpoint-two', 'socket-two', { appId: 'app-two' });
  await state.setAppBlocked('app-one', true);
  await state.removeEndpoint('endpoint-one', 'socket-one');
  await state.setEndpoint('endpoint-one-reconnected', 'socket-one-reconnected', { appId: 'app-one' });

  assert.equal((await state.getAppMetadata('app-one')).blocked, true);
  assert.deepEqual(await state.reserveAvailableEndpoint('call-one'), {
    endpointId: 'endpoint-two',
    socketId: 'socket-two',
  });
});

test("custom app name survives reconnect with the client's default label", async () => {
  const state = createStateStore({}, '');
  await state.setEndpoint('endpoint-one', 'socket-one', { appId: 'app-one', name: 'Ringio Voice' });
  await state.renameApp('app-one', 'Hallway phone');
  await state.setEndpoint('endpoint-one-reconnected', 'socket-one-reconnected', {
    appId: 'app-one',
    name: 'Ringio Voice',
  });
  assert.equal((await state.getAppMetadata('app-one')).name, 'Hallway phone');
});
