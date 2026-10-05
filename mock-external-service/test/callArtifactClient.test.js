const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CallArtifactClient } = require('../callArtifactClient');

test('posts transcript and WAV metadata with the internal bearer token', async () => {
  const requests = [];
  const client = new CallArtifactClient({
    serverUrl: 'https://calls.example.test/',
    token: 'private-agent-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ count: 1 }) };
    },
  });

  await client.appendTranscript('12345678-abcd-1234-abcd-123456789abc', {
    speaker: 'agent', text: 'عسلامة', timestamp: '2026-10-01T12:00:00.000Z',
  });
  await client.saveAudioAssets('12345678-abcd-1234-abcd-123456789abc', [{
    speaker: 'agent', fileName: 'agent.wav', contentType: 'audio/wav', bytes: 128, durationMs: 2,
  }]);

  assert.match(requests[0].url, /\/transcripts$/);
  assert.match(requests[1].url, /\/assets$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-agent-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    speaker: 'agent', text: 'عسلامة', timestamp: '2026-10-01T12:00:00.000Z',
  });
});

test('rejects missing secrets and surfaces non-success API responses', async () => {
  assert.throws(() => new CallArtifactClient({ serverUrl: 'https://calls.example.test', token: '' }), /INTERNAL_AGENT_TOKEN/);
  const client = new CallArtifactClient({
    serverUrl: 'https://calls.example.test',
    token: 'secret',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized.' }),
  });
  await assert.rejects(client.appendTranscript('12345678-abcd-1234-abcd-123456789abc', {
    speaker: 'mobile', text: 'hello',
  }), /401/);
});