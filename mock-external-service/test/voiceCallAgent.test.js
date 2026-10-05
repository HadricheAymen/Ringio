const assert = require('node:assert/strict');
const { test } = require('node:test');
const { VoiceCallAgent } = require('../voiceCallAgent');

const callId = '12345678-abcd-1234-abcd-123456789abc';

class FakeSocket {
  constructor() {
    this.connected = true;
    this.handlers = new Map();
    this.emitted = [];
    this.io = {
      handlers: new Map(),
      on: (event, callback) => {
        const handlers = this.io.handlers.get(event) || [];
        handlers.push(callback);
        this.io.handlers.set(event, handlers);
      },
      receive: (event, payload) => {
        for (const callback of this.io.handlers.get(event) || []) callback(payload);
      },
    };
  }

  on(event, callback) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(callback);
    this.handlers.set(event, handlers);
  }

  emit(event, payload) {
    this.emitted.push({ event, payload });
  }

  receive(event, payload) {
    for (const callback of this.handlers.get(event) || []) callback(payload);
  }

  disconnect() {
    this.connected = false;
  }
}

test('completes a simulated mobile call with Gemini greeting first and two-way audio', async () => {
  const socket = new FakeSocket();
  let peer;
  let bridgeOptions;
  let geminiListener;
  let introductionCount = 0;
  const sentAudio = [];
  const playedAudio = [];
  const transcripts = [];
  const lifecycle = [];
  const statuses = [];

  class FakePeerConnection {
    constructor() {
      peer = this;
      this.connectionState = 'new';
      this.remoteDescription = null;
    }

    async createOffer() {
      return { type: 'offer', sdp: 'mobile-call-offer' };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async addIceCandidate(candidate) {
      lifecycle.push(['ice', candidate]);
    }

    close() {
      lifecycle.push(['peer-closed']);
    }
  }

  const agent = new VoiceCallAgent({
    serverUrl: 'http://call-server.test',
    destinationNumber: '+15550001234',
    ioClient: () => socket,
    wrtc: {
      RTCPeerConnection: FakePeerConnection,
      RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
      RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
    },
    geminiFactory: async () => ({
      onEvent(callback) {
        geminiListener = callback;
        return () => { lifecycle.push(['gemini-listener-removed']); };
      },
      introduce() {
        introductionCount += 1;
        lifecycle.push(['introduced']);
      },
      sendAudio(samples, sampleRate) {
        sentAudio.push({ samples, sampleRate });
      },
      close() {
        lifecycle.push(['gemini-closed']);
      },
    }),
    artifactStore: {
      async finalizeCall(id) {
        lifecycle.push(['finalized', id]);
        return [{ speaker: 'agent', fileName: 'agent.wav' }];
      },
    },
    artifactClient: {
      async appendTranscript(id, transcript) {
        transcripts.push({ id, ...transcript });
      },
      async saveAudioAssets(id, assets) {
        lifecycle.push(['assets-saved', id, assets]);
      },
    },
    onStatus: (phase) => statuses.push(phase),
    mediaBridgeFactory: (options) => {
      bridgeOptions = options;
      return {
        enqueueGeminiAudio(audio, sampleRate) {
          playedAudio.push({ audio, sampleRate });
        },
        flushOutput() {
          lifecycle.push(['output-flushed']);
        },
        async waitForOutputDrain() {},
        stopOutput() {},
        async close() {
          lifecycle.push(['bridge-closed']);
        },
      };
    },
    logger: { info() {}, warn() {}, error(message) { throw new Error(message); } },
  });

  const finishPromise = agent.start();
  socket.receive('connect');
  socket.receive('participant:registered');
  socket.receive('call:outgoing', { callId, number: '+15550001234' });

  for (let attempt = 0; attempt < 20 && !geminiListener; attempt += 1) await new Promise(setImmediate);
  assert.ok(geminiListener, 'Gemini is prepared while the phone is still ringing');
  assert.equal(introductionCount, 0, 'the agent waits to greet until the media connection is ready');

  socket.receive('call:accepted');

  for (let attempt = 0; attempt < 20 && !socket.emitted.some(({ event }) => event === 'rtc:offer'); attempt += 1) {
    await new Promise(setImmediate);
  }
  assert.ok(socket.emitted.some(({ event, payload }) => event === 'participant:register' && payload.role === 'agent'));
  assert.ok(socket.emitted.some(({ event, payload }) => event === 'call:start' && payload.number === '+15550001234'));
  assert.ok(socket.emitted.some(({ event, payload }) => event === 'rtc:offer' && payload.callId === callId));

  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  for (let attempt = 0; attempt < 20 && introductionCount === 0; attempt += 1) await new Promise(setImmediate);
  assert.equal(introductionCount, 1);

  bridgeOptions.onMobileAudio(new Int16Array([1, 2]));
  assert.equal(sentAudio.length, 0, 'mobile audio stays gated until the introduction completes');

  geminiListener({ type: 'output-audio', audio: Buffer.from([1, 2]), mimeType: 'audio/pcm;rate=24000' });
  geminiListener({ type: 'turn-complete' });
  for (let attempt = 0; attempt < 20 && !agent.greetingComplete; attempt += 1) await new Promise(setImmediate);
  assert.equal(agent.greetingComplete, true);

  bridgeOptions.onMobileAudio(new Int16Array([3, 4]));
  assert.equal(sentAudio.length, 1);
  assert.equal(sentAudio[0].sampleRate, 16000);
  assert.deepEqual([...sentAudio[0].samples], [3, 4]);
  assert.deepEqual(playedAudio, [{ audio: Buffer.from([1, 2]), sampleRate: 24000 }]);

  geminiListener({ type: 'transcript', speaker: 'mobile', text: 'عسلامة' });
  for (let attempt = 0; attempt < 20 && transcripts.length === 0; attempt += 1) await new Promise(setImmediate);
  assert.deepEqual(transcripts, [{ id: callId, type: 'transcript', speaker: 'mobile', text: 'عسلامة' }]);

  socket.receive('call:ended', { reason: 'completed' });
  const result = await finishPromise;
  assert.equal(result.callId, callId);
  assert.equal(socket.connected, false);
  assert.ok(lifecycle.some(([event]) => event === 'peer-closed'));
  assert.ok(lifecycle.some(([event]) => event === 'gemini-closed'));
  assert.ok(lifecycle.some(([event]) => event === 'bridge-closed'));
  assert.ok(lifecycle.findIndex(([event]) => event === 'peer-closed') < lifecycle.findIndex(([event]) => event === 'bridge-closed'));
  assert.ok(lifecycle.some(([event]) => event === 'assets-saved'));
  assert.deepEqual(statuses, [
    'connecting',
    'registering',
    'dialing',
    'ringing',
    'connecting',
    'starting_gemini',
    'greeting',
    'live',
    'ending',
    'ended',
  ]);
});

test('survives transient socket disconnect and reconnect during an active call', async () => {
  const socket = new FakeSocket();
  const agent = new VoiceCallAgent({
    serverUrl: 'http://call-server.test',
    destinationNumber: '+15550001234',
    ioClient: () => socket,
    wrtc: {
      RTCPeerConnection: class {
        async createOffer() { return { type: 'offer', sdp: 'offer' }; }
        async setLocalDescription() {}
        close() {}
      },
      RTCSessionDescription: class {},
      RTCIceCandidate: class {},
    },
    geminiFactory: async () => ({ onEvent() { return () => {}; }, introduce() {}, close() {} }),
    artifactStore: { async finalizeCall() { return []; } },
    artifactClient: { async appendTranscript() {}, async saveAudioAssets() {} },
    mediaBridgeFactory: () => ({ async close() {} }),
    logger: { info() {}, warn() {}, error() {} },
  });

  const finishPromise = agent.start();
  socket.receive('connect');
  socket.receive('participant:registered');
  socket.receive('call:outgoing', { callId, number: '+15550001234' });
  socket.receive('call:accepted');

  // Simulate transient disconnect (e.g. proxy idle timeout or transport close)
  socket.receive('disconnect', 'transport close');
  // Interim reconnect error should not terminate the call
  socket.receive('connect_error', new Error('temporarily unreachable'));
  assert.equal(agent.closing, false, 'agent should not close on transient disconnect');

  // Socket successfully reconnects
  socket.receive('connect');
  assert.equal(agent.closing, false, 'agent should remain active after socket reconnect');

  // Call finishes normally later
  socket.receive('call:ended', { reason: 'completed' });
  const result = await finishPromise;
  assert.equal(result.callId, callId);
});

test('ends call when server deliberately disconnects the socket', async () => {
  const socket = new FakeSocket();
  const agent = new VoiceCallAgent({
    serverUrl: 'http://call-server.test',
    destinationNumber: '+15550001234',
    ioClient: () => socket,
    wrtc: {
      RTCPeerConnection: class { close() {} },
      RTCSessionDescription: class {},
      RTCIceCandidate: class {},
    },
    geminiFactory: async () => ({ close() {} }),
    artifactStore: { async finalizeCall() { return []; } },
    artifactClient: { async appendTranscript() {}, async saveAudioAssets() {} },
    mediaBridgeFactory: () => ({ async close() {} }),
    logger: { info() {}, warn() {}, error() {} },
  });

  const finishPromise = agent.start();
  socket.receive('connect');
  socket.receive('disconnect', 'io server disconnect');
  const result = await finishPromise;
  assert.equal(result.message, 'Disconnected by the call server.');
});

test('ends call when reconnection attempts are exhausted', async () => {
  const socket = new FakeSocket();
  const agent = new VoiceCallAgent({
    serverUrl: 'http://call-server.test',
    destinationNumber: '+15550001234',
    ioClient: () => socket,
    wrtc: {
      RTCPeerConnection: class { close() {} },
      RTCSessionDescription: class {},
      RTCIceCandidate: class {},
    },
    geminiFactory: async () => ({ close() {} }),
    artifactStore: { async finalizeCall() { return []; } },
    artifactClient: { async appendTranscript() {}, async saveAudioAssets() {} },
    mediaBridgeFactory: () => ({ async close() {} }),
    logger: { info() {}, warn() {}, error() {} },
  });

  const finishPromise = agent.start();
  socket.receive('connect');
  socket.receive('disconnect', 'transport close');
  socket.receive('reconnect_failed');
  const result = await finishPromise;
  assert.equal(result.message, 'Call server reconnection failed.');
});