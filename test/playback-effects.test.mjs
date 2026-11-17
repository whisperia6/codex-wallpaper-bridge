import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore, DEFAULT_CONFIG, mergeConfig, normalizeConfig } from '../bridge-runtime/src/config-store.mjs';
import { rendererEffects } from '../bridge-overrides/src/injection-plan.mjs';
import { buildBootstrapScript } from '../bridge-overrides/src/injected-renderer.mjs';

test('M1 playback defaults are neutral, muted and versioned', () => {
  const effects = normalizeConfig().effects;
  assert.equal(DEFAULT_CONFIG.schemaVersion, 4);
  assert.deepEqual([effects.positionX, effects.positionY, effects.zoom], [50, 50, 100]);
  assert.equal(effects.playbackRate, 1);
  assert.equal(effects.mirror, false);
  assert.equal(effects.audioEnabled, false);
  assert.equal(effects.volume, 50);
  assert.deepEqual([effects.contrast, effects.opacity], [100, 100]);
});

test('M1 numeric effects are clamped and unknown fields are discarded', () => {
  const effects = normalizeConfig({ effects: {
    positionX: -20, positionY: 300, zoom: 999, playbackRate: 9, volume: -1,
    contrast: 999, opacity: -1, mirror: true, audioEnabled: true, malicious: 'url(file:///a)',
  } }).effects;
  assert.deepEqual([effects.positionX, effects.positionY, effects.zoom], [0, 100, 300]);
  assert.equal(effects.position, '0% 100%');
  assert.equal(effects.playbackRate, 4);
  assert.deepEqual([effects.volume, effects.contrast, effects.opacity], [0, 240, 0]);
  assert.equal(effects.mirror, true);
  assert.equal(effects.audioEnabled, true);
  assert.equal(Object.hasOwn(effects, 'malicious'), false);
});

test('Web single-loop hold is off by default and clamped to 0–3600 seconds', () => {
  assert.equal(normalizeConfig().effects.webLoopHoldSeconds, 0);
  assert.equal(normalizeConfig({ effects: { webLoopHoldSeconds: -5 } }).effects.webLoopHoldSeconds, 0);
  assert.equal(normalizeConfig({ effects: { webLoopHoldSeconds: 9999 } }).effects.webLoopHoldSeconds, 3600);
  assert.equal(normalizeConfig({ effects: { webLoopHoldSeconds: 12.6 } }).effects.webLoopHoldSeconds, 13);
  assert.equal(normalizeConfig().effects.webForceSingleLoop, false);
  assert.equal(normalizeConfig({ effects: { webForceSingleLoop: true } }).effects.webForceSingleLoop, true);
  assert.equal(normalizeConfig({ effects: { webForceSingleLoop: 'yes' } }).effects.webForceSingleLoop, false);
});
test('position migration and patches preserve the untouched axis', () => {
  const before = normalizeConfig({ effects: { position: '20% 70%' } });
  assert.deepEqual([before.effects.positionX, before.effects.positionY], [20, 70]);
  const next = mergeConfig(before, { effects: { positionX: 30 } });
  assert.equal(next.effects.position, '30% 70%');
  assert.equal(mergeConfig(next, { effects: { position: 'right bottom' } }).effects.position, '100% 100%');
});

test('disabling audio retains volume and unrelated effect patches retain playback parameters', () => {
  const before = normalizeConfig({ effects: { volume: 37, playbackRate: 1.75, mirror: true, audioEnabled: true } });
  const next = mergeConfig(before, { effects: { brightness: 91, audioEnabled: false } });
  assert.deepEqual([next.effects.volume, next.effects.playbackRate, next.effects.mirror], [37, 1.75, true]);
  assert.equal(next.effects.audioEnabled, false);
});

test('playback fields and zero opacity reach the lightweight injection payload', () => {
  const input = normalizeConfig({ effects: { positionX: 17, positionY: 81, zoom: 123,
    playbackRate: 2, mirror: true, audioEnabled: true, volume: 29, contrast: 180, opacity: 0,
    glassOpacity: 0, glassBlur: 0, webLoopHoldSeconds: 12, webForceSingleLoop: true } });
  const result = rendererEffects(input);
  for (const key of ['position', 'zoom', 'playbackRate', 'mirror', 'audioEnabled', 'volume', 'contrast', 'opacity', 'glassOpacity', 'glassBlur', 'webLoopHoldSeconds', 'webForceSingleLoop']) {
    assert.equal(result[key], input.effects[key], key);
  }
});

test('version 2 migrates without losing the library and preserves original bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-playback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'config.json');
  const original = '\uFEFF{"schemaVersion":2,"selectedId":"we-a","effects":{"position":"10% 90%"},"library":{"hiddenIds":["hidden"]}}\r\n';
  await writeFile(filePath, original, 'utf8');
  const store = new ConfigStore({ filePath });
  const loaded = await store.load();
  assert.equal(loaded.schemaVersion, 4);
  assert.deepEqual(loaded.library.hiddenIds, ['hidden']);
  assert.deepEqual([loaded.effects.positionX, loaded.effects.positionY], [10, 90]);
  await store.set({ effects: { playbackRate: 1.5 } });
  const backups = (await readdir(root)).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(root, backups[0]), 'utf8'), original);
  assert.equal((await new ConfigStore({ filePath }).load()).effects.playbackRate, 1.5);
});

test('serialized media controls expose rate, audio, transform and rejected playback status', () => {
  const script = buildBootstrapScript();
  assert.match(script, /playbackRate/);
  assert.match(script, /audioEnabled/);
  assert.match(script, /volume/);
  assert.match(script, /mirror/);
  assert.match(script, /contrast/);
  assert.match(script, /play-rejected/);
  assert.ok(Buffer.byteLength(script) < 100 * 1024);
});
