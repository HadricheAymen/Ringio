const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  bufferToInt16,
  chunkPcm,
  int16ToBuffer,
  mixToMono,
  resamplePcm16,
} = require('../audioPcm');

test('mixes interleaved stereo PCM to mono', () => {
  assert.deepEqual([...mixToMono(new Int16Array([100, -100, 200, 100]), 2)], [0, 150]);
});

test('resamples 48 kHz PCM to Gemini 16 kHz input', () => {
  const output = resamplePcm16(new Int16Array([0, 300, 600, 900, 1200, 1500]), 48000, 16000);
  assert.equal(output.length, 2);
  assert.deepEqual([...output], [0, 900]);
});

test('resamples Gemini 24 kHz output to 48 kHz WebRTC PCM', () => {
  const output = resamplePcm16(new Int16Array([0, 1200, 2400]), 24000, 48000);
  assert.equal(output.length, 6);
  assert.deepEqual([...output], [0, 600, 1200, 1800, 2400, 2400]);
});

test('chunks PCM into zero-padded 10 ms audio frames', () => {
  const chunks = chunkPcm(new Int16Array([1, 2, 3]), 24000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].samples.length, 240);
  assert.equal(chunks[0].numberOfFrames, 240);
  assert.deepEqual([...chunks[0].samples.slice(0, 4)], [1, 2, 3, 0]);
});

test('round trips signed PCM16 bytes in little-endian order', () => {
  const original = new Int16Array([-32768, -1, 0, 1, 32767]);
  const bytes = int16ToBuffer(original);
  assert.deepEqual(bytes, Buffer.from([0, 128, 255, 255, 0, 0, 1, 0, 255, 127]));
  assert.deepEqual([...bufferToInt16(bytes)], [...original]);
  assert.throws(() => bufferToInt16(Buffer.from([1])), /even/);
});