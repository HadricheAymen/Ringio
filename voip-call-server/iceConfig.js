function createIceConfig({
  stunUrls = ['stun:stun.l.google.com:19302'],
  turnUrls = [],
  turnSharedSecret = '',
  now = Date.now(),
  credentialTtlSeconds = 600,
} = {}) {
  const iceServers = [];
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  let expiresAt = null;
  if (turnUrls.length) {
    if (!turnSharedSecret) throw new Error('TURN_SHARED_SECRET is required when TURN_URLS are configured.');
    const expiresSeconds = Math.floor(now / 1000) + credentialTtlSeconds;
    const username = `${expiresSeconds}:ringio`;
    const credential = require('crypto').createHmac('sha1', turnSharedSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
    expiresAt = new Date(expiresSeconds * 1000).toISOString();
  }
  return { iceServers, expiresAt };
}

function readIceConfigFromEnv(env = process.env) {
  const stunUrls = (env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',').map((url) => url.trim()).filter(Boolean);
  const turnUrls = (env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const credentialTtlSeconds = Number(env.TURN_CREDENTIAL_TTL_SECONDS || 600);
  if (!Number.isInteger(credentialTtlSeconds) || credentialTtlSeconds < 60 || credentialTtlSeconds > 86400) {
    throw new Error('TURN_CREDENTIAL_TTL_SECONDS must be an integer between 60 and 86400.');
  }
  return createIceConfig({
    stunUrls,
    turnUrls,
    turnSharedSecret: env.TURN_SHARED_SECRET || '',
    credentialTtlSeconds,
  });
}

module.exports = { createIceConfig, readIceConfigFromEnv };