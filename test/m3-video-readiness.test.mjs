import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolvePlayback } from '../bridge-runtime/src/playback-policy.mjs';

const source = await readFile(new URL('../bridge-overrides/src/injected-renderer.mjs', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('const createMedia ='), source.indexOf('const mediaSwitcher ='));
const effects = { playing: true, pauseWhenHidden: true, pauseWhenOccluded: true, pauseOnBattery: true, fit: 'cover', position: '50% 50%', zoom: 100, volume: 50, playbackRate: 1 };
function fixture({ hidden = false, onBattery = false, occluded = false, playing = true, direct = true } = {}) {
  const nodes = [], handlers = new Map(), frames = [], reports = [];
  const video = { style: {}, paused: true, videoWidth: 640, readyState: 0,
    addEventListener: (name, fn) => handlers.set(name, fn),
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    requestVideoFrameCallback: fn => frames.push(fn), removeAttribute() {}, remove() {}, load() {} };
  const events = new Map();
  const root = { insertBefore: node => nodes.push(node), append: node => nodes.push(node) };
  const document = { hidden, getElementById: () => root, createElement: kind => kind === 'video' ? video : { style: {}, dataset: {}, contentWindow: { postMessage() {} }, remove() {} } };
  const parent = { postMessage: v => reports.push(v) };
  const context = { document, nativeEnabled: direct, directSceneEnabled: false, ensureRoot: () => root,
    ids: { media: 'media', scrim: 'scrim' },
    resolvePlayback: (effects, environment) => resolvePlayback(effects, { ...environment, occluded }),
    updateMediaState() {}, addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener() {}, parent, window: null, performance: { now: () => 0 }, console, JSON };
  context.window = context;
  const create = vm.runInNewContext(factory + '\ncreateMedia', context);
  const slot = create({ wallpaper: { id: 'video', type: 'video', mediaUrl: 'http://127.0.0.1/video' }, effects: { ...effects, onBattery, playing } }, { revision: 1, initial: true });
  if (!direct) {
    const script = slot.node.srcdoc.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    vm.runInNewContext(script, context);
  }
  return { slot, video, frames, handlers, events, reports, document, parent, setOccluded: value => { occluded = value; } };
}

test('native DOM paused video accepts decoded data without waiting for a non-existent compositor callback', async () => {
  for (const flags of [{ hidden: true }, { onBattery: true }, { occluded: true }, { playing: false }]) {
    const f = fixture(flags); f.handlers.get('loadeddata')();
    const ready = await Promise.race([f.slot.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30))]);
    assert.equal(ready, true, JSON.stringify(flags)); assert.equal(f.frames.length, 0); assert.equal(f.video.paused, true);
  }
});

test('an occlusion transition pauses and resumes the same DOM video while preserving manual pause', () => {
  const f = fixture();
  assert.equal(f.video.paused, false);
  f.setOccluded(true);
  f.slot.update({ effects });
  assert.equal(f.video.paused, true);
  f.setOccluded(false);
  f.slot.update({ effects });
  assert.equal(f.video.paused, false);
  f.slot.update({ effects: { ...effects, playing: false } });
  assert.equal(f.video.paused, true);
});

test('playing video still waits for an actual frame and pause during decode cannot strand readiness', async () => {
  const f = fixture(); let ready = false; f.slot.ready.then(() => { ready = true; });
  f.handlers.get('loadeddata')(); await Promise.resolve(); assert.equal(ready, false); assert.equal(f.frames.length, 1);
  f.frames[0](); await f.slot.ready; assert.equal(ready, true);
  const paused = fixture(); paused.slot.update({ effects: { ...effects, playing: false } }); paused.handlers.get('loadeddata')();
  assert.equal(await Promise.race([paused.slot.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30))]), true);
});

test('srcdoc video paused after creation also reports decoded readiness without a frame callback', () => {
  const f = fixture({ direct: false });
  f.events.get('message')({ source: f.parent, data: { channel: 'cwb-media-control', action: 'pause' } });
  f.handlers.get('loadeddata')();
  assert.equal(f.frames.length, 0); assert.equal(f.reports.some(value => value.event === 'ready'), true);
});

test('pausing between loadeddata and first compositor callback releases readiness, never before decoded data', async () => {
  const f = fixture({ hidden: true }); let ready = false;
  f.slot.ready.then(() => { ready = true; }); await Promise.resolve(); assert.equal(ready, false);
  const playing = fixture(); playing.video.readyState = 2; playing.handlers.get('loadeddata')();
  playing.slot.update({ effects: { ...effects, playing: false } });
  assert.equal(await Promise.race([playing.slot.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 30))]), true);
  const iframe = fixture({ direct: false }); iframe.video.readyState = 2; iframe.handlers.get('loadeddata')();
  iframe.events.get('message')({ source: iframe.parent, data: { channel: 'cwb-media-control', action: 'pause' } });
  assert.equal(iframe.reports.some(value => value.event === 'ready'), true);
});
