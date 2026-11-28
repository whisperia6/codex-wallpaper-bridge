import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlayback } from '../bridge-runtime/src/playback-policy.mjs';
import { normalizeConfig, mergeConfig } from '../bridge-runtime/src/config-store.mjs';
import { buildBootstrapScript } from '../bridge-overrides/src/injected-renderer.mjs';
import { rendererEffects } from '../bridge-overrides/src/injection-plan.mjs';
import { CdpWallpaperInjector } from '../bridge-runtime/src/cdp-injector.mjs';

test('automatic pause reasons never replace user intent', () => {
  const effects = { playing: false, pauseWhenHidden: true, pauseWhenOccluded: true, pauseOnBattery: true };
  assert.deepEqual(resolvePlayback(effects, { hidden: true, occluded: true, onBattery: true }).reasons, ['user', 'hidden', 'occluded', 'battery']);
  assert.equal(resolvePlayback(effects, { hidden: false, onBattery: false }).playing, false);
  assert.equal(effects.playing, false);
  assert.equal(resolvePlayback({ playing: true, pauseOnBattery: true }, { onBattery: true }).playing, false);
  assert.equal(resolvePlayback({ playing: true, pauseOnBattery: true }, { onBattery: false }).playing, true);
});

test('policy is serializable and battery/hidden are independently opt-in', () => {
  const policy = (0, eval)(`(${resolvePlayback})`);
  assert.equal(policy({ pauseWhenHidden: false }, { hidden: true, onBattery: true }).playing, true);
  assert.equal(policy({ pauseOnBattery: true, onBattery: true }).playing, false);
  assert.deepEqual(policy({ pauseWhenOccluded: true }, { occluded: true }), { userPlaying: true, playing: false, reasons: ['occluded'] });
  assert.equal(policy({ pauseWhenOccluded: false }, { occluded: true }).playing, true);
  assert.equal(policy({ playing: true }, { inactive: true }).playing, false);
});

test('M3 settings default off, merge independently and never persist power observations', () => {
  const config = normalizeConfig({ effects: { onBattery: true }, media: { captureAudio: 'yes', nowPlaying: true } });
  assert.equal(config.effects.pauseOnBattery, false);
  assert.equal(config.effects.onBattery, undefined);
  assert.equal(config.effects.pauseWhenOccluded, true);
  const paused = mergeConfig(config, { effects: { pauseWhenOccluded: false, occluded: true } });
  assert.equal(paused.effects.occluded, undefined);
  assert.equal(rendererEffects(paused).pauseWhenOccluded, false);
  assert.deepEqual(config.media, { captureAudio: false, nowPlaying: true, allowControl: false, onlineLyrics: false });
  assert.equal(mergeConfig(config, { media: { onlineLyrics: true } }).media.nowPlaying, true);
});

test('every bootstrap stays under 100 KiB and GPU mode never ships the unused VP8 decoder', () => {
  for (const hostType of ['codex', 'antigravity']) {
    for (const flags of [{}, { nativeEnabled: true }, { directSceneEnabled: true }, { nativeEnabled: true, directSceneEnabled: true }]) {
      assert.ok(Buffer.byteLength(buildBootstrapScript({ hostType, ...flags })) < 100 * 1024);
    }
  }
  assert.doesNotMatch(buildBootstrapScript({ nativeEnabled: true, directSceneEnabled: true }), /new VideoDecoder/);
  assert.match(buildBootstrapScript(), /0\.6\.0-m3-media-policy-v9/);
});

test('connected injector polls without overlap and sends transitions without applying a new plan', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enabled = true;
  let finish;
  const queries = [], messages = [];
  const injector = new CdpWallpaperInjector({ occlusion: {
    isEnabled: () => enabled,
    query: (pids, { signal }) => {
      queries.push({ pids, signal });
      return new Promise(resolve => { finish = resolve; });
    },
  } });
  const session = { socket: {}, processId: 42, runtimeInstalled: true, occlusionApplied: false };
  injector.evaluateScript = async (_, script) => { messages.push(script); return true; };
  injector.running = true;
  injector.refreshOcclusion();
  t.mock.timers.tick(1800);
  assert.equal(queries.length, 0);
  injector.sessions.set('target', session);
  injector.sessions.set('deferred', { ...session, processId: 99, deferred: true });
  injector.refreshOcclusion();
  t.mock.timers.tick(1750);
  await Promise.resolve();
  assert.deepEqual(queries.map(({ pids }) => pids), [[42]]);
  injector.refreshOcclusion();
  t.mock.timers.tick(1750);
  assert.equal(queries.length, 1);
  const settle = async (occluded) => {
    finish({ occluded });
    while (injector.occlusionQuery) await Promise.resolve();
  };
  await settle(true);
  assert.equal(injector.occluded, true);
  t.mock.timers.tick(1750);
  await Promise.resolve();
  await settle(true);
  assert.deepEqual(messages, ['globalThis.__codexWallpaperBridgeRuntime?.setOcclusion?.(true)']);
  enabled = false;
  injector.refreshOcclusion();
  await Promise.resolve();
  assert.equal(injector.occluded, false);
  assert.equal(injector.occlusionTimer, null);
  assert.equal(messages.at(-1), 'globalThis.__codexWallpaperBridgeRuntime?.setOcclusion?.(false)');
  enabled = true;
  injector.refreshOcclusion();
  t.mock.timers.tick(1750);
  await Promise.resolve();
  injector.sessions.clear();
  injector.refreshOcclusion();
  assert.equal(queries.at(-1).signal.aborted, true);
  await settle(true);
  assert.equal(injector.occluded, false);
  assert.equal(injector.occlusionTimer, null);
  assert.equal(messages.length, 2);
});
