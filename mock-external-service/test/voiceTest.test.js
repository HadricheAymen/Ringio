const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generateVoiceTestWav, VOICE_TEST_PROMPT } = require('../voiceTest');

function createSession(onSpeak) {
  const listeners = new Set();
  return {
    closed: false,
    prompt: null,
    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    speak(prompt) {
      this.prompt = prompt;
      onSpeak((event) => listeners.forEach((callback) => callback(event)));
    },
    close() {
      this.closed = true;
    },
  };
}

test('generates a playable WAV from Gemini audio and closes the test session', async () => {
  const audio = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const session = createSession((emit) => {
    emit({ type: 'output-audio', audio: audio.subarray(0, 4), mimeType: 'audio/pcm;rate=24000' });
    emit({ type: 'output-audio', audio: audio.subarray(4), mimeType: 'audio/pcm;rate=24000' });
    emit({ type: 'turn-complete' });
  });

  const wav = await generateVoiceTestWav({ geminiFactory: async () => session });

  assert.equal(session.prompt, VOICE_TEST_PROMPT);
  assert.equal(session.closed, true);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), audio.length);
  assert.deepEqual(wav.subarray(44), audio);
});

test('rejects Gemini errors and closes the voice test session', async () => {
  const session = createSession((emit) => emit({ type: 'error', error: new Error('provider unavailable') }));

  await assert.rejects(
    generateVoiceTestWav({ geminiFactory: async () => session }),
    /provider unavailable/,
  );
  assert.equal(session.closed, true);
});

test('times out if Gemini never completes the test response', async () => {
  const session = createSession(() => {});

  await assert.rejects(
    generateVoiceTestWav({ geminiFactory: async () => session, timeoutMs: 5 }),
    /Timed out waiting for Gemini voice test audio/,
  );
  assert.equal(session.closed, true);
});
