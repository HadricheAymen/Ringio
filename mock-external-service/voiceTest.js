const { createWavHeader } = require('./audioArtifactStore');
const { GeminiLiveSession } = require('./geminiLiveSession');

const VOICE_TEST_PROMPT = 'Say clearly in Tunisian Derja: عسلامة، هذا اختبار صوت Ringio. تسمعني واضح؟';
const DEFAULT_SAMPLE_RATE = 24000;
const TIMEOUT_MS = 20000;

async function generateVoiceTestWav({
  geminiFactory = () => GeminiLiveSession.connect(),
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const gemini = await geminiFactory();
  const audioChunks = [];
  let sampleRate = null;
  let removeListener;
  let timer;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      timer = setTimeout(() => finish(new Error('Timed out waiting for Gemini voice test audio.')), timeoutMs);
      removeListener = gemini.onEvent((event) => {
        if (event.type === 'output-audio') {
          const eventRate = Number(/rate=(\d+)/.exec(event.mimeType || '')?.[1]) || DEFAULT_SAMPLE_RATE;
          if (!Number.isInteger(eventRate) || eventRate < 8000) {
            finish(new Error('Gemini returned an unsupported audio sample rate.'));
            return;
          }
          if (sampleRate !== null && sampleRate !== eventRate) {
            finish(new Error('Gemini changed audio sample rate during the voice test.'));
            return;
          }
          sampleRate = eventRate;
          audioChunks.push(Buffer.isBuffer(event.audio) ? event.audio : Buffer.from(event.audio));
        } else if (event.type === 'turn-complete') {
          finish();
        } else if (event.type === 'error' || event.type === 'closed') {
          finish(event.error instanceof Error ? event.error : new Error('Gemini voice test session failed.'));
        }
      });

      try {
        gemini.speak(VOICE_TEST_PROMPT);
      } catch (error) {
        finish(error);
      }
    });

    if (!audioChunks.length) throw new Error('Gemini completed the voice test without returning audio.');
    const audio = Buffer.concat(audioChunks);
    if (audio.length % 2 !== 0) throw new Error('Gemini returned incomplete PCM audio data.');
    const header = createWavHeader({ dataBytes: audio.length, sampleRate: sampleRate || DEFAULT_SAMPLE_RATE, channelCount: 1 });
    return Buffer.concat([header, audio]);
  } finally {
    clearTimeout(timer);
    removeListener?.();
    gemini.close();
  }
}

module.exports = { generateVoiceTestWav, VOICE_TEST_PROMPT };
