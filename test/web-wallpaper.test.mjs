import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createReadonlyWallpaperServer } from '../bridge-runtime/src/scene-server.mjs';
import { validateAuthorPropertyPatch, mapAuthorFileProperties, normalizeAuthorProperties } from '../bridge-runtime/src/author-properties.mjs';
import { validateWebWallpaperInput } from '../bridge-runtime/src/web-wallpaper-input.mjs';

async function fixture(t, file = 'index.html') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type: 'web', file,
    general: { properties: { enabled: { type: 'bool', value: true } } } }));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><script>window.author=true</script></head><body>web</body></html>');
  await writeFile(path.join(root, 'style.css'), 'body{color:red}');
  await writeFile(path.join(root, 'model.moc3'), 'model');
  const server = createReadonlyWallpaperServer({ project: { id: 'web', type: 'web', rootPath: root }, parentOrigin: 'http://127.0.0.1:41234' });
  t.after(() => server.close()); return server;
}
test('web HTML is isolated readonly and shim precedes author inline scripts; styles/Live2D data have MIME', async (t) => {
  const server = await fixture(t); await server.start();
  const response = await fetch(server.rendererUrl), html = await response.text();
  assert.ok(html.indexOf('/cwb-web-bridge.js') < html.indexOf('window.author'));
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'unsafe-inline'/); assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /script-src[^;]*'unsafe-eval'/); // local procedural shader generation, never the host origin
  assert.match(csp, /sandbox allow-scripts allow-same-origin/); assert.doesNotMatch(csp, /connect-src[^;]*41234/);
  assert.equal((await fetch(server.resourceBase + '/style.css')).headers.get('content-type'), 'text/css');
  assert.equal((await fetch(server.resourceBase + '/model.moc3')).status, 200);
  assert.equal((await fetch(server.origin + '/api/config', { method: 'POST' })).status, 405);
  assert.equal((await fetch(server.origin + '/api/config')).status, 404);
  assert.deepEqual(server.authorProperties.values, { enabled: true });
  const values = server.authorProperties; values.values.enabled = false;
  assert.equal(server.authorProperties.values.enabled, true);
});
test('web entry traversal, external URL and non-HTML entry fail before listening', async (t) => {
  for (const name of ['../index.html', 'https://evil.test/index.html', 'x.exe', '/index.html']) {
    const server = await fixture(t, name); await assert.rejects(server.start(), /manifest/); assert.equal(server.origin, null);
  }
});

const bridge = await readFile(new URL('../bridge-runtime/public/cwb-web-bridge.js', import.meta.url), 'utf8');
async function browserFixture(properties = { schema: { enabled: { type: 'bool' } }, values: { enabled: true } }, directoryFetch = async () => ({ files: [] })) {
  const events = new Map(), messages = [], callbacks = [], media = [], clicks = [], parent = { postMessage: (v) => messages.push(v) };
  const singleOption = { disabled: false, getAttribute: () => null, click: () => { document.body.dataset.playbackMode = 'single'; clicks.push('single'); } };
  const modeButton = { getAttribute: () => null, click: () => clicks.push('mode') };
  const window = { parent, innerWidth: 800, innerHeight: 450, __cwbValidateProperties: validateAuthorPropertyPatch, __cwbMapFileProperties: mapAuthorFileProperties,
    __cwbValidateWebInput: validateWebWallpaperInput,
    wallpaperPropertyListener: { applyUserProperties: (v) => callbacks.push(['props', v]), applyGeneralProperties: (v) => callbacks.push(['general', v]) },
    addEventListener: (k, fn) => events.set(k, fn), removeEventListener: (k) => events.delete(k),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  let ticks = 0, clears = 0;
  const document = { body: { dataset: {} }, querySelector: (selector) => selector === '[data-playback="single"]' ? singleOption : ({ content: 'a'.repeat(32) }), getElementById: (id) => id === 'modeButton' ? modeButton : null, querySelectorAll: () => media };
  vm.runInNewContext(bridge, { window, document, Event,
    AbortController, URL, performance: { now: () => 0 }, requestAnimationFrame: (fn) => fn(), setInterval: (fn) => { ticks++; return ticks; }, clearInterval: () => clears++,
    fetch: async (url, options) => url.includes('/author-directory/') ? { ok: true, json: () => directoryFetch(url, options) } : ({ ok: true, json: async () => ({ parentOrigin: 'http://127.0.0.1:41234', channel: 'trusted',
      resourceBase: 'http://127.0.0.1:42342/' + 'a'.repeat(32) + '/files/project', authorProperties: properties }) }) });
  await new Promise((resolve) => setImmediate(resolve)); events.get('load')(); await new Promise(resolve => setImmediate(resolve));
  const send = (op, patch = {}, extra = {}) => events.get('message')?.({ source: parent, origin: 'http://127.0.0.1:41234',
    data: { source: 'cwb-web-control', channel: 'trusted', op, ...patch }, ...extra });
  return { window, document, events, messages, callbacks, media, clicks, send, clears: () => clears };
}
test('Web single-loop hold delays the author ended event by the configured dwell', async () => {
  const f = await browserFixture();
  assert.equal(f.window.__cwbWeb.phase, 'renderable');
  f.document.body.dataset.playbackMode = 'single';
  f.send('loopHold', { value: 1 });
  assert.equal(f.window.__cwbWeb.webLoopHoldSeconds, 1);
  let stopped = false; const dispatched = [];
  const media = { tagName: 'VIDEO', dispatchEvent: (event) => dispatched.push(event) };
  f.events.get('ended')({ target: media, stopImmediatePropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(dispatched.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'ended');
  assert.equal(dispatched[0].__cwbLoopHoldBypass, true);
});
test('Web single-loop forcing restores single mode without pointer input', async () => {
  const f = await browserFixture();
  f.document.body.dataset.playbackMode = 'freeze';
  f.send('forceSingleLoop', { value: true });
  assert.equal(f.window.__cwbWeb.forceSingleLoop, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.document.body.dataset.playbackMode, 'single');
  assert.deepEqual(f.clicks, ['mode', 'single']);
});

test('Web shim readiness is only renderable, never author-reported first-frame proof', async () => {
  const f = await browserFixture(); assert.equal(f.window.__cwbWeb.phase, 'renderable');
  assert.equal(f.window.require, undefined); assert.equal(typeof f.window.wallpaperRequestRandomFileForProperty, 'function');
  assert.equal(f.callbacks[0][0], 'props'); assert.equal(f.callbacks[0][1].enabled.value, true);
});
test('Web file callbacks receive a readonly resource URL, while acknowledged telemetry keeps the stable ID', async () => {
  const properties = normalizeAuthorProperties({ picture: { type: 'file', filetype: 'image', value: '' } });
  const f = await browserFixture(properties);
  const id = 'cwb-author-files/' + 'a'.repeat(32) + '-' + 'b'.repeat(32) + '-' + 'c'.repeat(64) + '.png';
  f.send('properties', { values: { picture: id }, propertyRequest: 7 });
  assert.equal(f.callbacks.at(-1)[1].picture.value, 'http://127.0.0.1:42342/' + 'a'.repeat(32) + '/files/project/' + id);
  assert.equal(f.window.__cwbWeb.properties.picture, id); assert.equal(f.window.__cwbWeb.propertyRequest, 7);
  const revision = f.window.__cwbWeb.propertyRevision;
  f.send('properties', { values: { picture: 'file:///C:/private.png' } });
  assert.equal(f.window.__cwbWeb.propertyRevision, revision);
  f.send('resetProperties'); assert.equal(f.callbacks.at(-1)[1].picture.value, '');
});
test('the updated Web bridge preserves ordinary controls on an already running pre-file-mapping server', async () => {
  const f = await browserFixture(); delete f.window.__cwbMapFileProperties;
  f.send('properties', { values: { enabled: false } });
  assert.equal(f.callbacks.at(-1)[1].enabled.value, false); assert.equal(f.window.__cwbWeb.properties.enabled, false);
});
test('Web shim controls validate source/origin/channel, property types and do not execute a path/op', async () => {
  const f = await browserFixture();
  f.send('properties', { values: { enabled: false } }, { origin: 'evil' });
  f.send('properties', { values: { enabled: false } }, { source: {} });
  f.send('properties', { values: { enabled: false }, channel: 'wrong' });
  f.send('properties', { values: { enabled: 'false' } }); f.send('execute', { path: 'file:///secret' });
  assert.equal(f.window.__cwbWeb.propertyRevision, 0);
  f.send('properties', { values: { enabled: false } }); assert.equal(f.window.__cwbWeb.properties.enabled, false);
  f.send('resetProperties'); assert.equal(f.window.__cwbWeb.properties.enabled, true);
  f.send('pause'); assert.equal(f.window.__cwbWeb.pausedRequested, true);
});
test('audio/media callback payloads are bounded typed copies; system stream/control not fabricated', async () => {
  const f = await browserFixture(), audio = [], metadata = [];
  f.window.wallpaperRegisterAudioListener((v) => audio.push(v));
  f.window.wallpaperRegisterMediaPropertiesListener((v) => metadata.push(v));
  f.send('audio', { values: Array(128).fill(0.5) }); f.send('audio', { values: Array(128).fill(Infinity) });
  f.send('audio', { values: Array(129).fill(0) }); assert.equal(audio.length, 1);
  f.send('media', { value: { title: 'Track', artist: 'Artist', album: '', state: 'playing', position: 1, duration: 100, command: 'reject' } });
  assert.equal(metadata.length, 0);
  f.send('media', { value: { title: 'Track', artist: 'Artist', album: '', state: 'playing', position: 1, duration: 100 } });
  assert.equal(metadata.length, 1); assert.equal(metadata[0].command, undefined);
  f.send('media', { value: { title: 'bad', artist: '', album: '', state: 'playing', position: 101, duration: 100 } });
  assert.equal(metadata.length, 1);
  f.send('pause'); f.send('audio', { values: Array(128).fill(0.5) });
  assert.equal(audio.length, 1);
  f.send('resume'); f.send('audio', { values: Array(128).fill(0.5) });
  assert.equal(audio.length, 2);
});
test('release/pagehide removes callbacks and listeners; later messages cannot resurrect the shim', async () => {
  const f = await browserFixture(); f.send('release'); f.send('resume');
  assert.equal(f.window.__cwbWeb.phase, 'released'); assert.equal(f.events.has('message'), false); assert.ok(f.clears());
});

test('unchanged Web media snapshots do not repeat author work; audio and changed timeline still stream', async () => {
  const f = await browserFixture(), calls = { properties: 0, thumbnail: 0, lyrics: 0, audio: 0, timeline: 0 };
  f.window.wallpaperRegisterMediaPropertiesListener(() => calls.properties++);
  f.window.wallpaperRegisterMediaThumbnailListener(() => calls.thumbnail++);
  f.window.cwbMediaIntegration.registerLyricsListener(() => calls.lyrics++);
  f.window.wallpaperRegisterAudioListener(() => calls.audio++);
  f.window.wallpaperRegisterMediaTimelineListener(() => calls.timeline++);
  await new Promise(resolve => setImmediate(resolve));
  const track = { title: 'Track', artist: 'Artist', album: '', state: 'playing', position: 1, duration: 100 };
  f.send('media', { value: track }); f.send('lyrics', { value: { text: 'line', next: '' } });
  const cover = { thumbnail: '', primaryColor: '#abcdef' };
  f.send('mediaThumbnail', { value: cover });
  const initial = { ...calls };
  for (let i = 0; i < 100; i++) {
    f.send('media', { value: track }); f.send('lyrics', { value: { text: 'line', next: '' } });
    f.send('mediaThumbnail', { value: cover });
  }
  assert.deepEqual(calls, initial);
  f.send('media', { value: { ...track, position: 2 } });
  assert.equal(calls.properties, initial.properties); assert.equal(calls.timeline, initial.timeline + 1);
  for (let i = 0; i < 2; i++) f.send('audio', { values: Array(128).fill(0) });
  assert.equal(calls.audio, 2);
  f.send('mediaStatus', { value: { enabled: false } }); const cleared = { ...calls };
  for (let i = 0; i < 100; i++) f.send('mediaStatus', { value: { enabled: false } });
  assert.deepEqual(calls, cleared);
  f.send('media', { value: track }); assert.equal(calls.properties, cleared.properties + 1);
  f.send('pause'); f.send('lyrics', { value: { text: 'one', next: '' } }); f.send('lyrics', { value: { text: 'two', next: '' } });
  assert.equal(calls.lyrics, cleared.lyrics); f.send('resume'); assert.equal(calls.lyrics, cleared.lyrics + 1);
  f.send('release');
});

test('media missing APIs replay copied latest events asynchronously, suspend on pause, clear on disable and release', async () => {
  const f = await browserFixture(), events = [], cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfAAAAABJRU5ErkJggg==';
  assert.deepEqual({ ...f.window.wallpaperMediaIntegration }, { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 });
  f.send('mediaStatus', { value: { enabled: true } });
  f.send('mediaThumbnail', { value: { thumbnail: cover, primaryColor: '#abcdef' } });
  f.window.wallpaperRegisterMediaThumbnailListener(value => { events.push(['cover', value.thumbnail]); value.thumbnail = 'mutated'; });
  f.window.wallpaperRegisterMediaStatusListener(value => events.push(['status', value.enabled]));
  assert.equal(events.length, 0); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['cover', cover], ['status', true]]);
  const replay = []; f.window.wallpaperRegisterMediaThumbnailListener(value => replay.push(value.thumbnail));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(replay, [cover]);
  f.send('pause'); f.send('mediaThumbnail', { value: { thumbnail: '' } }); assert.equal(replay.length, 1);
  f.send('resume'); assert.deepEqual(replay, [cover, '']);
  f.send('mediaStatus', { value: { enabled: false } }); assert.equal(events.at(-1)[1], false);
  const count = replay.length; f.send('release');
  f.window.wallpaperRegisterMediaThumbnailListener(() => replay.push('stale'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(replay.length, count);
});

test('directory notification diff, late listener, random file and empty/reset use only a checked private catalog', async () => {
  const props = normalizeAuthorProperties({ photos: { type: 'directory', mode: 'fetchall', filetype: 'image', value: 'defaults' } });
  const base = 'http://127.0.0.1:42342/' + 'a'.repeat(32) + '/files/project/';
  let inventory = [{ url: base + 'defaults/one.png', version: '1'.repeat(64) }];
  const f = await browserFixture(props, async url => new URL(url, base).searchParams.get('value') === '' ? { files: [] } : { files: inventory });
  const calls = []; f.window.wallpaperPropertyListener = null;
  f.window.wallpaperPropertyListener = { userDirectoryFilesAddedOrChanged: (key, files) => calls.push(['added', key, [...files]]),
    userDirectoryFilesRemoved: (key, files) => calls.push(['removed', key, [...files]]) };
  assert.equal(calls.length, 0); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['added', 'photos', [base + 'defaults/one.png']]]);
  let random;
  f.window.wallpaperRequestRandomFileForProperty('photos', (key, file) => { random = [key, file]; });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(random, ['photos', base + 'defaults/one.png']);
  inventory = [{ url: base + 'defaults/one.png', version: '2'.repeat(64) }, { url: base + 'defaults/two.png', version: '3'.repeat(64) }];
  f.send('properties', { values: { photos: 'defaults' }, propertyRequest: 11 }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['added', 'photos', inventory.map(file => file.url)]);
  assert.equal(f.window.__cwbWeb.propertyRequest, 11);
  f.send('properties', { values: { photos: '' } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['removed', 'photos', inventory.map(file => file.url)]);
  f.window.wallpaperRequestRandomFileForProperty('photos', (_key, file) => { random = file; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(random, '');
  f.send('resetProperties'); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.window.__cwbWeb.directoryStatus, 'ready');
});

test('directory async fetch completion cannot revive an old selection, cross-origin file or released frame', async () => {
  const props = normalizeAuthorProperties({ photos: { type: 'directory', mode: 'fetchall', value: '' } });
  let finish; const requests = [];
  const f = await browserFixture(props, (_url, options) => { requests.push(options); return new Promise(resolve => { finish = resolve; }); });
  const calls = []; f.window.wallpaperPropertyListener.userDirectoryFilesAddedOrChanged = (...args) => calls.push(args);
  const id = 'cwb-author-directories/' + 'a'.repeat(32) + '-' + 'b'.repeat(32) + '-' + 'c'.repeat(64) + '.json';
  f.send('properties', { values: { photos: id }, propertyRequest: 5 });
  await new Promise(resolve => setImmediate(resolve));
  f.send('properties', { values: { photos: '' }, propertyRequest: 6 });
  finish({ files: [{ url: 'http://evil.test/a.png', version: 'a'.repeat(64) }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 0);
  assert.equal(f.window.__cwbWeb.propertyRequest, 6); assert.equal(f.window.__cwbWeb.properties.photos, '');
  f.send('properties', { values: { photos: id }, propertyRequest: 7 }); await new Promise(resolve => setImmediate(resolve)); f.send('release');
  finish({ files: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.window.__cwbWeb.phase, 'released'); assert.ok(requests.every(request => request.signal.aborted));
});

test('ondemand directory uses property callback and random access, not fetchall notifications; React replacement never loops', async () => {
  const props = normalizeAuthorProperties({ photos: { type: 'directory', mode: 'ondemand', value: 'defaults' } });
  const base = 'http://127.0.0.1:42342/' + 'a'.repeat(32) + '/files/project/';
  const f = await browserFixture(props, async () => ({ files: [{ url: base + 'defaults/one.png', version: 'a'.repeat(64) }] }));
  assert.equal(f.callbacks[0][1].photos.value, 'defaults');
  let additions = 0, replays = 0;
  f.window.wallpaperPropertyListener = { applyUserProperties: () => replays++, userDirectoryFilesAddedOrChanged: () => additions++ };
  for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(additions, 0); assert.equal(replays, 0);
  let random; f.window.wallpaperRequestRandomFileForProperty('photos', (_key, url) => { random = url; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(random, base + 'defaults/one.png');
});
test('fetchall-only directories never call applyUserProperties with an empty patch, including late registration', async () => {
  const props = normalizeAuthorProperties({ photos: { type: 'directory', mode: 'fetchall', value: '' } });
  const f = await browserFixture(props);
  assert.equal(f.callbacks.filter(([name]) => name === 'props').length, 0);
  f.send('properties', { values: { photos: '' } }); f.send('resetProperties');
  assert.equal(f.callbacks.filter(([name]) => name === 'props').length, 0);
  let calls = 0;
  f.window.wallpaperPropertyListener = null;
  f.window.wallpaperPropertyListener = { applyUserProperties: () => calls++, userDirectoryFilesAddedOrChanged() {} };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); f.send('release');
});

test('late property listener receives the current FPS, volume and paused state once', async () => {
  const f = await browserFixture(), general = [], pauses = [];
  f.window.wallpaperPropertyListener = null;
  f.send('volume', { value: 0.25 }); f.send('pause');
  f.window.wallpaperPropertyListener = { applyUserProperties() {}, applyGeneralProperties: value => general.push({ ...value }),
    setPaused: value => pauses.push(value) };
  assert.equal(general.length, 0); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(general, [{ fps: 60, audiovolume: 25, paused: true }]);
  assert.deepEqual(pauses, [true]); f.send('release');
});

test('current unsafe/oversize catalog yields failed status and empty random access, never a successful directory delivery', async () => {
  const props = normalizeAuthorProperties({ photos: { type: 'directory', mode: 'fetchall', value: 'defaults' } });
  for (const files of [[{ url: 'file:///C:/secret.png', version: 'a'.repeat(64) }],
    Array(129).fill({ url: 'http://evil.test/a.png', version: 'a'.repeat(64) })]) {
    const f = await browserFixture(props, async () => ({ files }));
    assert.equal(f.window.__cwbWeb.directoryStatus, 'failed');
    let random; f.window.wallpaperRequestRandomFileForProperty('photos', (_key, url) => { random = url; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(random, ''); f.send('release');
  }
});

test('Web GPU properties acknowledge only valid matching requests without claiming engine readback', async () => {
  const f = await browserFixture();
  assert.equal(f.window.__cwbWeb.paintFrames, 2);
  f.send('readProperties', { propertyRequest: 5 }); assert.equal(f.window.__cwbWeb.propertyRequest, 5);
  f.send('properties', { propertyRequest: 6, values: { enabled: false } });
  assert.equal(f.window.__cwbWeb.propertyRequest, 6); assert.equal(f.window.__cwbWeb.properties.enabled, false);
  f.send('properties', { propertyRequest: 0, values: { enabled: true } });
  assert.equal(f.window.__cwbWeb.propertyRevision, 1);
  f.send('release');
});

test('Web direct pause holds author rAF and functional timers, resumes intent once, and release disposes pending work', async () => {
  const events = new Map(), rafs = new Map(), timers = new Map(), intervals = new Map();
  let serial = 0, time = 0, frames = 0, timeoutCalls = 0, intervalCalls = 0;
  const parent = { postMessage() {} };
  const window = { parent, innerWidth: 800, innerHeight: 450, __cwbValidateProperties: validateAuthorPropertyPatch, __cwbMapFileProperties: mapAuthorFileProperties,
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key),
    requestAnimationFrame: fn => { rafs.set(++serial, fn); return serial; }, cancelAnimationFrame: id => rafs.delete(id),
    setTimeout: (fn, delay) => { timers.set(++serial, { fn, due: time + delay }); return serial; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++serial, fn); return serial; }, clearInterval: id => intervals.delete(id) };
  const nativeRaf = window.requestAnimationFrame, nativeTimeout = window.setTimeout;
  const date = { now: () => time };
  vm.runInNewContext(bridge, { window, Date: date, performance: { now: () => time },
    document: { querySelector: () => ({ content: 'a'.repeat(32) }), querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, json: async () => ({ channel: 'trusted', parentOrigin: 'http://127.0.0.1:41234',
      authorProperties: { schema: {}, values: {} } }) }) });
  await new Promise(resolve => setImmediate(resolve)); events.get('load')();
  const frame = () => { const batch = [...rafs.values()]; rafs.clear(); batch.forEach(fn => fn(time)); };
  frame(); frame(); assert.equal(window.__cwbWeb.phase, 'renderable');
  const send = op => events.get('message')?.({ source: parent, origin: 'http://127.0.0.1:41234', data: { source: 'cwb-web-control', channel: 'trusted', op } });
  window.requestAnimationFrame(() => frames++);
  window.setTimeout(() => timeoutCalls++, 100);
  const recurring = window.setInterval(() => intervalCalls++, 100);
  time = 40; send('pause'); assert.equal(rafs.size, 0); assert.equal(timers.size, 0);
  time = 1000; frame(); assert.equal(frames, 0); assert.equal(timeoutCalls, 0);
  send('resume'); assert.equal(rafs.size, 1); assert.equal(timers.size, 2); frame(); assert.equal(frames, 1);
  time += 60; const batch = [...timers.entries()]; for (const [id, task] of batch) if (task.due <= time) { timers.delete(id); task.fn(); }
  assert.equal(timeoutCalls, 1); assert.equal(intervalCalls, 1);
  window.clearInterval(recurring); assert.equal(timers.size, 0);
  window.requestAnimationFrame(() => frames++); window.setTimeout(() => timeoutCalls++, 10);
  send('release'); assert.equal(rafs.size, 0); assert.equal(timers.size, 0); assert.equal(intervals.size, 0);
  assert.notEqual(window.requestAnimationFrame, nativeRaf); // bound native restored, not the adapter
  assert.notEqual(window.setTimeout, nativeTimeout);
  window.requestAnimationFrame(() => {}); assert.equal(rafs.size, 1);
});
