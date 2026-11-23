import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createMediaSwitcher } from '../bridge-runtime/src/media-switch.mjs';
import { createMediaServer } from '../bridge-runtime/src/media-server.mjs';

const source = await readFile(new URL('../bridge-overrides/src/injected-renderer.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const mountMedia = (wallpaper) =>');
const end = source.indexOf('const syncPlayback = () =>', start);
assert.ok(start > 0 && end > start);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const slots = [], states = [];
  let retry = false;
  const context = { current: { effects: {} }, currentMediaIdentity: null, scenePreload: null,
    mediaState: { state: 'idle' }, mediaIdentity: wallpaper => wallpaper.id,
    nativeMedia: { state: () => ({ retryRequested: retry }) }, sceneMedia: { retryRequested: () => retry },
    updateMediaState(state, detail = null) { context.mediaState = { state, detail }; states.push(state); },
    releaseMedia() { context.mediaSwitcher.clear(); context.currentMediaIdentity = null; context.updateMediaState('idle'); },
  };
  context.mediaSwitcher = createMediaSwitcher({ timeoutMs: 1000,
    create() {
      let resolve, reject;
      const slot = { ready: new Promise((a, b) => { resolve = a; reject = b; }),
        resolve: () => { retry = false; resolve(); }, reject, updates: 0, disposed: false,
        update() { this.updates++; } };
      slots.push(slot); return slot;
    },
    commit(slot) { context.currentMediaIdentity = slot.identity; context.updateMediaState('ready'); },
    dispose(slot) { slot.disposed = true; },
  });
  t.after(() => context.mediaSwitcher.close());
  return { context, slots, states, retry: () => { retry = true; },
    mount: runInNewContext(source.slice(start, end) + '\nmountMedia', context) };
}

for (const playable of ['image', 'video', 'web', 'native', 'direct-gpu']) {
  test(`${playable}: repeated apply and effect changes reuse ready media without entering loading`, async t => {
    const f = fixture(t), wallpaper = { id: 'current', playable };
    const first = f.mount(wallpaper); assert.equal(f.context.mediaState.state, 'loading');
    f.slots[0].resolve(); assert.equal((await first).ok, true);
    f.states.length = 0;
    for (let i = 0; i < 3; i++) {
      f.context.current.effects = { brightness: 70 + i, playing: i !== 1 };
      assert.equal((await f.mount(wallpaper)).reused, true);
      assert.equal(f.context.mediaState.state, 'ready');
    }
    assert.equal(f.slots.length, 1); assert.equal(f.slots[0].disposed, false);
    assert.deepEqual(f.states, [], 'a reused slot must not advertise a new loading operation');
  });
}

test('reuse does not relabel a real playback or decode failure as ready', async t => {
  const f = fixture(t), wallpaper = { id: 'current', playable: 'video' };
  const first = f.mount(wallpaper); f.slots[0].resolve(); await first;
  for (const state of ['error', 'play-rejected']) {
    f.context.updateMediaState(state, 'fixture failure');
    await f.mount(wallpaper);
    assert.equal(f.context.mediaState.state, state);
  }
});

test('a forced engine retry still waits for a new slot instead of reusing old readiness', async t => {
  const f = fixture(t), wallpaper = { id: 'current', playable: 'direct-gpu' };
  const first = f.mount(wallpaper); f.slots[0].resolve(); await first;
  f.retry(); let settled = false;
  const retry = f.mount(wallpaper).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false); assert.equal(f.slots.length, 2);
  assert.equal(f.context.mediaState.state, 'loading');
  f.slots[1].resolve(); assert.equal((await retry).ok, true);
  assert.equal(f.context.mediaState.state, 'ready'); assert.equal(f.slots[0].disposed, true);
});

test('pending same-media applies share readiness; a failed candidate keeps old media and reports failure', async t => {
  const f = fixture(t);
  const initial = f.mount({ id: 'old', playable: 'video' }); f.slots[0].resolve(); await initial;
  const next = f.mount({ id: 'new', playable: 'image' });
  let settled = false;
  const repeated = f.mount({ id: 'new', playable: 'image' }).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false); assert.equal(f.slots.length, 2);
  f.slots[1].reject(Error('fixture decode failure'));
  assert.equal((await next).ok, false); assert.equal((await repeated).ok, false);
  assert.equal(f.context.mediaState.state, 'error'); assert.equal(f.slots[0].disposed, false);
});

test('effect-only apply preserves an unrelated speculative scene preload', async t => {
  const f = fixture(t), wallpaper = { id: 'current', playable: 'direct-gpu' };
  const first = f.mount(wallpaper); f.slots[0].resolve(); await first;
  const preload = { key: 'next', identity: 'next' }; f.context.scenePreload = preload;
  assert.equal((await f.mount(wallpaper)).reused, true);
  assert.equal(f.context.scenePreload, preload); assert.equal(f.context.mediaState.state, 'ready');
});

test('a cleared slot reloads even when the last committed identity is unchanged', async t => {
  const f = fixture(t), wallpaper = { id: 'current', playable: 'video' };
  const first = f.mount(wallpaper); f.slots[0].resolve(); await first;
  f.context.mediaSwitcher.clear();
  const reloading = f.mount(wallpaper);
  assert.equal(f.context.mediaState.state, 'loading'); assert.equal(f.slots.length, 2);
  f.slots[1].resolve(); assert.equal((await reloading).ok, true);
});

test('music toggles and repeated saves return HTTP 200 when the current wallpaper is reused', async t => {
  const f = fixture(t), wallpaper = { id: 'current', playable: 'direct-gpu' };
  const first = f.mount(wallpaper); f.slots[0].resolve(); await first;
  const server = createMediaServer({ onConfigChange: async () => {
    const result = await f.mount(wallpaper);
    if (!result.ok || ['loading', 'error', 'play-rejected'].includes(f.context.mediaState.state)) {
      throw Error('Renderer DOM application verification failed');
    }
  } });
  await server.start(); t.after(() => server.close());
  for (const key of ['captureAudio', 'nowPlaying', 'allowControl', 'onlineLyrics']) {
    for (const enabled of [true, false, true]) {
      const response = await fetch(new URL('api/config', server.baseUrl), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media: { [key]: enabled } }) });
      assert.equal(response.status, 200, `${key}=${enabled}`);
      assert.equal((await response.json()).config.media[key], enabled);
    }
  }
  assert.equal(f.slots.length, 1);
});

test('direct-gpu renderer stylesheet applies blur/color filters, blur overscan and opacity to scene/web containers', () => {
  assert.match(source, /#?\$\{ids\.root\}\s*>\s*\[data-cwb-renderer="direct-gpu"\]\s*\{[^}]*opacity:\s*var\(--cwb-opacity,\s*1\)/);
  assert.match(source, /#?\$\{ids\.root\}\s*>\s*\[data-cwb-renderer="direct-gpu"\]\s*>\s*iframe\s*\{[^}]*filter:\s*brightness\(var\(--cwb-brightness,\s*\.82\)\)\s*saturate\(var\(--cwb-saturation,\s*1\.05\)\)\s*contrast\(var\(--cwb-contrast,\s*1\)\)\s*blur\(var\(--cwb-blur,\s*0px\)\)/);
  assert.match(source, /#?\$\{ids\.root\}\s*>\s*\[data-cwb-renderer="direct-gpu"\]\s*>\s*iframe\s*\{[^}]*inset:\s*calc\(var\(--cwb-blur,\s*0px\)\s*\*\s*-1\.2\)/);
});
