import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlayback } from '../bridge-runtime/src/playback-policy.mjs';
import { normalizeConfig, mergeConfig } from '../bridge-runtime/src/config-store.mjs';
import { buildBootstrapScript } from '../bridge-overrides/src/injected-renderer.mjs';

test('automatic pause reasons never replace user intent', () => {
  const effects = { playing: false, pauseWhenHidden: true, pauseOnBattery: true };
  assert.deepEqual(resolvePlayback(effects, { hidden: true, onBattery: true }).reasons, ['user', 'hidden', 'battery']);
  assert.equal(resolvePlayback(effects, { hidden: false, onBattery: false }).playing, false);
  assert.equal(effects.playing, false);
  assert.equal(resolvePlayback({ playing: true, pauseOnBattery: true }, { onBattery: true }).playing, false);
  assert.equal(resolvePlayback({ playing: true, pauseOnBattery: true }, { onBattery: false }).playing, true);
});

test('policy is serializable and battery/hidden are independently opt-in', () => {
  const policy = (0, eval)(`(${resolvePlayback})`);
  assert.equal(policy({ pauseWhenHidden: false }, { hidden: true, onBattery: true }).playing, true);
  assert.equal(policy({ pauseOnBattery: true, onBattery: true }).playing, false);
  assert.equal(policy({ playing: true }, { inactive: true }).playing, false);
});

test('M3 settings default off, merge independently and never persist power observations', () => {
  const config = normalizeConfig({ effects: { onBattery: true }, media: { captureAudio: 'yes', nowPlaying: true } });
  assert.equal(config.effects.pauseOnBattery, false);
  assert.equal(config.effects.onBattery, undefined);
  assert.deepEqual(config.media, { captureAudio: false, nowPlaying: true, allowControl: false, onlineLyrics: false });
  assert.equal(mergeConfig(config, { media: { onlineLyrics: true } }).media.nowPlaying, true);
});

test('every bootstrap stays under 100 KiB and GPU mode never ships the unused VP8 decoder', () => {
  for (const flags of [{}, { nativeEnabled: true }, { directSceneEnabled: true }, { nativeEnabled: true, directSceneEnabled: true }]) {
    assert.ok(Buffer.byteLength(buildBootstrapScript(flags)) < 100 * 1024);
  }
  assert.doesNotMatch(buildBootstrapScript({ nativeEnabled: true, directSceneEnabled: true }), /new VideoDecoder/);
  assert.match(buildBootstrapScript(), /0\.6\.0-m3-media-policy-v6/);
});
