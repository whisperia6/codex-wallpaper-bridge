import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineFailureMemory, createEngineHealthGate, SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS, selectEngineFallback } from '../bridge-runtime/src/engine-health.mjs';
import { createMediaSwitcher } from '../bridge-runtime/src/media-switch.mjs';

function fixture(options = {}) {
  let now = 0;
  const source = {}, released = [], memory = new EngineFailureMemory();
  const gate = createEngineHealthGate({ identity: 'scene-a', origin: 'http://127.0.0.1:45678', source,
    channel: 'trusted', now: () => now, firstFrameTimeoutMs: 100, heartbeatTimeoutMs: 50,
    failures: memory, onRelease: () => released.push(true), ...options });
  let sequence = 0;
  const beat = (phase = 'ready', extra = {}) => gate.receive({ origin: 'http://127.0.0.1:45678', source,
    data: { source: 'cwb-scene', channel: 'trusted', sequence: ++sequence, phase, ...extra } });
  return { gate, beat, released, memory, advance: (ms) => { now += ms; gate.check(); }, source };
}
test('telemetry or frame alone cannot pass first-frame gate; trusted frame plus ready resolves', async () => {
  const f = fixture(); f.beat(); assert.equal(f.gate.status().phase, 'loading');
  assert.equal(f.gate.frame({ width: 800, height: 450, sequence: 1, decoded: false }), false);
  f.gate.frame({ width: 800, height: 450, sequence: 1, decoded: true });
  await f.gate.ready; assert.equal(f.gate.status().phase, 'ready');
});
test('fake source/origin/channel, replay and malformed telemetry do not extend heartbeat', async () => {
  const f = fixture(); f.beat(); f.gate.frame({ width: 1, height: 1, sequence: 1, decoded: true }); await f.gate.ready;
  for (const event of [{ origin: 'evil' }, { source: {} }, { data: { source: 'cwb-scene', sequence: 9, phase: 'ready', channel: 'wrong' } }])
    assert.equal(f.gate.receive({ origin: 'http://127.0.0.1:45678', source: f.source,
      data: { source: 'cwb-scene', channel: 'trusted', sequence: 1, phase: 'ready' }, ...event }), false);
  f.advance(51); assert.equal(f.gate.status().reason, 'heartbeat_timeout'); assert.equal(f.released.length, 1);
});
test('first-frame timeout remembers failure; repeated load requires explicit retry', async () => {
  const f = fixture(); f.advance(101); await assert.rejects(f.gate.ready, /first_frame_timeout/);
  assert.deepEqual(f.memory.get('scene-a'), { reason: 'first_frame_timeout' });
  const blocked = fixture({ failures: f.memory }); await assert.rejects(blocked.gate.ready, /first_frame_timeout/);
  assert.equal(blocked.gate.status().phase, 'failed'); f.memory.retry('scene-a'); assert.equal(f.memory.get('scene-a'), null);
  const retried = fixture({ failures: f.memory }); retried.beat(); retried.gate.frame({ width: 2, height: 2, sequence: 1, decoded: true });
  await retried.gate.ready;
});
test('scene owner first-frame grace has a hard deadline even with loading heartbeats', async () => {
  const f = fixture({ firstFrameTimeoutMs: SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS });
  f.advance(SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS);
  f.beat('loading');
  assert.equal(f.gate.status().phase, 'loading');
  f.advance(1);
  await assert.rejects(f.gate.ready, /first_frame_timeout/);
});
test('paused static rendering needs heartbeat but does not require new pixels', async () => {
  const f = fixture(); f.beat(); f.gate.frame({ width: 1, height: 1, sequence: 1, decoded: true }); await f.gate.ready;
  f.advance(40); f.beat('ready', { paused: true }); f.advance(40);
  assert.equal(f.gate.status().phase, 'ready'); f.gate.release(); f.gate.release(); assert.equal(f.released.length, 1);
  assert.equal(f.gate.receive({}), false); assert.equal(f.memory.get('scene-a'), null);
});
test('failure registry is bounded, fixed-code only; cached failure never leaks exception text', () => {
  const memory = new EngineFailureMemory(2);
  memory.remember('a', 'transport_failed'); memory.remember('b', 'engine_failed'); memory.remember('c', 'unknown secret path');
  assert.equal(memory.get('a'), null); assert.deepEqual(memory.get('c'), { reason: 'engine_failed' });
});
test('fallback order: embedded video, retained actual frame, custom static, preview, empty', () => {
  const values = { embeddedVideo: { kind: 'video' }, actualFrame: { kind: 'frame' }, customStatic: { kind: 'image' }, preview: { kind: 'image' } };
  assert.equal(selectEngineFallback(values).reason, 'embedded_video'); delete values.embeddedVideo;
  assert.equal(selectEngineFallback(values).reason, 'actual_frame'); delete values.actualFrame;
  assert.equal(selectEngineFallback(values).reason, 'custom_static'); delete values.customStatic;
  assert.equal(selectEngineFallback(values).reason, 'preview'); assert.equal(selectEngineFallback({}).reason, 'empty');
});
test('engine health composes with existing M1 prepare/commit/cancel; failed candidate retains active', async () => {
  const old = { ready: Promise.resolve(), node: {} }, f = fixture();
  const next = { ready: f.gate.ready, node: {}, release: () => f.gate.release() };
  const disposed = [], commits = [];
  const switcher = createMediaSwitcher({ create: (v) => v, commit: (v) => commits.push(v),
    dispose: (v) => { disposed.push(v); v.release?.(); } });
  await switcher.switchTo(old, 'old'); const pending = switcher.prepare(next, 'scene-a');
  f.advance(101); assert.equal((await switcher.commit(pending)).ok, false);
  assert.equal(switcher.status().identity, 'old'); assert.equal(commits.length, 1); assert.ok(disposed.includes(next));
  switcher.close();
});
