import assert from 'node:assert/strict';
import test from 'node:test';
import { createScenePreviewSlot, switchScenePreviewFallback } from '../bridge-runtime/src/workbench-scene-preview.mjs';
const client = 'a'.repeat(32), channel = 'b'.repeat(32), handle = 'c'.repeat(32);
function fixture(options = {}) {
  const listeners = new Map(), intervals = new Set(), timers = new Set(), posts = [], requests = [], states = [], listenerOptions = new Map();
  const document = { hidden: false,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const window = { document,
    addEventListener(name, fn, options) { listenerOptions.set(name, options); if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); } };
  const node = { dataset: {}, style: {}, contentWindow: { postMessage: (body, origin) => posts.push({ body, origin }) },
    removeAttribute(name) { if (name === 'src') node.src = ''; }, remove() { node.removed = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) };
  const descriptor = { handle, channel, origin: 'http://127.0.0.1:41415',
    url: 'http://127.0.0.1:41415/wallpaper-engine/scene-live/index.html?type=scene&src=project', fps: 60, properties: {} };
  const api = async (_, init) => { const body = JSON.parse(init.body); requests.push(body); return body.op === 'open' ? descriptor : { ok: true }; };
  let effects = { playing: true, fit: 'cover', audioEnabled: false, volume: 50 };
  const slot = createScenePreviewSlot({ node, project: { id: 'scene-a' }, client, window, api, getEffects: () => effects,
    onStatus: (state) => states.push(state), ...options });
  const send = (patch = {}, origin = descriptor.origin, source = node.contentWindow) => {
    for (const fn of listeners.get('message') ?? []) fn({ origin, source, data: { source: 'cwb-scene', channel,
      sequence: 1, phase: 'ready', width: 1920, height: 1080, layers: 13, draws: 10, fps: 59, ...patch } });
  };
  return { slot, node, posts, requests, states, listeners, listenerOptions, timers, intervals, send, descriptor, document,
    effects: (value) => { effects = { ...effects, ...value }; slot.update(); } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('the Scene poster remains through loading and preparation, then leaves after activation fade', async () => {
  let removed = 0, finish;
  const f = fixture({ poster: { remove() { removed++; } } });
  f.node.animate = () => ({ finished: new Promise(resolve => { finish = resolve; }), cancel() {} });
  await flush();
  assert.equal(f.node.style.opacity, '0');
  f.send({ phase: 'loading' }); f.send({ sequence: 2, draws: 0 });
  assert.equal(removed, 0);
  f.send({ sequence: 3 }); await f.slot.ready;
  assert.equal(f.node.style.opacity, '0');
  f.slot.activate();
  assert.equal(f.node.style.opacity, '');
  assert.equal(removed, 0);
  finish(); await flush(); assert.equal(removed, 1);
  await f.slot.release();
});

test('cancelling a loading Scene removes its poster and its startup watchdog', async () => {
  let removed = false;
  const f = fixture({ poster: { remove() { removed = true; } } });
  await flush(); await f.slot.release();
  assert.equal(removed, true);
  assert.equal(f.timers.size, 0);
});

test('workbench fallback tries embedded video first and advances only when candidate media fails', async () => {
  const project = { id: 'scene', type: 'scene', previewUrl: '/preview', embeddedVideoUrl: '/video' };
  const calls = [];
  const run = outcome => switchScenePreviewFallback(project, { mediaUrl: '/static' }, async (candidate, reason) => {
    calls.push([candidate.id, candidate.type, candidate.mediaUrl, reason]);
    return { ok: reason === outcome };
  }, () => true);
  assert.equal((await run('embedded_video')).fallbackReason, 'embedded_video');
  assert.deepEqual(calls.splice(0), [['scene', 'video', '/video', 'embedded_video']]);
  assert.equal((await run('preview')).fallbackReason, 'preview');
  assert.deepEqual(calls, [
    ['scene', 'video', '/video', 'embedded_video'], ['scene', 'image', '/static', 'custom_static'],
    ['scene', 'image', '/preview', 'preview'],
  ]);
});

test('M3 battery/visibility recovery keeps manual pause and mutes the exact GPU slot', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  f.effects({ pauseOnBattery: true, onBattery: true }); assert.equal(f.posts.at(-1).body.op, 'pause');
  f.effects({ playing: false, onBattery: false }); assert.equal(f.posts.at(-1).body.op, 'pause');
  f.document.hidden = true; for (const callback of f.listeners.get('visibilitychange')) callback();
  f.document.hidden = false; for (const callback of f.listeners.get('visibilitychange')) callback();
  assert.equal(f.posts.at(-1).body.op, 'pause');
  f.effects({ playing: true }); assert.equal(f.posts.at(-1).body.op, 'resume'); await f.slot.release();
});

test('M3 Scene slot accepts only spectrum, only while committed/visible/playing', async () => {
  const f = fixture(), audio = { op: 'audio', values: Array(128).fill(0.5) };
  await flush(); f.send(); await f.slot.ready; assert.equal(f.slot.input(audio), false);
  f.slot.activate(); assert.equal(f.slot.input(audio), true); assert.equal(f.posts.at(-1).body.op, 'audio');
  assert.equal(f.slot.input({ op: 'mediaStatus', value: { enabled: true } }), false);
  f.effects({ pauseOnBattery: true, onBattery: true }); assert.equal(f.slot.input(audio), false);
  f.effects({ onBattery: false }); f.document.hidden = true; assert.equal(f.slot.input(audio), false);
  f.document.hidden = false; assert.equal(f.slot.input(audio), true); await f.slot.release(); assert.equal(f.slot.input(audio), false);
});

test('M3 Web reverse control validates channel/origin, ignores replay and pauses before dispatch', async () => {
  const requests = [];
  const f = fixture({ project: { id: 'web', type: 'web' }, onMediaControl: async value => { requests.push(value); return { ok: true }; } });
  f.descriptor.type = 'web'; f.descriptor.resourceBase = f.descriptor.origin + '/' + 'd'.repeat(32) + '/files/project';
  f.descriptor.url = f.descriptor.resourceBase + '/index.html'; await flush();
  f.send({ source: 'cwb-web', phase: 'renderable', paintFrames: 2 }); await f.slot.ready; f.slot.activate();
  const message = { source: 'cwb-web-media-control', channel, requestId: 1, command: 'next', sessionId: 'e'.repeat(32) };
  const send = (patch = {}, origin = f.descriptor.origin) => { for (const callback of f.listeners.get('message')) callback({ origin, source: f.node.contentWindow, data: { ...message, ...patch } }); };
  send({}, 'https://evil.test'); send({ channel: 'wrong' }); send(); send(); await flush();
  assert.equal(requests.length, 1); assert.equal(f.posts.at(-1).body.op, 'mediaControlResult'); assert.equal(f.posts.at(-1).body.ok, true);
  f.effects({ pauseOnBattery: true, onBattery: true }); send({ requestId: 2 }); await flush(); assert.equal(requests.length, 1);
  await f.slot.release();
});
test('Scene preview waits for exact engine draw telemetry, not iframe load, and never leaks control capability to the source', async () => {
  const f = fixture(); await flush();
  assert.match(f.node.src, /scene-live/); assert.equal(f.node.sandbox, 'allow-scripts allow-same-origin');
  let ready = false; f.slot.ready.then(() => { ready = true; });
  for (const args of [[{}, 'http://evil.test'], [{ channel: 'wrong' }], [{}, f.descriptor.origin, {}],
    [{ phase: 'ready', draws: 0 }], [{ phase: 'ready', width: 0 }]]) f.send(...args);
  await flush(); assert.equal(ready, false);
  f.send(); await f.slot.ready; f.slot.activate();
  assert.equal(f.slot.stats().width, 1920); assert.equal(f.slot.stats().fps, 59);
  f.send({ sequence: 1, width: 800 }); assert.equal(f.slot.stats().width, 1920);
  assert.ok(f.posts.every((post) => post.origin === f.descriptor.origin && !JSON.stringify(post.body).includes(client)));
  await f.slot.release();
  assert.equal(f.requests.at(-1).op, 'close'); assert.equal(f.node.removed, true);
  assert.equal(f.listeners.get('message').size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.timers.size, 0);
});

test('Web GPU slot validates the capability-bound HTML entry and accepts only authenticated renderable telemetry', async () => {
  const f = fixture({ project: { id: 'web', type: 'web' } });
  f.descriptor.type = 'web';
  f.descriptor.resourceBase = f.descriptor.origin + '/' + 'd'.repeat(32) + '/files/project';
  f.descriptor.url = f.descriptor.resourceBase + '/sub/index.html';
  await flush();
  let ready = false; f.slot.ready.then(() => { ready = true; });
  f.send({ phase: 'renderable', source: 'cwb-web', paintFrames: 0 }); await flush(); assert.equal(ready, false);
  f.send({ phase: 'renderable', source: 'cwb-web', paintFrames: 2, propertiesSupported: true });
  await f.slot.ready; f.slot.activate();
  assert.equal(f.posts.at(-1).body.source, 'cwb-web-control');
  const request = f.slot.authorProperties({ enabled: { type: 'bool' } });
  f.send({ sequence: 2, phase: 'renderable', source: 'cwb-web', paintFrames: 2, propertiesSupported: true,
    propertyRequest: f.posts.at(-1).body.propertyRequest, properties: { enabled: false } });
  assert.equal((await request).method, 'author-delivery');
  await f.slot.release(); assert.equal(f.intervals.size, 0);
});

test('Web directory readback reports unavailable for a failed/loading catalog, even when property IDs are acknowledged', async () => {
  const f = fixture({ project: { id: 'web', type: 'web' } });
  f.descriptor.type = 'web'; f.descriptor.resourceBase = f.descriptor.origin + '/' + 'd'.repeat(32) + '/files/project';
  f.descriptor.url = f.descriptor.resourceBase + '/index.html';
  await flush(); f.send({ phase: 'renderable', source: 'cwb-web', paintFrames: 2, propertiesSupported: true }); await f.slot.ready; f.slot.activate();
  let sequence = 1;
  const schema = { photos: { type: 'directory', default: '', mode: 'fetchall' } };
  for (const directoryStatus of ['loading', 'failed', 'ready']) {
    const request = f.slot.authorProperties(schema);
    f.send({ sequence: ++sequence, phase: 'renderable', source: 'cwb-web', paintFrames: 2, propertiesSupported: true, directoryStatus,
      propertyRequest: f.posts.at(-1).body.propertyRequest, properties: { photos: '' } });
    assert.equal((await request).phase, directoryStatus === 'ready' ? 'ready' : 'unavailable');
  }
  await f.slot.release();
});

test('Web GPU descriptors reject traversal, non-HTML and another capability directory', async () => {
  for (const tail of ['/outside/index.html', '/' + 'd'.repeat(32) + '/files/project/index.js', '/' + 'd'.repeat(32) + '/files/project/%2e%2e/secret.html']) {
    const f = fixture({ project: { id: 'web', type: 'web' } });
    f.descriptor.resourceBase = f.descriptor.origin + '/' + 'd'.repeat(32) + '/files/project';
    f.descriptor.type = 'web'; f.descriptor.url = f.descriptor.origin + tail;
    await assert.rejects(f.slot.ready, /preview_descriptor_invalid/); await f.slot.release();
  }
});

test('typed Web input only reaches a visible playing committed slot and stops at retirement/release', async () => {
  const f = fixture({ project: { id: 'web', type: 'web' } });
  f.descriptor.type = 'web'; f.descriptor.resourceBase = f.descriptor.origin + '/' + 'd'.repeat(32) + '/files/project';
  f.descriptor.url = f.descriptor.resourceBase + '/index.html';
  const audio = { op: 'audio', values: Array(128).fill(0.5) };
  await flush(); assert.equal(f.slot.input(audio), false);
  f.send({ phase: 'renderable', source: 'cwb-web', paintFrames: 2 }); await f.slot.ready;
  assert.equal(f.slot.input(audio), false); f.slot.activate();
  assert.equal(f.slot.input(audio), true); assert.equal(f.posts.at(-1).body.op, 'audio');
  assert.equal(f.posts.at(-1).origin, f.descriptor.origin);
  for (const input of [{ op: 'mediaStatus', value: { enabled: true } }, { op: 'mediaThumbnail', value: { thumbnail: '' } }]) {
    assert.equal(f.slot.input(input), true); assert.deepEqual(f.posts.at(-1).body.value, input.value);
    assert.equal(f.posts.at(-1).body.op, input.op); assert.equal(f.posts.at(-1).origin, f.descriptor.origin);
  }
  assert.equal(f.slot.input({ ...audio, command: 'run' }), false);
  f.document.hidden = true; assert.equal(f.slot.input(audio), false); f.document.hidden = false;
  f.effects({ playing: false }); assert.equal(f.slot.input(audio), false);
  f.effects({ playing: true }); assert.equal(f.slot.input(audio), true);
  f.slot.retire(); assert.equal(f.slot.input(audio), false);
  await f.slot.release(); assert.equal(f.slot.input(audio), false);
  const scene = fixture(); await flush(); scene.send(); await scene.slot.ready; scene.slot.activate();
  assert.equal(scene.slot.input(audio), true);
  assert.equal(scene.slot.input({ op: 'mediaStatus', value: { enabled: true } }), false); await scene.slot.release();
});
test('cancelled pending open releases its eventual descriptor without attaching a frame or reviving a slot', async () => {
  let finish;
  const f = fixture({ api: async (_, init) => {
    const body = JSON.parse(init.body); f.requests.push(body);
    if (body.op === 'open') return new Promise((resolve) => { finish = () => resolve(f.descriptor); });
    return { ok: true };
  } });
  await flush(); const released = f.slot.release(); finish(); await released;
  await assert.rejects(f.slot.ready, /preview_cancelled/);
  assert.ok(!f.node.src); assert.equal(f.requests.at(-1).op, 'close'); assert.equal(f.intervals.size, 0);
});
test('hidden/playback changes preserve user intent, mute retired slots and whitelist layout/volume controls', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  f.effects({ audioEnabled: true, volume: 15, fit: 'contain' });
  assert.equal(f.posts.findLast((p) => p.body.op === 'volume').body.value, .15);
  f.document.hidden = true; f.slot.update();
  assert.equal(f.posts.at(-1).body.op, 'pause');
  assert.equal(f.posts.findLast((p) => p.body.op === 'volume').body.value, 0);
  f.document.hidden = false; f.slot.update(); assert.equal(f.posts.at(-1).body.op, 'resume');
  assert.equal(f.posts.findLast((p) => p.body.op === 'volume').body.value, .15);
  f.effects({ playing: false });
  assert.equal(f.posts.findLast((p) => p.body.op === 'volume').body.value, 0);
  f.slot.retire(); assert.equal(f.posts.findLast((p) => p.body.op === 'volume').body.value, 0);
  await f.slot.release();
});
test('GPU pointer respects visible active playback, mirrors coordinates, and never consumes host events', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  const move = (extra = {}) => {
    const event = { type: 'pointermove', clientX: 480, clientY: 270, buttons: 0,
      preventDefault() { throw Error('host_event_consumed'); }, stopPropagation() { throw Error('host_event_consumed'); }, ...extra };
    for (const fn of f.listeners.get(event.type) ?? []) fn(event);
  };
  move(); assert.equal(f.posts.at(-1).body.op, 'pointer'); assert.equal(f.posts.at(-1).body.u, .25);
  f.effects({ mirror: true }); move(); assert.equal(f.posts.at(-1).body.u, .75);
  move({ clientX: -1 }); assert.equal(f.posts.at(-1).body.op, 'pointerLeave');
  assert.equal(f.slot.stats().pointerBlocked, 'outside');
  assert.equal(f.slot.stats().pointerReceived, 3); assert.equal(f.slot.stats().pointerForwarded, 2);
  const before = f.posts.length; f.document.hidden = true; move(); assert.equal(f.posts.length, before);
  assert.equal(f.slot.stats().pointerBlocked, 'hidden');
  f.document.hidden = false;
  move({ type: 'pointerdown', target: { closest: () => ({}) }, buttons: 1 }); assert.equal(f.posts.length, before);
  f.effects({ playing: false }); const paused = f.posts.length; move(); assert.equal(f.posts.length, paused);
  assert.equal(f.slot.stats().pointerBlocked, 'paused');
  f.slot.retire(); const retired = f.posts.length; move(); assert.equal(f.posts.length, retired);
  await f.slot.release();
});
test('GPU pointer capture survives host bubble cancellation but never turns a control drag into a Scene click', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  const event = (type, buttons, interactive = false) => {
    for (const fn of f.listeners.get(type) ?? []) fn({ type, buttons, clientX: 480, clientY: 270,
      target: { closest: () => interactive ? {} : null } });
  };
  for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
    assert.equal(f.listenerOptions.get(type)?.capture, true);
    assert.equal(f.listenerOptions.get(type)?.passive, true);
  }
  event('pointerdown', 1, true); event('pointermove', 1);
  assert.equal(f.posts.at(-1).body.buttons, 0);
  event('pointerdown', 1); assert.equal(f.posts.at(-1).body.buttons, 1);
  event('pointerup', 0, true); assert.equal(f.posts.at(-1).body.op, 'pointerLeave');
  event('pointermove', 0); assert.equal(f.posts.at(-1).body.buttons, 0);
  await f.slot.release();
});
test('forged descriptor URLs fail closed, timeout never claims real readiness, and pagehide clears a source', async () => {
  const invalid = fixture({ api: async () => ({ handle, channel, origin: 'http://evil.test', url: 'file:///x' }) });
  await assert.rejects(invalid.slot.ready, /preview_descriptor_invalid/); await invalid.slot.release();
  const timed = fixture(); await flush(); [...timed.timers][0]();
  await assert.rejects(timed.slot.ready, /preview_first_frame_timeout/); await timed.slot.release();
  const hidden = fixture(); await flush(); hidden.send(); await hidden.slot.ready;
  for (const fn of hidden.listeners.get('pagehide')) fn(); await flush();
  assert.equal(hidden.intervals.size, 0); assert.equal(hidden.requests.at(-1).op, 'close');
});

test('author readback waits for exact request acknowledgement and reads real typed values, not the saved echo', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  const schema = { enabled: { type: 'bool' }, speed: { type: 'slider', min: 0, max: 10 } };
  const reading = f.slot.authorProperties(schema, { enabled: false });
  const request = f.posts.at(-1).body;
  assert.equal(request.op, 'properties'); assert.ok(Number.isSafeInteger(request.propertyRequest));
  let finished = false; reading.then(() => { finished = true; });
  f.send({ sequence: 2, propertyRequest: request.propertyRequest + 1, properties: { enabled: false } });
  f.send({ sequence: 3, propertyRequest: request.propertyRequest, properties: { enabled: false } }, 'http://evil.test');
  await flush(); assert.equal(finished, false);
  f.send({ sequence: 3, propertyRequest: request.propertyRequest, properties: { enabled: true, speed: 99, unknown: 'discard' } });
  const live = await reading;
  assert.equal(live.phase, 'ready'); assert.equal(live.method, 'engine-readback'); assert.equal(live.source, 'workbench-preview');
  assert.deepEqual(live.values, { enabled: true }); assert.equal(live.rejected, 1);
  const second = f.slot.authorProperties(schema);
  assert.equal(f.posts.at(-1).body.op, 'readProperties');
  f.send({ sequence: 4, propertyRequest: request.propertyRequest, properties: { enabled: false } });
  f.send({ sequence: 5, propertyRequest: f.posts.at(-1).body.propertyRequest, properties: { enabled: false, speed: 2 } });
  assert.deepEqual((await second).values, { enabled: false, speed: 2 });
  await f.slot.release(); assert.equal(f.timers.size, 0);
});

test('author requests are single-flight, bounded by timeout, and cancelled on source release', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  const schema = { enabled: { type: 'bool' } };
  const timed = f.slot.authorProperties(schema);
  await assert.rejects(f.slot.authorProperties(schema), /preview_properties_busy/);
  [...f.timers][0](); await assert.rejects(timed, /preview_properties_timeout/);
  const cancelled = f.slot.authorProperties(schema); const check = assert.rejects(cancelled, /preview_cancelled/);
  await f.slot.release(); await check;
  await assert.rejects(f.slot.authorProperties(schema), /preview_properties_unavailable/);
  assert.equal(f.timers.size, 0);
});

test('an acknowledgement with no valid engine values cannot claim that actual author readback was obtained', async () => {
  const f = fixture(); await flush(); f.send(); await f.slot.ready; f.slot.activate();
  const reading = f.slot.authorProperties({ enabled: { type: 'bool' } });
  f.send({ sequence: 2, propertyRequest: f.posts.at(-1).body.propertyRequest, properties: { enabled: 'not-a-bool' } });
  const live = await reading;
  assert.equal(live.phase, 'unavailable'); assert.equal(live.method, 'none');
  assert.deepEqual(live.values, {}); assert.equal(live.rejected, 1);
  await f.slot.release();
});
