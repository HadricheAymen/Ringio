const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AudioMediaBridge } = require('../audioMediaBridge');

function createFakeWebRtc() {
  const sinks = [];
  const audioFrames = [];
  const source = {
    createTrack: () => ({ kind: 'audio', stop: () => {} }),
    onData: (frame) => audioFrames.push(frame),
  };
  class AudioSink {
    constructor(track) {
      this.track = track;
      sinks.push(this);
    }
    stop() {
      this.stopped = true;
    }
  }
  const peerConnection = { addTrack: (track) => track };
  const wrtc = { nonstandard: { RTCAudioSink: AudioSink, RTCAudioSource: class { constructor() { return source; } } } };
  return { peerConnection, wrtc, sinks, audioFrames };
}

test('captures the mobile remote track, resamples to Gemini PCM, and stops sink', async () => {
  const { peerConnection, wrtc, sinks } = createFakeWebRtc();
  let sentSamples;
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    onMobileAudio: (samples) => { sentSamples = samples; },
  });
  peerConnection.ontrack({ track: { kind: 'audio' } });
  sinks[0].ondata({ samples: new Int16Array([0, 300, 600, 900, 1200, 1500]), sampleRate: 48000, channelCount: 1 });
  assert.deepEqual([...sentSamples], [0, 900]);
  await bridge.close();
  assert.equal(sinks[0].stopped, true);
});

test('queues Gemini audio into 10ms WebRTC source frames and can interrupt playback', async () => {
  const { peerConnection, wrtc, audioFrames } = createFakeWebRtc();
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputSampleRate: 48000,
    outputBufferMs: 0,
  });
  bridge.enqueueGeminiAudio(Buffer.alloc(480, 1), 24000);
  assert.equal(audioFrames.length, 1);
  assert.equal(audioFrames[0].samples.length, 480);
  assert.equal(audioFrames[0].sampleRate, 48000);
  bridge.flushOutput();
  await bridge.waitForOutputDrain();

  bridge.enqueueGeminiAudio(Buffer.alloc(4800), 24000);
  bridge.stopOutput();
  await bridge.waitForOutputDrain();
  await bridge.close();
});

test('keeps WebRTC frame cadence from accumulating audio-source processing time', async () => {
  const { peerConnection, wrtc, audioFrames } = createFakeWebRtc();
  let now = 0;
  const timers = [];
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputBufferMs: 0,
    now: () => now,
    scheduleTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancelTimer: () => {},
  });
  bridge.source.onData = (frame) => {
    audioFrames.push(frame);
    now += 2;
  };

  bridge.enqueueGeminiAudio(new Int16Array(960), 48000);
  assert.equal(audioFrames.length, 1);
  assert.equal(timers[0].delay, 8, 'source processing time should be taken from the 10ms frame interval');

  now += timers[0].delay;
  timers[0].callback();
  assert.equal(audioFrames.length, 2);
  assert.equal(timers[1].delay, 8);

  await bridge.close();
});

test('reports Gemini chunk duration and peak queued audio in bridge metrics', async () => {
  const { peerConnection, wrtc } = createFakeWebRtc();
  let now = 0;
  const metrics = [];
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputBufferMs: 0,
    metricsIntervalMs: 1000,
    now: () => now,
    scheduleTimer: () => ({}),
    cancelTimer: () => {},
    onAudioMetrics: (snapshot) => metrics.push(snapshot),
  });

  now = 1000;
  bridge.enqueueGeminiAudio(new Int16Array(480), 24000);

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].geminiChunks, 1);
  assert.equal(metrics[0].geminiAudioMs, 20);
  assert.equal(metrics[0].outputFrames, 1);
  assert.equal(metrics[0].maxQueueMs, 20);

  await bridge.close();
});

test('does not count an idle gap between Gemini chunks as frame lateness', async () => {
  const { peerConnection, wrtc } = createFakeWebRtc();
  let now = 0;
  const timers = [];
  const metrics = [];
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputBufferMs: 0,
    metricsIntervalMs: 100000,
    now: () => now,
    scheduleTimer: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    cancelTimer: () => {},
    onAudioMetrics: (snapshot) => metrics.push(snapshot),
  });

  bridge.enqueueGeminiAudio(new Int16Array(480), 48000);
  now = 10;
  timers[0].callback();
  assert.equal(bridge.audioMetrics.silenceFrames, 1);
  assert.equal(bridge.nextOutputAt, 20);

  now = 1000;
  bridge.enqueueGeminiAudio(new Int16Array(480), 48000);
  timers[1].callback();
  await bridge.close();

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].lateFrames, 0);
});

test('preserves samples across Gemini chunk boundaries instead of padding each chunk', async () => {
  const { peerConnection, wrtc, audioFrames } = createFakeWebRtc();
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputSampleRate: 1000,
    outputBufferMs: 0,
  });

  bridge.enqueueGeminiAudio(new Int16Array([1, 2, 3, 4, 5, 6]), 1000);
  assert.equal(audioFrames.length, 0);
  bridge.enqueueGeminiAudio(new Int16Array([7, 8, 9, 10, 11, 12]), 1000);
  assert.deepEqual([...audioFrames[0].samples], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(audioFrames[0].samples.buffer.byteLength, audioFrames[0].samples.byteLength);

  bridge.flushOutput();
  await bridge.waitForOutputDrain();
  await bridge.close();
});

test('does not reapply startup prebuffer after a temporary empty queue within a turn', async () => {
  const { peerConnection, wrtc, audioFrames } = createFakeWebRtc();
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    outputSampleRate: 1000,
    outputBufferMs: 20,
  });

  bridge.enqueueGeminiAudio(new Int16Array(20).fill(1), 1000);
  assert.equal(audioFrames.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const speechFramesBefore = audioFrames.filter((frame) => frame.samples.some((s) => s !== 0));
  assert.equal(speechFramesBefore.length, 2);
  assert.ok(audioFrames.length > 2, 'silence frames should bridge the empty queue gap');

  bridge.enqueueGeminiAudio(new Int16Array(10).fill(2), 1000);
  bridge.flushOutput();
  await bridge.waitForOutputDrain();
  const speechFramesAfter = audioFrames.filter((frame) => frame.samples.some((s) => s !== 0));
  assert.equal(speechFramesAfter.length, 3, 'the next frame should continue immediately without another prebuffer wait');
  assert.ok(bridge.audioMetrics.silenceFrames > 0, 'silence frames were tracked in metrics');

  await bridge.close();
});

test('normalizes mobile audio before persisting artifacts so one speaker keeps a single WAV format', async () => {
  const { peerConnection, wrtc, sinks } = createFakeWebRtc();
  const samplesSeen = [];
  const bridge = new AudioMediaBridge({
    peerConnection,
    wrtc,
    callId: '12345678-abcd-1234-abcd-123456789abc',
    artifactStore: {
      appendPcm: async ({ samples, sampleRate }) => {
        samplesSeen.push({ sampleRate, length: samples.length });
      },
    },
    outputSampleRate: 48000,
  });

  peerConnection.ontrack({ track: { kind: 'audio' } });
  sinks[0].ondata({ samples: new Int16Array([0, 300, 600, 900]), sampleRate: 44100, channelCount: 1 });
  sinks[0].ondata({ samples: new Int16Array([0, 300, 600, 900]), sampleRate: 48000, channelCount: 1 });
  await bridge.close();

  assert.deepEqual(samplesSeen.map((entry) => entry.sampleRate), [48000, 48000]);
  assert.ok(samplesSeen.every((entry) => entry.length > 0));
});