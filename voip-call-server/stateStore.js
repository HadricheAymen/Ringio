const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const { randomUUID } = require('crypto');

const PREFIX = 'ringio:v1';
const ENDPOINT_INDEX = `${PREFIX}:endpoints`;
const APP_INDEX = `${PREFIX}:apps`;
const APP_ORDER = `${PREFIX}:app-order`;
const CALL_INDEX = `${PREFIX}:calls`;
const RECORDING_INDEX = `${PREFIX}:recordings`;
const PHONE_TTL_SECONDS = 75;
const SESSION_TTL_SECONDS = 21600;
const ROUTING_LOCK = `${PREFIX}:routing-lock`;

function createStateStore(io, redisUrl) {
  const local = {
    endpoints: new Map(),
    endpointApps: new Map(),
    appMetadata: new Map(),
    appOrder: [],
    endpointCalls: new Map(),
    queuedCalls: [],
    socketCalls: new Map(),
    sessions: new Map(),
    calls: new Map(),
    transcripts: new Map(),
    callAssets: new Map(),
    recordings: new Map(),
    mediaEvents: new Map(),
    signals: new Map(),
  };
  const redis = redisUrl ? createClient({ url: redisUrl }) : null;
  const subscriber = redis?.duplicate();

  redis?.on('error', (error) => console.error('Redis connection error:', error.message));
  subscriber?.on('error', (error) => console.error('Redis subscriber error:', error.message));

  const ready = redis
    ? Promise.all([redis.connect(), subscriber.connect()]).then(() => {
      io.adapter(createAdapter(redis, subscriber));
    })
    : Promise.resolve();

  const key = (type, id) => `${PREFIX}:${type}:${id}`;
  const run = async (callback) => {
    await ready;
    return callback();
  };
  let localRoutingLock = Promise.resolve();

  function serializeSession(session) {
    return JSON.stringify({
      ...session,
      participants: [...session.participants.entries()],
    });
  }

  function parseSession(value) {
    if (!value) return null;
    const session = JSON.parse(value);
    session.participants = new Map(session.participants);
    return session;
  }

  return {
    ready,
    shared: !!redis,

    async getEndpoint(endpointId) {
      return run(() => redis ? redis.get(key('endpoint', endpointId)) : local.endpoints.get(endpointId) || null);
    },

    async getEndpointAppId(endpointId) {
      return run(() => redis
        ? redis.get(key('endpoint-app', endpointId))
        : local.endpointApps.get(endpointId) || null);
    },

    async getAppMetadata(appId) {
      return run(async () => {
        if (!redis) return local.appMetadata.get(appId) || null;
        const value = await redis.get(key('app', appId));
        return value ? JSON.parse(value) : null;
      });
    },

    async setAppBlocked(appId, blocked) {
      return run(async () => {
        const metadata = await this.getAppMetadata(appId);
        if (!metadata) return null;
        const updated = { ...metadata, blocked };
        local.appMetadata.set(appId, updated);
        if (redis) await redis.set(key('app', appId), JSON.stringify(updated));
        return updated;
      });
    },

    async renameApp(appId, name) {
      return run(async () => {
        const metadata = await this.getAppMetadata(appId);
        if (!metadata) return null;
        const updated = { ...metadata, name };
        local.appMetadata.set(appId, updated);
        if (redis) await redis.set(key('app', appId), JSON.stringify(updated));
        return updated;
      });
    },

    async listAppOrder() {
      return run(() => redis ? redis.lRange(APP_ORDER, 0, -1) : [...local.appOrder]);
    },

    async moveApp(appId, direction) {
      return run(async () => {
        const order = redis ? await redis.lRange(APP_ORDER, 0, -1) : [...local.appOrder];
        const index = order.indexOf(appId);
        const target = index + (direction === 'up' ? -1 : 1);
        if (index < 0 || target < 0 || target >= order.length) return order;
        [order[index], order[target]] = [order[target], order[index]];
        if (redis) await redis.multi().del(APP_ORDER).rPush(APP_ORDER, order).exec();
        else local.appOrder = order;
        return order;
      });
    },

    async setEndpoint(endpointId, socketId, app = {}) {
      return run(async () => {
        const appId = app.appId || await this.getEndpointAppId(endpointId) || endpointId;
        const previousMetadata = await this.getAppMetadata(appId);
        const metadata = {
          appId,
          name: previousMetadata?.name || app.name || 'Ringio mobile app',
          platform: app.platform || previousMetadata?.platform || 'unknown',
          blocked: previousMetadata?.blocked || false,
        };
        local.endpoints.set(endpointId, socketId);
        local.endpointApps.set(endpointId, metadata.appId);
        local.appMetadata.set(metadata.appId, metadata);
        if (!local.appOrder.includes(metadata.appId)) local.appOrder.push(metadata.appId);
        if (redis) {
          const added = await redis.sAdd(APP_INDEX, metadata.appId);
          await redis.multi()
            .set(key('endpoint', endpointId), socketId, { EX: PHONE_TTL_SECONDS })
            .set(key('endpoint-app', endpointId), metadata.appId, { EX: PHONE_TTL_SECONDS })
            .set(key('app', metadata.appId), JSON.stringify(metadata))
            .sAdd(ENDPOINT_INDEX, endpointId)
            .exec();
          if (added) await redis.rPush(APP_ORDER, metadata.appId);
        }
      });
    },

    async removeEndpoint(endpointId, socketId) {
      return run(async () => {
        const current = redis ? await redis.get(key('endpoint', endpointId)) : local.endpoints.get(endpointId);
        if (current !== socketId) return false;
        local.endpoints.delete(endpointId);
        local.endpointApps.delete(endpointId);
        if (redis) await redis.multi()
          .del(key('endpoint', endpointId), key('endpoint-app', endpointId))
          .sRem(ENDPOINT_INDEX, endpointId)
          .exec();
        return true;
      });
    },

    async listEndpoints() {
      return run(async () => {
        if (!redis) return [...local.endpoints.entries()];
        const endpointIds = await redis.sMembers(ENDPOINT_INDEX);
        const entries = await Promise.all(endpointIds.map(async (endpointId) => [
          endpointId,
          await redis.get(key('endpoint', endpointId)),
        ]));
        const online = entries.filter(([, socketId]) => socketId);
        const expired = endpointIds.filter((endpointId) => !online.some(([entry]) => entry === endpointId));
        if (expired.length) await redis.sRem(ENDPOINT_INDEX, expired);
        return online;
      });
    },

    async refreshEndpoint(endpointId, socketId) {
      return run(async () => {
        const current = redis ? await redis.get(key('endpoint', endpointId)) : local.endpoints.get(endpointId);
        if (current !== socketId) return false;
        if (redis) await redis.multi()
          .expire(key('endpoint', endpointId), PHONE_TTL_SECONDS)
          .expire(key('endpoint-app', endpointId), PHONE_TTL_SECONDS)
          .exec();
        return true;
      });
    },

    async withRoutingLock(callback) {
      if (!redis) {
        const previous = localRoutingLock;
        let release;
        localRoutingLock = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      }

      const token = randomUUID();
      while (await redis.set(ROUTING_LOCK, token, { NX: true, PX: 10000 }) !== 'OK') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      try {
        return await callback();
      } finally {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [ROUTING_LOCK], arguments: [token] },
        );
      }
    },

    async reserveAvailableEndpoint(callId) {
      return run(async () => {
        if (!redis) {
          const priorities = new Map(local.appOrder.map((appId, index) => [appId, index]));
          const endpoints = [...local.endpoints.entries()].sort(([left], [right]) => (
            (priorities.get(local.endpointApps.get(left)) ?? Number.MAX_SAFE_INTEGER)
            - (priorities.get(local.endpointApps.get(right)) ?? Number.MAX_SAFE_INTEGER)
          ));
          for (const [endpointId, socketId] of endpoints) {
            if (local.appMetadata.get(local.endpointApps.get(endpointId))?.blocked) continue;
            if (!local.endpointCalls.has(endpointId)) {
              local.endpointCalls.set(endpointId, callId);
              return { endpointId, socketId };
            }
          }
          return null;
        }

        const endpointIds = await redis.sMembers(ENDPOINT_INDEX);
        const appOrder = await redis.lRange(APP_ORDER, 0, -1);
        const priorities = new Map(appOrder.map((appId, index) => [appId, index]));
        const endpoints = await Promise.all(endpointIds.map(async (endpointId) => ({
          endpointId,
          appId: await redis.get(key('endpoint-app', endpointId)),
        })));
        endpoints.sort((left, right) => (
          (priorities.get(left.appId) ?? Number.MAX_SAFE_INTEGER)
          - (priorities.get(right.appId) ?? Number.MAX_SAFE_INTEGER)
        ));
        for (const { endpointId, appId } of endpoints) {
          const metadata = appId ? await redis.get(key('app', appId)) : null;
          if (metadata && JSON.parse(metadata).blocked) continue;
          const socketId = await redis.get(key('endpoint', endpointId));
          if (!socketId) {
            await redis.sRem(ENDPOINT_INDEX, endpointId);
            continue;
          }
          const reserved = await redis.set(key('endpoint-call', endpointId), callId, {
            NX: true,
            EX: SESSION_TTL_SECONDS,
          });
          if (reserved === 'OK') return { endpointId, socketId };
        }
        return null;
      });
    },

    async releaseEndpoint(endpointId, callId) {
      return run(async () => {
        if (!redis) {
          if (local.endpointCalls.get(endpointId) !== callId) return false;
          local.endpointCalls.delete(endpointId);
          return true;
        }
        const result = await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          { keys: [key('endpoint-call', endpointId)], arguments: [callId] },
        );
        return result === 1;
      });
    },

    async enqueueCall(callId) {
      return run(async () => {
        if (!redis) {
          if (!local.queuedCalls.includes(callId)) local.queuedCalls.push(callId);
          return;
        }
        await redis.rPush(key('call-queue', 'waiting'), callId);
      });
    },

    async removeQueuedCall(callId) {
      return run(async () => {
        if (!redis) {
          local.queuedCalls = local.queuedCalls.filter((entry) => entry !== callId);
          return;
        }
        await redis.lRem(key('call-queue', 'waiting'), 0, callId);
      });
    },

    async listQueuedCalls() {
      return run(() => redis
        ? redis.lRange(key('call-queue', 'waiting'), 0, -1)
        : [...local.queuedCalls]);
    },

    async getSocketCall(socketId) {
      return run(() => redis ? redis.get(key('socket-call', socketId)) : local.socketCalls.get(socketId) || null);
    },

    async setSocketCall(socketId, callId) {
      return run(async () => {
        local.socketCalls.set(socketId, callId);
        if (redis) await redis.set(key('socket-call', socketId), callId, { EX: SESSION_TTL_SECONDS });
      });
    },

    async removeSocketCall(socketId, callId) {
      return run(async () => {
        const current = redis ? await redis.get(key('socket-call', socketId)) : local.socketCalls.get(socketId);
        if (current !== callId) return false;
        local.socketCalls.delete(socketId);
        if (redis) await redis.del(key('socket-call', socketId));
        return true;
      });
    },

    async getSession(callId) {
      return run(() => redis
        ? redis.get(key('session', callId)).then(parseSession)
        : local.sessions.get(callId) || null);
    },

    async setSession(session) {
      return run(async () => {
        local.sessions.set(session.id, session);
        if (redis) await redis.set(key('session', session.id), serializeSession(session), { EX: SESSION_TTL_SECONDS });
      });
    },

    async removeSession(callId) {
      return run(async () => {
        const session = await this.getSession(callId);
        local.sessions.delete(callId);
        if (redis) await redis.del(key('session', callId));
        return session;
      });
    },

    async getCall(callId) {
      return run(async () => {
        if (!redis) return local.calls.get(callId) || null;
        const value = await redis.get(key('call', callId));
        if (!value) return null;
        const record = JSON.parse(value);
        local.calls.set(callId, record);
        return record;
      });
    },

    async setCall(record) {
      return run(async () => {
        local.calls.set(record.callId, record);
        if (redis) {
          await redis.multi()
            .set(key('call', record.callId), JSON.stringify(record))
            .sAdd(CALL_INDEX, record.callId)
            .exec();
        }
      });
    },

    async appendTranscript(callId, entry) {
      return run(async () => {
        if (!redis) {
          const entries = local.transcripts.get(callId) || [];
          entries.push(entry);
          local.transcripts.set(callId, entries);
          return entries.length;
        }
        return redis.rPush(key('transcripts', callId), JSON.stringify(entry));
      });
    },

    async getTranscripts(callId) {
      return run(async () => {
        if (!redis) return local.transcripts.get(callId) || [];
        const entries = await redis.lRange(key('transcripts', callId), 0, -1);
        return entries.map((entry) => JSON.parse(entry));
      });
    },

    async setCallAssets(callId, assets) {
      return run(async () => {
        local.callAssets.set(callId, assets);
        if (redis) await redis.set(key('call-assets', callId), JSON.stringify(assets));
      });
    },

    async getCallAssets(callId) {
      return run(async () => {
        if (!redis) return local.callAssets.get(callId) || [];
        const value = await redis.get(key('call-assets', callId));
        return value ? JSON.parse(value) : [];
      });
    },

    async listCalls() {
      return run(async () => {
        if (!redis) return [...local.calls.values()];
        const ids = await redis.sMembers(CALL_INDEX);
        const values = await Promise.all(ids.map((id) => redis.get(key('call', id))));
        return values.filter(Boolean).map((value) => JSON.parse(value))
          .sort((left, right) => right.timestamps.createdAt.localeCompare(left.timestamps.createdAt));
      });
    },

    async getRecording(recordingId) {
      return run(async () => {
        if (!redis) return local.recordings.get(recordingId) || null;
        const value = await redis.get(key('recording', recordingId));
        if (!value) return null;
        const recording = JSON.parse(value);
        local.recordings.set(recordingId, recording);
        return recording;
      });
    },

    async setRecording(recording) {
      return run(async () => {
        local.recordings.set(recording.recordingId, recording);
        if (redis) {
          await redis.multi()
            .set(key('recording', recording.recordingId), JSON.stringify(recording))
            .sAdd(RECORDING_INDEX, recording.recordingId)
            .exec();
        }
      });
    },

    async listRecordings() {
      return run(async () => {
        if (!redis) return [...local.recordings.values()];
        const ids = await redis.sMembers(RECORDING_INDEX);
        const values = await Promise.all(ids.map((id) => redis.get(key('recording', id))));
        return values.filter(Boolean).map((value) => JSON.parse(value));
      });
    },

    async addMediaEvent(callId, event) {
      return run(async () => {
        const events = await this.getMediaEvents(callId);
        events.push(event);
        local.mediaEvents.set(callId, events);
        if (redis) await redis.set(key('media-events', callId), JSON.stringify(events));
        return events;
      });
    },

    async getMediaEvents(callId) {
      return run(async () => {
        if (!redis) return local.mediaEvents.get(callId) || [];
        const value = await redis.get(key('media-events', callId));
        return value ? JSON.parse(value) : [];
      });
    },

    async addSignal(callId, recipient, signal) {
      return run(async () => {
        const signalKey = `${callId}:${recipient}`;
        if (!redis) {
          const events = local.signals.get(signalKey) || [];
          events.push(signal);
          local.signals.set(signalKey, events);
          return events.length;
        }
        const redisKey = key(`signals:${callId}`, recipient);
        const length = await redis.rPush(redisKey, JSON.stringify(signal));
        await redis.expire(redisKey, SESSION_TTL_SECONDS);
        return length;
      });
    },

    async getSignals(callId, recipient, offset = 0) {
      return run(async () => {
        const start = Math.max(0, Number.parseInt(offset, 10) || 0);
        if (!redis) {
          const events = local.signals.get(`${callId}:${recipient}`) || [];
          return { events: events.slice(start, start + 50), nextOffset: Math.min(start + 50, events.length) };
        }
        const redisKey = key(`signals:${callId}`, recipient);
        const [events, length] = await Promise.all([
          redis.lRange(redisKey, start, start + 49),
          redis.lLen(redisKey),
        ]);
        return {
          events: events.map((event) => JSON.parse(event)),
          nextOffset: Math.min(start + events.length, length),
        };
      });
    },
  };
}

module.exports = { createStateStore };
