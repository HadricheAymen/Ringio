const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { io: createClient } = require('socket.io-client');
const { test } = require('node:test');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitFor(socket, eventName, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeout);
    socket.once(eventName, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function connectClient(url, timeout = 800) {
  const socket = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout,
  });
  await Promise.race([
    waitFor(socket, 'connect', timeout),
    waitFor(socket, 'connect_error', timeout).then(([error]) => Promise.reject(error)),
  ]);
  return socket;
}

test('publishes API discovery and OpenAPI contract without shared-state configuration', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), VERCEL: '1', REDIS_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  try {
    let discoveryResponse;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        discoveryResponse = await fetch(`${url}/api`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(discoveryResponse?.status, 200);
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.specifications.openapi.url, '/api/openapi.json');
    assert.equal(discovery.transports.socketIo.path, '/socket.io');
    assert.equal(discovery.transports.socketIo.clientEvents['call:start'].payload.availabilityPolicy, 'reject | queue (default reject)');

    const specificationResponse = await fetch(`${url}/api/openapi.json`);
    assert.equal(specificationResponse.status, 200);
    assert.equal(specificationResponse.headers.get('access-control-allow-origin'), '*');
    const specification = await specificationResponse.json();
    assert.equal(specification.openapi, '3.1.0');
    assert.ok(specification.paths['/api/calls'].post);
    assert.ok(specification.paths['/api/capacity'].get);
    assert.equal(specification.paths['/api/calls'].get, undefined);
    assert.equal(specification.components.schemas.CreateCallRequest.properties.availabilityPolicy.default, 'reject');
    for (const path of [
      '/api/endpoints/{endpointId}/incoming',
      '/api/calls/{callId}/signals/{recipient}',
      '/api/calls/{callId}/transcripts',
      '/api/calls/{callId}/assets',
      '/api/calls/{callId}/media',
      '/api/calls/{callId}/recording',
      '/api/recordings',
    ]) assert.equal(specification.paths[path], undefined, `${path} must not be published`);
    assert.equal(specification.components.securitySchemes, undefined);
    assert.equal(specification['x-socketio-contract'].clientEvents['call:start'].roles[0], 'caller');

    const preflight = await fetch(`${url}/api/calls/00000000-0000-0000-0000-000000000000/transcripts`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://agent.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);

    const operationalRoute = await fetch(`${url}/api/numbers`);
    assert.equal(operationalRoute.status, 503);
    const capacityRoute = await fetch(`${url}/api/capacity`);
    assert.equal(capacityRoute.status, 503);
    const internalDocument = await fetch(`${url}/INTERNAL_API.md`);
    assert.equal(internalDocument.status, 404);
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('phone endpoint accepts a caller and relays WebRTC signaling for a simulated number', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });
  const clients = [];

  try {
    let phone;
    let caller;
    let stranger;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        phone = await connectClient(url);
        clients.push(phone);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(phone, `server should accept a Socket.IO connection; startup error: ${childError || 'none'}`);

    const phoneReady = waitFor(phone, 'participant:registered');
    phone.emit('participant:register', { role: 'phone' });
    const registration = (await phoneReady)[0];
    assert.equal(registration.role, 'phone');
    assert.match(registration.endpointId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(await fetch(`${url}/api/capacity`).then((response) => response.json()), {
      onlineMachines: 1,
      availableMachines: 1,
      busyMachines: 0,
      queuedCalls: 0,
      canLaunchCall: true,
    });

    caller = await connectClient(url);
    clients.push(caller);
    const callerReady = waitFor(caller, 'participant:registered');
    caller.emit('participant:register', { role: 'caller', mediaSource: 'human-pc' });
    await callerReady;

    stranger = await connectClient(url);
    clients.push(stranger);
    const strangerReady = waitFor(stranger, 'participant:registered');
    stranger.emit('participant:register', { role: 'caller', mediaSource: 'human-pc' });
    await strangerReady;

    const outgoingCall = waitFor(caller, 'call:outgoing');
    const incomingCall = waitFor(phone, 'call:incoming');
    caller.emit('call:start', { number: '+1 (555) 123-4567' });
    const [outgoing, incoming] = await Promise.all([outgoingCall, incomingCall]);
    const callId = outgoing[0].callId;
    assert.equal(outgoing[0].number, '+15551234567');
    assert.equal(incoming[0].callId, callId);
    assert.equal(incoming[0].caller, 'PC caller');
    assert.equal(incoming[0].number, '+15551234567');
    assert.deepEqual(await fetch(`${url}/api/capacity`).then((response) => response.json()), {
      onlineMachines: 1,
      availableMachines: 0,
      busyMachines: 1,
      queuedCalls: 0,
      canLaunchCall: false,
    });
    const polledIncoming = await fetch(`${url}/api/endpoints/${registration.endpointId}/incoming`).then((response) => response.json());
    assert.equal(polledIncoming.call.callId, callId);

    const callerAccepted = waitFor(caller, 'call:accepted');
    const phoneAccepted = waitFor(phone, 'call:accepted');
    phone.emit('call:accept', { callId });
    await Promise.all([callerAccepted, phoneAccepted]);

    const unauthorizedSignal = waitFor(stranger, 'call:error');
    stranger.emit('rtc:offer', { callId, description: { type: 'offer', sdp: 'not-a-participant' } });
    assert.equal((await unauthorizedSignal)[0].code, 'CALL_NOT_FOUND');

    const relayedOffer = waitFor(phone, 'rtc:offer');
    caller.emit('rtc:offer', { callId, description: { type: 'offer', sdp: 'test-sdp' } });
    assert.deepEqual((await relayedOffer)[0].description, { type: 'offer', sdp: 'test-sdp' });

    const callEnded = waitFor(caller, 'call:ended');
    phone.emit('call:end', { callId });
    assert.equal((await callEnded)[0].reason, 'ended');
    assert.equal((await fetch(`${url}/api/capacity`).then((response) => response.json())).canLaunchCall, true);

    const callRecord = await fetch(`${url}/api/calls/${callId}`).then((response) => response.json());
    assert.equal(callRecord.recording.mode, 'browser-download');
    assert.equal(callRecord.recording.status, 'not-downloaded');
    const savedRecording = await fetch(`${url}/api/calls/${callId}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `ringio-call-${callId}.webm`, mimeType: 'audio/webm', bytes: 2048, durationMs: 1200 }),
    });
    assert.equal(savedRecording.status, 200);
    const recordingMetadata = await savedRecording.json();
    assert.equal(recordingMetadata.storage, 'caller-device');
    assert.equal(recordingMetadata.status, 'downloaded');
    assert.equal(recordingMetadata.bytes, 2048);

    const health = await fetch(`${url}/health`).then((response) => response.json());
    assert.equal(health.activeCalls, 0);
    assert.equal(health.mobileAppsOnline, 1);
  } finally {
    clients.forEach((client) => client.disconnect());
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('agent caller rings the phone and relays WebRTC offer and answer', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const clients = [];

  try {
    let phone;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        phone = await connectClient(url);
        clients.push(phone);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(phone, 'server should accept a phone Socket.IO connection');

    const phoneReady = waitFor(phone, 'participant:registered');
    phone.emit('participant:register', { role: 'phone' });
    await phoneReady;

    const agent = await connectClient(url);
    clients.push(agent);
    const agentReady = waitFor(agent, 'participant:registered');
    agent.emit('participant:register', { role: 'agent', mediaSource: 'mock-webrtc-audio' });
    await agentReady;

    const outgoingCall = waitFor(agent, 'call:outgoing');
    const incomingCall = waitFor(phone, 'call:incoming');
    agent.emit('call:start', { number: '+15559876543' });
    const [outgoing, incoming] = await Promise.all([outgoingCall, incomingCall]);
    const callId = outgoing[0].callId;
    assert.equal(outgoing[0].number, '+15559876543');
    assert.equal(incoming[0].callId, callId);
    assert.equal(incoming[0].number, '+15559876543');
    assert.equal(incoming[0].caller, 'AI agent');

    const agentAccepted = waitFor(agent, 'call:accepted');
    const phoneAccepted = waitFor(phone, 'call:accepted');
    phone.emit('call:accept', { callId });
    await Promise.all([agentAccepted, phoneAccepted]);

    const relayedOffer = waitFor(phone, 'rtc:offer');
    agent.emit('rtc:offer', { callId, description: { type: 'offer', sdp: 'mock-agent-audio-offer' } });
    assert.deepEqual((await relayedOffer)[0].description, { type: 'offer', sdp: 'mock-agent-audio-offer' });

    const relayedAnswer = waitFor(agent, 'rtc:answer');
    phone.emit('rtc:answer', { callId, description: { type: 'answer', sdp: 'mock-phone-audio-answer' } });
    assert.deepEqual((await relayedAnswer)[0].description, { type: 'answer', sdp: 'mock-phone-audio-answer' });

    const ended = waitFor(agent, 'call:ended');
    phone.emit('call:end', { callId });
    assert.equal((await ended)[0].reason, 'ended');
  } finally {
    clients.forEach((client) => client.disconnect());
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('caller can reject or queue when all mobile apps are busy', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const clients = [];

  try {
    const connect = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const client = await connectClient(url);
          clients.push(client);
          return client;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error('Server did not accept a Socket.IO connection.');
    };
    const phoneA = await connect();
    const phoneB = await connect();
    const callerA = await connect();
    const callerB = await connect();
    const callerC = await connect();
    const register = async (client, details) => {
      const ready = waitFor(client, 'participant:registered');
      client.emit('participant:register', details);
      await ready;
    };
    await register(phoneA, { role: 'phone' });
    await register(phoneB, { role: 'phone' });
    await Promise.all([callerA, callerB, callerC].map((caller) => register(caller, {
      role: 'agent',
      mediaSource: 'mock-webrtc-audio',
    })));

    const firstRing = Promise.race([
      waitFor(phoneA, 'call:incoming').then(([payload]) => ({ phone: phoneA, payload })),
      waitFor(phoneB, 'call:incoming').then(([payload]) => ({ phone: phoneB, payload })),
    ]);
    const firstOutgoing = waitFor(callerA, 'call:outgoing');
    callerA.emit('call:start', { number: '+15550000001' });
    const [firstRingResult, firstOutgoingResult] = await Promise.all([firstRing, firstOutgoing]);
    const busyPhone = firstRingResult.phone;
    const firstCallId = firstOutgoingResult[0].callId;
    const availablePhone = busyPhone === phoneA ? phoneB : phoneA;

    const secondIncoming = waitFor(availablePhone, 'call:incoming');
    const secondOutgoing = waitFor(callerB, 'call:outgoing');
    callerB.emit('call:start', { number: '+15550000002' });
    await Promise.all([secondIncoming, secondOutgoing]);

    const unavailableError = waitFor(callerC, 'call:error');
    callerC.emit('call:start', { number: '+15550000003', availabilityPolicy: 'reject' });
    assert.equal((await unavailableError)[0].code, 'APPS_UNAVAILABLE');

    const queuedEvent = waitFor(callerC, 'call:queued');
    callerC.emit('call:start', { number: '+15550000004', availabilityPolicy: 'queue' });
    const queuedCall = (await queuedEvent)[0];
    assert.equal(queuedCall.number, '+15550000004');
    assert.deepEqual(await fetch(`${url}/api/capacity`).then((response) => response.json()), {
      onlineMachines: 2,
      availableMachines: 0,
      busyMachines: 2,
      queuedCalls: 1,
      canLaunchCall: false,
    });

    const queuedIncoming = waitFor(busyPhone, 'call:incoming');
    const queuedOutgoing = waitFor(callerC, 'call:outgoing');
    busyPhone.emit('call:end', { callId: firstCallId });
    const [incoming, outgoing] = await Promise.all([queuedIncoming, queuedOutgoing]);
    assert.equal(incoming[0].callId, queuedCall.callId);
    assert.equal(incoming[0].number, '+15550000004');
    assert.equal(outgoing[0].number, '+15550000004');
  } finally {
    clients.forEach((client) => client.disconnect());
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('phone and caller can reconnect to active call via call:reconnect without call interruption', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const clients = [];

  try {
    let phone;
    let caller;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        phone = await connectClient(url);
        clients.push(phone);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const phoneRegistered = waitFor(phone, 'participant:registered');
    phone.emit('participant:register', { role: 'phone' });
    await phoneRegistered;

    caller = await connectClient(url);
    clients.push(caller);
    const callerRegistered = waitFor(caller, 'participant:registered');
    caller.emit('participant:register', { role: 'caller', mediaSource: 'human-pc' });
    await callerRegistered;

    const incomingEvent = waitFor(phone, 'call:incoming');
    const outgoingEvent = waitFor(caller, 'call:outgoing');
    caller.emit('call:start', { number: '+15550001234' });
    const [outgoing] = await Promise.all([outgoingEvent, incomingEvent]);
    const callId = outgoing[0].callId;

    const acceptedEvent = waitFor(caller, 'call:accepted');
    phone.emit('call:accept', { callId });
    await acceptedEvent;

    caller.emit('call:active', { callId });
    await new Promise((resolve) => setTimeout(resolve, 50));

    let callRecord = await fetch(`${url}/api/calls/${callId}`).then((r) => r.json());
    assert.equal(callRecord.status, 'active');

    // Simulate caller socket dropping (e.g. Vercel maxDuration 60s timeout)
    caller.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Active session should be PRESERVED
    callRecord = await fetch(`${url}/api/calls/${callId}`).then((r) => r.json());
    assert.equal(callRecord.status, 'active');

    // Caller reconnects with a fresh socket
    const newCaller = await connectClient(url);
    clients.push(newCaller);
    const reconnectedEvent = waitFor(newCaller, 'call:reconnected');
    newCaller.emit('call:reconnect', { callId, role: 'caller' });
    const [reconnected] = await reconnectedEvent;
    assert.equal(reconnected.callId, callId);
    assert.equal(reconnected.state, 'ACTIVE');

    // New caller can send ICE signal and phone receives it
    const iceEvent = waitFor(phone, 'rtc:ice');
    newCaller.emit('rtc:ice', { callId, candidate: { candidate: 'candidate:reconnected' } });
    const [receivedIce] = await iceEvent;
    assert.equal(receivedIce.candidate.candidate, 'candidate:reconnected');

    // Simulate phone socket dropping and reconnecting
    phone.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    callRecord = await fetch(`${url}/api/calls/${callId}`).then((r) => r.json());
    assert.equal(callRecord.status, 'active');

    const newPhone = await connectClient(url);
    clients.push(newPhone);
    const phoneReconnectedEvent = waitFor(newPhone, 'call:reconnected');
    newPhone.emit('call:reconnect', { callId, role: 'phone' });
    await phoneReconnectedEvent;

    // Phone ends call from reconnected socket
    const callerEndedEvent = waitFor(newCaller, 'call:ended');
    newPhone.emit('call:end', { callId });
    await callerEndedEvent;

    callRecord = await fetch(`${url}/api/calls/${callId}`).then((r) => r.json());
    assert.equal(callRecord.status, 'ended');
  } finally {
    clients.forEach((client) => client.disconnect());
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('REST API exposes number inventory, available targets, and recording metadata', { timeout: 15000 }, async () => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), INTERNAL_AGENT_TOKEN: 'integration-agent-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });
  const clients = [];

  try {
    let phone;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        phone = await connectClient(url);
        clients.push(phone);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(phone, `server should accept a Socket.IO connection; startup error: ${childError || 'none'}`);

    const phoneReady = waitFor(phone, 'participant:registered');
    phone.emit('participant:register', { role: 'phone' });
    const { endpointId } = (await phoneReady)[0];

    const numbers = await fetch(`${url}/api/numbers`).then((response) => response.json());
    assert.equal(numbers.length, 1);
    assert.equal(numbers[0].status, 'online');
    assert.equal(numbers[0].available, true);

    const available = await fetch(`${url}/api/available-numbers`).then((response) => response.json());
    assert.equal(available.length, 1);
    assert.equal(available[0].status, 'online');

    const preflight = await fetch(`${url}/api/calls`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const createCallResponse = await fetch(`${url}/api/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: {
          role: 'agent',
          mediaSource: 'tts',
          type: 'caller',
          metadata: { name: 'AI Sales Agent' },
        },
        to: { type: 'mobile', number: '+15551230000' },
        availabilityPolicy: 'reject',
        recording: {
          enabled: true,
          mode: 'server-side',
          recordBothSides: true,
          format: 'wav',
          storage: 'local',
        },
      }),
    });

    assert.equal(createCallResponse.status, 201);
    const createdCall = await createCallResponse.json();
    assert.equal(createdCall.status, 'ringing');
    assert.equal(createdCall.recording.enabled, false);
    assert.equal(createdCall.recording.mode, 'browser-download');
    assert.equal(createdCall.recording.status, 'browser-participant-required');
    assert.deepEqual(createdCall.to, { type: 'mobile', number: '+15551230000' });

    const callRecord = await fetch(`${url}/api/calls/${createdCall.callId}`).then((response) => response.json());
    assert.equal(callRecord.callId, createdCall.callId);
    assert.equal(callRecord.status, 'ringing');
    assert.equal(Object.hasOwn(callRecord, 'transcripts'), false);

    const transcriptPath = `${url}/api/calls/${createdCall.callId}/transcripts`;
    const unauthorizedTranscript = await fetch(transcriptPath, { method: 'POST' });
    assert.equal(unauthorizedTranscript.status, 401);
    const agentHeaders = {
      Authorization: 'Bearer integration-agent-token',
      'Content-Type': 'application/json',
    };
    for (const [speaker, text] of [['agent', 'عسلامة، أنا مساعدك الصوتي.'], ['mobile', 'عسلامة.']]) {
      const response = await fetch(transcriptPath, {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ speaker, text }),
      });
      assert.equal(response.status, 201);
    }
    const transcriptResponse = await fetch(transcriptPath, { headers: agentHeaders });
    assert.equal(transcriptResponse.status, 200);
    const transcripts = await transcriptResponse.json();
    assert.deepEqual(transcripts.map(({ speaker, sequence }) => ({ speaker, sequence })), [
      { speaker: 'agent', sequence: 1 },
      { speaker: 'mobile', sequence: 2 },
    ]);

    const assetsPath = `${url}/api/calls/${createdCall.callId}/assets`;
    const assets = [{
      speaker: 'mobile', fileName: 'mobile.wav', contentType: 'audio/wav',
      bytes: 2048, durationMs: 1000, sampleRate: 16000, channelCount: 1,
    }, {
      speaker: 'agent', fileName: 'agent.wav', contentType: 'audio/wav',
      bytes: 4096, durationMs: 1500, sampleRate: 24000, channelCount: 1,
    }];
    const saveAssetsResponse = await fetch(assetsPath, {
      method: 'POST', headers: agentHeaders, body: JSON.stringify({ assets }),
    });
    assert.equal(saveAssetsResponse.status, 201);
    const assetsResponse = await fetch(assetsPath, { headers: agentHeaders });
    assert.deepEqual((await assetsResponse.json()).map(({ speaker }) => speaker), ['mobile', 'agent']);

    const recordingResponse = await fetch(`${url}/api/calls/${createdCall.callId}/recording`);
    assert.equal(recordingResponse.status, 404);

    const recordings = await fetch(`${url}/api/recordings`).then((response) => response.json());
    assert.ok(!recordings.some((entry) => entry.callId === createdCall.callId));

    const mediaResponse = await fetch(`${url}/api/calls/${createdCall.callId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: 'agent-1',
        role: 'agent',
        mediaSource: 'tts',
        kind: 'ai-audio',
        payload: { text: 'Hello from the AI agent' },
      }),
    });

    assert.equal(mediaResponse.status, 201);
    const mediaEvent = await mediaResponse.json();
    assert.equal(mediaEvent.kind, 'ai-audio');
    assert.equal(mediaEvent.role, 'agent');

    const callWithMedia = await fetch(`${url}/api/calls/${createdCall.callId}`).then((response) => response.json());
    assert.ok(Array.isArray(callWithMedia.media.events));
    assert.equal(callWithMedia.media.events[0].kind, 'ai-audio');

    phone.disconnect();
    let disconnectedCall;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      disconnectedCall = await fetch(`${url}/api/calls/${createdCall.callId}`).then((response) => response.json());
      if (disconnectedCall.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(disconnectedCall.status, 'failed');
    assert.equal(disconnectedCall.disconnectedParticipantRole, 'phone');
    const endResponse = await fetch(`${url}/api/calls/${createdCall.callId}/end`, { method: 'POST' });
    assert.equal(endResponse.status, 200);
    const endedCall = await fetch(`${url}/api/calls/${createdCall.callId}`).then((response) => response.json());
    assert.equal(endedCall.status, 'ended');

    const rejectedCallResponse = await fetch(`${url}/api/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { number: '+15551239999' }, availabilityPolicy: 'reject' }),
    });
    assert.equal(rejectedCallResponse.status, 503);
    assert.equal((await rejectedCallResponse.json()).code, 'APPS_UNAVAILABLE');

    const queuedCallResponse = await fetch(`${url}/api/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: { number: '+15551239998' }, availabilityPolicy: 'queue' }),
    });
    assert.equal(queuedCallResponse.status, 201);
    const queuedCall = await queuedCallResponse.json();
    assert.equal(queuedCall.status, 'queued');
    const cancelQueuedResponse = await fetch(`${url}/api/calls/${queuedCall.callId}/end`, { method: 'POST' });
    assert.equal(cancelQueuedResponse.status, 200);
    const health = await fetch(`${url}/health`).then((response) => response.json());
    assert.equal(health.queuedCalls, 0);
  } finally {
    clients.forEach((client) => client.disconnect());
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});

test('Vercel shares live call signaling and recording metadata through Redis', {
  skip: !process.env.VOIP_E2E_URL,
  timeout: 30000,
}, async () => {
  const url = process.env.VOIP_E2E_URL.replace(/\/$/, '');
  const phone = await connectClient(url, 10000);
  const caller = await connectClient(url, 10000);
  const number = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const register = (socket, details) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for participant registration')), 10000);
    socket.once('participant:registered', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    socket.once('call:error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Registration failed: ${error.code} ${error.message}`));
    });
    socket.emit('participant:register', details);
  });

  try {
    const registration = await register(phone, { role: 'phone' });
    await register(caller, { role: 'caller', mediaSource: 'human-pc' });

    const outgoingEvent = waitFor(caller, 'call:outgoing', 10000);
    caller.emit('call:start', { number });
    const outgoing = (await outgoingEvent)[0];
    assert.equal(outgoing.number, number);
    const incomingResponse = await fetch(`${url}/api/endpoints/${registration.endpointId}/incoming`);
    assert.equal(incomingResponse.status, 200);
    const incoming = (await incomingResponse.json()).call;
    assert.equal(incoming.callId, outgoing.callId);

    const phoneAccepted = waitFor(phone, 'call:accepted');
    phone.emit('call:accept', { callId: outgoing.callId });
    await phoneAccepted;
    const acceptedCall = await fetch(`${url}/api/calls/${outgoing.callId}`).then((response) => response.json());
    assert.equal(acceptedCall.status, 'accepted');

    const readSignal = async (recipient, offset) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(`${url}/api/calls/${outgoing.callId}/signals/${recipient}?offset=${offset}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        if (result.events.length) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for ${recipient} signal at offset ${offset}`);
    };

    caller.emit('rtc:offer', { callId: outgoing.callId, description: { type: 'offer', sdp: 'vercel-e2e' } });
    const offerQueue = await readSignal('phone', 0);
    assert.equal(offerQueue.events[0].eventName, 'rtc:offer');
    assert.equal(offerQueue.events[0].payload.description.sdp, 'vercel-e2e');

    phone.emit('rtc:answer', { callId: outgoing.callId, description: { type: 'answer', sdp: 'vercel-answer' } });
    const answerQueue = await readSignal('caller', 0);
    assert.equal(answerQueue.events[0].eventName, 'rtc:answer');
    assert.equal(answerQueue.events[0].payload.description.sdp, 'vercel-answer');

    caller.emit('rtc:ice', { callId: outgoing.callId, candidate: { candidate: 'vercel-candidate' } });
    const iceQueue = await readSignal('phone', 1);
    assert.equal(iceQueue.events[0].eventName, 'rtc:ice');
    assert.equal(iceQueue.events[0].payload.candidate.candidate, 'vercel-candidate');

    phone.emit('call:end', { callId: outgoing.callId });
    let endedCall;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      endedCall = await fetch(`${url}/api/calls/${outgoing.callId}`).then((response) => response.json());
      if (endedCall.status === 'ended') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(endedCall.status, 'ended');

    const metadataResponse = await fetch(`${url}/api/calls/${outgoing.callId}/recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'ringio-e2e.webm', mimeType: 'audio/webm', bytes: 1234, durationMs: 1000 }),
    });
    assert.equal(metadataResponse.status, 200);

    const callRecord = await fetch(`${url}/api/calls/${outgoing.callId}`).then((response) => response.json());
    const recording = await fetch(`${url}/api/calls/${outgoing.callId}/recording`).then((response) => response.json());
    const callHistory = await fetch(`${url}/api/calls`).then((response) => response.json());
    assert.equal(callRecord.status, 'ended');
    assert.ok(callHistory.some((entry) => entry.callId === outgoing.callId));
    assert.equal(recording.status, 'downloaded');
    assert.equal(recording.storage, 'caller-device');
    assert.equal(recording.bytes, 1234);
  } finally {
    phone.disconnect();
    caller.disconnect();
  }
});