const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AudioArtifactStore } = require('../audioArtifactStore');

test('writes finalized per-speaker WAV files and deletes call artifacts', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ringio-audio-'));
  const store = new AudioArtifactStore({ rootDir });
  const callId = '12345678-abcd-1234-abcd-123456789abc';

  try {
    await store.appendPcm({ callId, speaker: 'mobile', samples: new Int16Array([-1, 0, 1, 32767]), sampleRate: 16000 });
    await store.appendPcm({ callId, speaker: 'agent', samples: new Int16Array([100, 200]), sampleRate: 24000 });
    const assets = await store.finalizeCall(callId);

    assert.equal(assets.length, 2);
    const mobile = assets.find((asset) => asset.speaker === 'mobile');
    assert.equal(mobile.fileName, 'mobile.wav');
    assert.equal(mobile.contentType, 'audio/wav');
    assert.equal(mobile.bytes, 52);
    assert.equal(mobile.durationMs, 0);

    const wav = await fs.readFile(path.join(rootDir, callId, mobile.fileName));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt32LE(40), 8);
    assert.deepEqual([...wav.subarray(44)], [255, 255, 0, 0, 1, 0, 255, 127]);

    await store.deleteCall(callId);
    await assert.rejects(fs.access(path.join(rootDir, callId)));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects path traversal and changing audio formats midstream', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ringio-audio-'));
  const store = new AudioArtifactStore({ rootDir });
  const callId = '12345678-abcd-1234-abcd-123456789abc';
  try {
    await assert.rejects(store.appendPcm({
      callId: '../outside-call-id',
      speaker: 'mobile',
      samples: new Int16Array([1]),
      sampleRate: 16000,
    }), /Invalid call ID/);
    await store.appendPcm({ callId, speaker: 'mobile', samples: new Int16Array([1]), sampleRate: 16000 });
    await assert.rejects(store.appendPcm({ callId, speaker: 'mobile', samples: new Int16Array([2]), sampleRate: 24000 }), /format changed/);
  } finally {
    await store.deleteCall(callId);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});