const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GeminiLiveSession, MODEL, SYSTEM_INSTRUCTION, normalizeLiveMessage } = require('../geminiLiveSession');

test('normalizes input/output transcripts, audio chunks, interruption, and turn completion', () => {
  const events = normalizeLiveMessage({
    serverContent: {
      inputTranscription: { text: 'عسلامة' },
      outputTranscription: { text: 'عسلامة بيك' },
      modelTurn: { parts: [{ inlineData: { data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] },
      interrupted: true,
      turnComplete: true,
    },
  });

  assert.deepEqual(events.map(({ type }) => type), [
    'transcript', 'transcript', 'interrupted', 'output-audio', 'turn-complete',
  ]);
  assert.deepEqual(events.slice(0, 2).map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: 'mobile', text: 'عسلامة' },
    { speaker: 'agent', text: 'عسلامة بيك' },
  ]);
  assert.deepEqual(events[3].audio, Buffer.from([1, 2, 3]));
  assert.equal(events[3].mimeType, 'audio/pcm;rate=24000');
});

test('connects to Gemini Live, greets first, streams PCM, and closes', async () => {
  let callbacks;
  const sentAudio = [];
  const sessionCalls = [];
  const mockSession = {
    sendClientContent: (payload) => sessionCalls.push(['content', payload]),
    sendRealtimeInput: (payload) => sentAudio.push(payload),
    close: () => sessionCalls.push(['close']),
  };
  const client = {
    live: {
      connect: async (params) => {
        callbacks = params.callbacks;
        assert.equal(params.model, 'gemini-3.8-live');
        assert.deepEqual(params.config.responseModalities, ['AUDIO']);
        assert.equal(params.config.systemInstruction, SYSTEM_INSTRUCTION);
        assert.match(params.config.systemInstruction, /specifically Tunisian/);
        assert.match(params.config.systemInstruction, /Arabic script/);
        assert.match(params.config.systemInstruction, /French is the only language/);
        queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
        return mockSession;
      },
    },
  };

  const live = await GeminiLiveSession.connect({ client });
  assert.equal(live.model, MODEL);
  live.introduce();
  assert.equal(sessionCalls[0][0], 'content');
  assert.equal(sessionCalls[0][1].turnComplete, true);
  assert.match(sessionCalls[0][1].turns[0].parts[0].text, /distinctly Tunisian/);

  const events = [];
  live.onEvent((event) => events.push(event));
  live.sendAudio(new Int16Array([-1, 258]), 16000);
  assert.equal(sentAudio.length, 1);
  assert.equal(sentAudio[0].audio.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual(Buffer.from(sentAudio[0].audio.data, 'base64'), Buffer.from([255, 255, 2, 1]));

  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'لاباس' }, turnComplete: true } });
  assert.deepEqual(events.map((event) => event.type), ['transcript', 'turn-complete']);
  live.endAudioStream();
  assert.deepEqual(sentAudio[1], { audioStreamEnd: true });
  live.close();
  assert.deepEqual(sessionCalls.at(-1), ['close']);
});

test('requires an API key unless a client adapter is injected', async () => {
  await assert.rejects(GeminiLiveSession.connect({ apiKey: '' }), /GEMINI_API_KEY is required/);
});