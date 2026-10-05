const assert = require('node:assert/strict');
const { createIceConfig, readIceConfigFromEnv } = require('../iceConfig');
const { test } = require('node:test');

test('creates expiring TURN credentials without exposing the shared secret', () => {
  const config = createIceConfig({
    stunUrls: ['stun:stun.example.test:3478'],
    turnUrls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349'],
    turnSharedSecret: 'server-only-secret',
    now: Date.UTC(2026, 0, 1),
    credentialTtlSeconds: 600,
  });
  assert.equal(config.iceServers.length, 2);
  assert.equal(config.iceServers[1].urls.length, 2);
  assert.equal(config.iceServers[1].username, `${Math.floor(Date.UTC(2026, 0, 1) / 1000) + 600}:ringio`);
  assert.notEqual(config.iceServers[1].credential, 'server-only-secret');
  assert.equal(config.expiresAt, new Date(Date.UTC(2026, 0, 1) + 600000).toISOString());
  assert.equal(JSON.stringify(config).includes('server-only-secret'), false);
});

test('requires a TURN shared secret and bounds credential lifetime', () => {
  assert.throws(() => createIceConfig({ turnUrls: ['turn:turn.example.test'] }), /TURN_SHARED_SECRET/);
  assert.throws(() => readIceConfigFromEnv({ TURN_CREDENTIAL_TTL_SECONDS: '2' }), /between 60 and 86400/);
});