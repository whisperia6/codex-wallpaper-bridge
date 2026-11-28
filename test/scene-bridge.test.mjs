import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { readAuthorProperties, validateAuthorPropertyPatch, normalizeAuthorProperties } from '../bridge-runtime/src/author-properties.mjs';
import { validateWebWallpaperInput } from '../bridge-runtime/src/web-wallpaper-input.mjs';
import { SCENE_MAX_FIRST_FRAME_TIMEOUT_MS } from '../bridge-runtime/src/engine-health.mjs';

const script = await readFile(new URL('../bridge-runtime/public/cwb-scene-bridge.js', import.meta.url), 'utf8');
async function fixture({ scene = true, configOk = true, parentOrigin = 'http://127.0.0.1:42341', authorProperties = { schema: { enabled: { type: 'bool' } }, values: { enabled: true } } } = {}) {
  let now = 0;
  let tick;
  let cleared = 0;
  let canvas = { width: 960, height: 540 };
  let paused = false;
  const properties = { ...authorProperties.values };
  let mountOptions, progress;
  const calls = [];
  const messages = [];
  const events = new Map();
  const frames = new Map();
  const microtasks = [];
  let frameId = 0;
  class GL { drawArrays() {} }
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const window = { parent, __cwbValidateWebInput: validateWebWallpaperInput, __cwbReadProperties: readAuthorProperties, __cwbValidateProperties: validateAuthorPropertyPatch, WebGL2RenderingContext: GL,
    addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  const instance = {
    get canvas() { return canvas; }, get paused() { return paused; },
    get stats() { return paused ? { fps: 0, running: false } : { fps: 30, running: true }; },
    pause() { paused = true; calls.push('pause'); }, resume() { paused = false; calls.push('resume'); },
    destroy() { calls.push('release'); canvas = null; paused = true; },
    pointerLeave() {},
    pushPointer(...args) { calls.push(['pointer', ...args]); },
    setVolume(value) { calls.push(['volume', value]); },
    setProperties(patch) { Object.assign(properties, patch); },
    getProperties: () => properties,
    async load(source) {
      assert.equal((await source.project()).type, 'scene');
      if (scene) { new GL().drawArrays(); mountOptions.onReady({ layerCount: 2 }); }
    },
  };
  window.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  vm.runInNewContext(script, { window, document: { querySelector: () => ({ content: 'a'.repeat(32) }), getElementById: () => ({}) },
    AbortSignal, Date: { now: () => now }, performance: { now: () => now },
    fetch: async url => url.endsWith('/payload-progress.json') ? { ok: true, json: async () => progress }
      : { ok: configOk, json: async () => ({ parentOrigin, channel: 'trusted', firstFrameTimeoutMs: 15000,
        maxFirstFrameTimeoutMs: SCENE_MAX_FIRST_FRAME_TIMEOUT_MS, authorProperties }) },
    setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => cleared++, queueMicrotask: (fn) => microtasks.push(fn),
    setTimeout: (fn) => { frames.set(++frameId, fn); return frameId; }, clearTimeout: (id) => frames.delete(id) });
  window.__cwbStartScene({
    httpSource: () => ({ project: async () => ({ type: 'web' }) }),
    createScene(_target, options) { mountOptions = options; return instance; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const send = (data, origin = parentOrigin, source = parent) => events.get('message')?.({ origin, source, data });
  return { window, instance, calls, messages, events, send, tick: () => tick(), advance: (ms) => { now += ms; }, cleared: () => cleared,
    audio: () => mountOptions.audio.snapshot(), setProgress: (bytesServed, lastByteAt = now) => { progress = { bytesServed, lastByteAt }; },
    completeFirstFrame: () => mountOptions.onReady({ layerCount: 2 }), engineFailure: () => mountOptions.onError(Error('engine')),
    draw() { new GL().drawArrays(); while (microtasks.length) microtasks.shift()(); tick(); },
    completeRender() { window.__cwbSceneRenderComplete?.(); tick(); },
    pendingFrames: () => frames.size };
}

test('fps/canvas alone cannot pass scene first-frame gate; timed failure releases resources', async () => {
  const env = await fixture({ scene: false });
  assert.equal(env.window.__cwbScene.phase, 'loading');
  env.draw(); assert.equal(env.window.__cwbScene.phase, 'loading');
  env.advance(15001); env.tick(); await new Promise(setImmediate);
  assert.equal(env.window.__cwbScene.phase, 'failed');
  assert.deepEqual(env.calls, ['release']);
  assert.ok(env.cleared() > 0);
  assert.equal(env.messages.at(-1).origin, 'http://127.0.0.1:42341');
});

test('recent package bytes extend the deadline once per advance, while a stalled transfer expires', async () => {
  const env = await fixture({ scene: false });
  const tick = async () => { env.tick(); await new Promise(setImmediate); };
  env.advance(15000); env.setProgress(1024); await tick();
  assert.equal(env.window.__cwbScene.phase, 'loading');
  env.advance(4999); env.setProgress(2048); await tick();
  env.advance(1); await tick();
  assert.equal(env.window.__cwbScene.phase, 'loading');
  env.advance(5000); await tick();
  assert.equal(env.window.__cwbScene.phase, 'failed');
});

test('a completed first frame can recover during a transfer extension and runtime errors notify the host', async () => {
  const env = await fixture({ scene: false });
  env.advance(15000); env.setProgress(2048); env.tick(); await new Promise(setImmediate);
  env.draw(); env.completeFirstFrame();
  assert.equal(env.window.__cwbScene.phase, 'ready');
  env.engineFailure();
  assert.equal(env.window.__cwbScene.phase, 'failed');
});

test('ongoing transfer still stops at the absolute startup cap', async () => {
  const env = await fixture({ scene: false });
  env.advance(15000);
  for (let bytes = 1024; bytes <= 21504; bytes += 1024) {
    env.setProgress(bytes); env.tick(); await new Promise(setImmediate);
    assert.equal(env.window.__cwbScene.phase, 'loading');
    env.advance(5000);
  }
  env.setProgress(22528); env.tick(); await new Promise(setImmediate);
  assert.equal(env.window.__cwbScene.phase, 'failed');
});

test('Scene audio source rejects invalid data, copies stereo samples and clears on pause/release', async () => {
  const env = await fixture(); const bridge = env.audio;
  assert.equal(bridge().left.length, 64); assert.equal(bridge().left.some(value => value !== 0), false);
  const values = Array(64).fill(0.25).concat(Array(64).fill(0.75));
  const message = { source: 'cwb-scene-control', channel: 'trusted', op: 'audio', values };
  env.send(message, 'https://evil.test'); env.send({ ...message, channel: 'wrong' });
  env.send({ ...message, values: Array(128).fill(Infinity) }); env.send({ ...message, values: Array(129).fill(0) });
  assert.equal(bridge().left[0], 0);
  env.send(message); values[0] = 1;
  assert.equal(bridge().left[0], 0.25); assert.equal(bridge().right[0], 0.75);
  env.send({ source: message.source, channel: message.channel, op: 'pause' });
  assert.equal(bridge().left[0], 0); env.send(message); assert.equal(bridge().right[0], 0);
  env.send({ source: message.source, channel: message.channel, op: 'resume' }); env.send(message); assert.equal(bridge().right[0], 0.75);
  env.send({ source: message.source, channel: message.channel, op: 'release' }); assert.equal(bridge().left[0], 0);
  assert.equal(env.window.__cwbScene.systemAudio.attached, false);
});

test('a real WebGL submit passes ready for a static scene with no second frame or FPS', async () => {
  const env = await fixture();
  Object.defineProperty(env.instance, 'stats', { value: { running: false, fps: 0 } });
  env.tick();
  assert.equal(env.window.__cwbScene.phase, 'ready');
  assert.ok(env.window.__cwbScene.draws > 0);
});

test('Scene file properties apply stable resource IDs and return typed engine readback without accepting local URLs', async () => {
  const authorProperties = normalizeAuthorProperties({ picture: { type: 'file', filetype: 'image', value: '' } });
  const env = await fixture({ authorProperties });
  const value = 'cwb-author-files/' + 'a'.repeat(32) + '-' + 'b'.repeat(32) + '-' + 'c'.repeat(64) + '.png';
  env.send({ source: 'cwb-scene-control', channel: 'trusted', op: 'properties', values: { picture: value }, propertyRequest: 8 });
  env.draw(); assert.equal(env.window.__cwbScene.properties.picture, value);
  assert.ok(env.messages.some(entry => entry.message.propertyRequest === 8 && entry.message.properties.picture === value));
  env.send({ source: 'cwb-scene-control', channel: 'trusted', op: 'properties', values: { picture: 'file:///C:/secret.png' } });
  env.draw(); assert.equal(env.window.__cwbScene.properties.picture, value);
});

test('source, origin, channel and operation whitelist all gate scene controls', async () => {
  const env = await fixture();
  const payload = { source: 'cwb-scene-control', channel: 'trusted', op: 'release' };
  env.send(payload, 'http://evil.test');
  env.send(payload, 'http://127.0.0.1:42341', {});
  env.send({ ...payload, channel: 'wrong' });
  env.send({ ...payload, source: 'wrong' });
  env.send({ ...payload, op: 'setWallpaper', src: 'file:///secret' });
  assert.deepEqual(env.calls, []);
  assert.equal(env.window.__cwbScene.phase, 'ready');
});

test('standard app origin controls are exact; opaque/null and same-origin other sources are rejected', async () => {
  const env = await fixture({ parentOrigin: 'app://-' });
  const payload = { source: 'cwb-scene-control', channel: 'trusted', op: 'pause' };
  for (const origin of ['null', 'app://other', 'http://127.0.0.1:42341']) env.send(payload, origin);
  env.send(payload, 'app://-', {});
  assert.deepEqual(env.calls, []);
  env.send(payload);
  assert.deepEqual(env.calls, ['pause']);
  assert.equal(env.messages.at(-1).origin, 'app://-');
});

test('trusted pause/resume/release publish monotonic bounded state, release cannot resurrect', async () => {
  const env = await fixture();
  const send = (op) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op });
  send('pause'); assert.equal(env.window.__cwbScene.paused, true);
  send('resume'); assert.equal(env.window.__cwbScene.running, true);
  send('release'); assert.equal(env.window.__cwbScene.phase, 'released');
  send('resume'); assert.deepEqual(env.calls, ['pause', 'resume', 'release']);
  assert.equal(env.window.__cwbScene.width, 0);
  assert.equal(env.window.__cwbScene.layers, 0);
  assert.ok(env.messages.every((entry, index) => entry.message.sequence === index + 1));
  assert.ok(Object.isFrozen(env.window.__cwbScene));
});

test('pagehide stops telemetry listener/timer and releases engine', async () => {
  const env = await fixture();
  env.events.get('pagehide')();
  assert.equal(env.events.has('message'), false);
  assert.ok(env.cleared() > 0);
  assert.deepEqual(env.calls, ['release']);
});

test('bridge configuration fetch failure does not install a control listener or claim ready', async () => {
  const env = await fixture({ configOk: false });
  assert.equal(env.window.__cwbScene.phase, 'failed');
  assert.equal(env.events.has('message'), false);
});

test('pointer/audio controls reject malformed values; properties validate and read back actual engine state', async () => {
  const env = await fixture();
  const send = (op, patch) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op, ...patch });
  for (const u of [-1, 2, NaN, '0.5']) send('pointer', { u, v: .5 });
  send('pointer', { u: .5, v: .5, buttons: 2 });
  for (const value of [-1, 2, NaN, '0.5']) send('volume', { value });
  send('properties', { values: { enabled: 'false' } });
  send('properties', { values: { file: 'file:///secret' } });
  assert.deepEqual(env.calls, []); assert.equal(env.window.__cwbScene.propertyRevision, 0);
  send('pointer', { u: .5, v: .2, buttons: 1 }); send('volume', { value: .2 });
  send('properties', { values: { enabled: false } });
  assert.deepEqual(env.calls, [['pointer', .5, .2, 1, 0], ['volume', .2]]);
  assert.equal(env.window.__cwbScene.properties.enabled, false); assert.equal(env.window.__cwbScene.propertyRevision, 1);
  send('resetProperties'); assert.equal(env.window.__cwbScene.properties.enabled, true);
});

test('rapid pointer down/up needs cursor-dispatch completion, not GL submit; adjacent moves coalesce only', async () => {
  const env = await fixture();
  const pointer = (buttons, u = .5) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op: 'pointer', u, v: .5, buttons });
  pointer(1); pointer(0, .6); pointer(0, .7);
  assert.deepEqual(env.calls, [['pointer', .5, .5, 1, 0]]);
  assert.equal(env.window.__cwbScene.pendingPointers, 1);
  env.draw(); assert.equal(env.calls.length, 1); assert.equal(env.window.__cwbScene.pendingPointers, 1);
  env.completeRender(); assert.deepEqual(env.calls.at(-1), ['pointer', .7, .5, 0, 0]);
  assert.equal(env.window.__cwbScene.pendingPointers, 0); assert.equal(env.pendingFrames(), 0);
  assert.equal(env.window.__cwbScene.pointerAccepted, 3); assert.equal(env.window.__cwbScene.pointerDelivered, 2);
});
test('a hidden iframe needs no adapter rAF/timer to drain button transitions across engine acknowledgements', async () => {
  const env = await fixture(); env.window.requestAnimationFrame = undefined;
  for (let i = 0; i < 3; i++) for (const buttons of [1, 0]) env.send({ source: 'cwb-scene-control', channel: 'trusted', op: 'pointer', u: .5, v: .5, buttons });
  assert.equal(env.calls.length, 1);
  for (let i = 0; i < 5; i++) { env.draw(); env.completeRender(); }
  assert.equal(env.calls.length, 6); assert.equal(env.window.__cwbScene.pendingPointers, 0);
  assert.deepEqual(env.calls.map((c) => c[3]), [1, 0, 1, 0, 1, 0]);
});
test('pause/release cancels pending pointer work; paused controls cannot queue a future click', async () => {
  const env = await fixture();
  const send = (op, more) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op, ...more });
  send('pointer', { u: .5, v: .5, buttons: 1 }); send('pointer', { u: .5, v: .5, buttons: 0 });
  send('pause'); assert.equal(env.pendingFrames(), 0);
  send('pointer', { u: .5, v: .5, buttons: 1 }); assert.equal(env.window.__cwbScene.pendingPointers, 0);
  send('release'); env.draw(); assert.equal(env.calls.filter((c) => Array.isArray(c) && c[0] === 'pointer').length, 1);
});
test('a GL submit between down/up messages must never consume the in-flight transition', async () => {
  const env = await fixture();
  const pointer = (buttons) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op: 'pointer', u: .5, v: .5, buttons });
  pointer(1); env.draw(); pointer(0);
  assert.equal(env.calls.length, 1); assert.equal(env.window.__cwbScene.pendingPointers, 1);
  env.completeRender(); assert.equal(env.calls.length, 2);
  env.completeRender(); assert.equal(env.window.__cwbScene.pointerAcknowledged, 2);
});
test('release removes the render acknowledgement hook; a late completion cannot deliver a queued click', async () => {
  const env = await fixture();
  const send = (op, buttons = 0) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op, u: .5, v: .5, buttons });
  send('pointer', 1); send('pointer', 0);
  const late = env.window.__cwbSceneRenderComplete; assert.equal(typeof late, 'function');
  send('release'); assert.equal(env.window.__cwbSceneRenderComplete, undefined);
  late(); assert.equal(env.calls.filter((call) => Array.isArray(call) && call[0] === 'pointer').length, 1);
});

test('author read/apply acknowledgements are exact and contain getProperties output without mutating reads', async () => {
  const env = await fixture();
  const send = (op, extra = {}, origin) => env.send({ source: 'cwb-scene-control', channel: 'trusted', op, ...extra }, origin);
  for (const propertyRequest of [-1, 0, '1', 1.5, Infinity]) send('readProperties', { propertyRequest });
  send('readProperties', { propertyRequest: 1 }, 'http://evil.test');
  assert.equal(env.window.__cwbScene.propertyRequest, undefined);
  send('readProperties', { propertyRequest: 1 });
  assert.equal(env.window.__cwbScene.propertyRequest, 1); assert.equal(env.window.__cwbScene.properties.enabled, true);
  assert.equal(env.window.__cwbScene.propertyRevision, 0);
  env.instance.getProperties = () => ({ enabled: true });
  send('properties', { propertyRequest: 2, values: { enabled: false } });
  assert.equal(env.window.__cwbScene.propertyRequest, 2); assert.equal(env.window.__cwbScene.properties.enabled, true);
  assert.equal(env.window.__cwbScene.propertyRevision, 1);
  send('properties', { propertyRequest: 0, values: { enabled: true } });
  assert.equal(env.window.__cwbScene.propertyRevision, 1);
  env.tick(); assert.equal(env.window.__cwbScene.propertyRequest, undefined);
});
