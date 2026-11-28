import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolvePlayback } from '../bridge-runtime/src/playback-policy.mjs';

const source = await readFile(new URL('../bridge-runtime/public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  const previewSwitcher = cwbMedia.createMediaSwitcher({');
const end = source.indexOf('  async function withPreviewAuthorReadback', start);
assert.ok(start >= 0 && end > start);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ playing = true, hidden = false, onBattery = false, frameApi = true } = {}) {
  let options, nextFrame = 0;
  const frames = new Map(), cancelled = [], state = { effects: { playing, pauseWhenHidden: true, pauseOnBattery: true, onBattery } };
  const video = { style: {}, classList: { remove() {} }, readyState: 0, videoWidth: 0, videoHeight: 0, paused: true,
    removeAttribute() {}, remove() { this.removed = true; }, load() {},
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    requestVideoFrameCallback: frameApi ? callback => { frames.set(++nextFrame, callback); return nextFrame; } : undefined,
    cancelVideoFrameCallback: id => { cancelled.push(id); frames.delete(id); } };
  const context = { cwbMedia: { resolvePlayback, createMediaSwitcher: value => { options = value; return {}; } }, state,
    document: { hidden }, elements: { backgroundVideo: { cloneNode: () => video }, backgroundDim: { parentNode: { insertBefore() {} } } } };
  vm.runInNewContext(source.slice(start, end), context);
  const slot = options.create({ id: 'fixture-video', type: 'video', mediaUrl: 'http://127.0.0.1/fixture' }, { revision: 1 });
  let ready = false; slot.ready.then(() => { ready = true; }, () => {});
  return { slot, video, state, document: context.document, frames, cancelled, ready: () => ready,
    decoded() { video.readyState = 2; video.videoWidth = 640; video.videoHeight = 360; video.onloadeddata(); } };
}

test('workbench never marks a paused video ready before decoded data and nonzero dimensions', async t => {
  const f = fixture({ playing: false }); t.after(() => f.slot.release());
  f.slot.update(); f.video.onloadeddata(); await tick(); assert.equal(f.ready(), false);
  f.video.readyState = 2; f.video.videoWidth = 640; f.video.onloadeddata(); await tick();
  assert.equal(f.ready(), false, 'zero height is not decoded readiness');
  f.decoded(); await tick(); assert.equal(f.ready(), true); assert.equal(f.frames.size, 0);
});

test('workbench releases loadeddata-to-frame readiness on manual, hidden or battery pause', async t => {
  for (const reason of ['user', 'hidden', 'battery']) {
    const f = fixture(); t.after(() => f.slot.release()); f.decoded(); await tick();
    assert.equal(f.ready(), false); assert.equal(f.frames.size, 1);
    if (reason === 'user') f.state.effects.playing = false;
    else if (reason === 'hidden') f.document.hidden = true;
    else f.state.effects.onBattery = true;
    f.slot.update(); await tick();
    assert.equal(f.ready(), true, reason); assert.equal(f.video.paused, true);
    assert.equal(f.frames.size, 0); assert.equal(f.cancelled.length, 1);
    if (reason !== 'user') assert.equal(f.state.effects.playing, true, 'temporary policy never replaces user intent');
  }
});

test('playing workbench video still waits for one real frame callback; repeated updates do not add callbacks', async t => {
  const f = fixture(); t.after(() => f.slot.release()); f.decoded(); f.slot.update(); f.slot.update(); await tick();
  assert.equal(f.ready(), false); assert.equal(f.frames.size, 1);
  const [id, frame] = [...f.frames][0]; f.frames.delete(id); frame(); await tick(); assert.equal(f.ready(), true);
  f.slot.update(); assert.equal(f.frames.size, 0);
});

test('workbench release cancels frame callback and ignores saved late events and updates', async () => {
  const f = fixture(); f.decoded();
  const lateFrame = [...f.frames.values()][0], lateLoaded = f.video.onloadeddata;
  f.slot.release(); assert.equal(f.frames.size, 0); assert.equal(f.video.onloadeddata, null);
  lateFrame(); lateLoaded(); f.slot.update(); await tick();
  assert.equal(f.ready(), false); assert.equal(f.video.paused, true); assert.equal(f.video.removed, true);
});

test('workbench decode failure cancels any pending frame and does not get overwritten by a late success', async t => {
  const f = fixture(); t.after(() => f.slot.release()); f.decoded(); const lateFrame = [...f.frames.values()][0];
  const failed = assert.rejects(f.slot.ready, /Media decode failed/); f.video.onerror(); await failed;
  assert.equal(f.frames.size, 0); lateFrame(); await tick(); assert.equal(f.ready(), false);
});

test('workbench no-frame-api fallback and initially paused videos accept only decoded data', async t => {
  for (const flags of [{ frameApi: false }, { playing: false }, { hidden: true }, { onBattery: true }]) {
    const f = fixture(flags); t.after(() => f.slot.release()); f.decoded(); await tick();
    assert.equal(f.ready(), true); assert.equal(f.frames.size, 0);
  }
});
