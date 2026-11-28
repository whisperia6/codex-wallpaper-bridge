import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import electron from 'electron';
import { transform } from 'esbuild';

const html = await readFile(new URL('../bridge-runtime/public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../bridge-runtime/public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../bridge-runtime/public/app.js', import.meta.url), 'utf8');
const electronHost = await readFile(new URL('../bridge-overrides/public/electron-host.js', import.meta.url), 'utf8');
const settings = html.slice(html.indexOf('<aside class="settings'), html.indexOf('</aside>', html.indexOf('<aside class="settings')));

test('liquid glass controls bind preview, readouts and the existing effect save handshake', () => {
  const glass = settings.slice(settings.indexOf('data-settings-tab="glass"'), settings.indexOf('data-settings-tab="playback"'));
  assert.match(glass, /data-effect="liquidGlass" type="checkbox"[\s\S]*?<fieldset id="liquidGlassControls"/);
  for (const key of ['sidebarBlur', 'glassComposer']) {
    assert.match(glass, new RegExp(`data-effect="${key}" type="checkbox"`));
  }
  for (const [key, min, max] of [['glassOpacity', 0, 100], ['glassBlur', 0, 60],
    ['glassBorderOpacity', 0, 100], ['glassSaturation', 100, 220]]) {
    assert.match(glass, new RegExp(`for="${key}Range"`));
    assert.match(glass, new RegExp(`data-glass-value="${key}"`));
    assert.match(glass, new RegExp(`data-effect="${key}" type="range" min="${min}" max="${max}"`));
  }
  assert.match(glass, /data-effect="glassTint"[\s\S]*?value="dark"[\s\S]*?value="neutral"[\s\S]*?value="frost"/);
  assert.match(app, /\$\("#liquidGlassControls"\)\.disabled = !effects\.liquidGlass/);
  assert.match(app, /effects\[output\.dataset\.glassValue\]/);
  assert.match(app, /const effects = \{ \.\.\.state\.effects \}/);
  assert.match(electronHost, /\[data-effect\]/);
  assert.match(css, /#liquidGlassControls:disabled \{ opacity:/);
  assert.match(css, /data-cwb-liquid-glass="off"/);
});

test('six settings tabs label their panels and retain the relocated controls', () => {
  const keys = ['appearance', 'glass', 'playback', 'author', 'music', 'video'];
  assert.deepEqual([...settings.matchAll(/data-settings-tab-trigger="([^"]+)"/g)].map(match => match[1]), keys);
  assert.deepEqual([...settings.matchAll(/data-settings-tab="([^"]+)"/g)].map(match => match[1]), keys);
  for (const key of keys) {
    assert.match(settings, new RegExp(`data-settings-tab-trigger="${key}" aria-controls="settings-panel-${key}"`));
    assert.match(settings, new RegExp(`role="tabpanel" aria-labelledby="settings-tab-${key}" data-settings-tab="${key}"`));
  }
  assert.match(settings, /id="framingTools">/);
  assert.match(settings, /id="webLoopTools">/);
  assert.match(settings, /id="transitionTools" open>/);
  for (const [id, key] of [['positionXNumber', 'positionX'], ['positionYNumber', 'positionY'],
    ['zoomNumber', 'zoom'], ['contrastNumber', 'contrast'], ['opacityNumber', 'opacity'], ['mirrorInput', 'mirror'],
    ['playbackRateNumber', 'playbackRate'], ['volumeNumber', 'volume'], ['audioEnabledInput', 'audioEnabled'],
    ['pauseWhenHiddenInput', 'pauseWhenHidden'], ['pauseWhenOccludedInput', 'pauseWhenOccluded'], ['pauseOnBatteryInput', 'pauseOnBattery'],
    ['webLoopHoldNumber', 'webLoopHoldSeconds'], ['webForceSingleLoopInput', 'webForceSingleLoop'],
    ['transitionDurationNumber', 'transitionDurationMs'], ['reduceMotionInput', 'reduceMotion']]) {
    assert.match(settings, new RegExp(`id="${id}" data-effect="${key}"`));
  }
  assert.match(app, /elements\.playbackToggle\.addEventListener\("change", \(\) => togglePlayback\(elements\.playbackToggle\.checked\)\)/);
});

test('settings pills, keyboard navigation, glass swatch and saves work in Electron', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cwb-settings-ui-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const fixture = fileURLToPath(new URL('../test-support/settings-ui-fixture.cjs', import.meta.url));
  const { stdout } = await promisify(execFile)(electron, [fixture, profile], { env, windowsHide: true, timeout: 30_000 });
  const result = stdout.match(/^CWB_SETTINGS_UI (.+)$/m);
  assert.ok(result, stdout);
  const proof = JSON.parse(result[1]);
  assert.deepEqual(proof.initial, { tab: 'appearance', fit: 'contain', framingOpen: false });
  assert.deepEqual([proof.fitByPill, proof.fitBySelect], ['fill', 'cover']);
  assert.deepEqual(proof.navigation, { tab: 'glass', focus: 'settings-tab-glass', panel: 'settings-panel-glass', tabbable: 1 });
  assert.deepEqual([proof.tintByPill, proof.tintByInput, proof.tintBySelect], ['frost', 'dark', 'frost']);
  assert.equal(proof.dark.text, '中性 · 22px');
  assert.equal(proof.edited.text, '冰霜 · 31px');
  assert.equal(proof.edited.background, 'rgba(74, 94, 117, 0.8)');
  assert.equal(proof.edited.border, 'rgba(255, 255, 255, 0.45)');
  assert.equal(proof.edited.filter, 'blur(31px) saturate(1.75)');
  assert.equal(proof.disabled.text, '已关闭');
  assert.equal(proof.disabled.visibility, 'hidden');
  assert.equal(proof.disabled.fieldset, true);
  assert.equal(proof.disabled.controls, true);
  assert.deepEqual(proof.restored, { ...proof.edited, fieldset: false, sidebar: false });
  assert.deepEqual(proof.light, { ...proof.edited, theme: 'light', card: 'rgb(255, 255, 255)' });
  assert.deepEqual(proof.playback, { tab: 'playback', webOpen: false, transitionOpen: true });
  assert.deepEqual(proof.occlusion, { enabled: true, status: '壁纸暂停：窗口被遮挡' });
  assert.equal(proof.framingOpen, false);
  const effects = proof.writes.at(-1).effects;
  for (const [key, value] of Object.entries({
    fit: 'cover', liquidGlass: true, glassTint: 'frost', glassOpacity: 80, glassBlur: 31,
    glassBorderOpacity: 45, glassSaturation: 175, sidebarBlur: false, pauseWhenOccluded: false,
  })) assert.equal(effects[key], value, key);
});

test('desktop update pill is hidden by default and accepts only the trusted parent state', () => {
  assert.match(html, /id="desktopUpdatePill"[^>]+hidden/);
  const listeners = new Map(), click = new Map(), sent = [], elements = new Map();
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { hidden: true, addEventListener: (_, fn) => click.set(key, fn) });
    return elements.get(key);
  };
  const origin = 'cwb-desktop://shell';
  const window = { parent, fetch() {}, addEventListener: (type, fn) => listeners.set(type, fn), setTimeout: () => 1, clearTimeout() {} };
  const document = { querySelector: selector => selector === '#saveIndicator' ? null : element(selector),
    getElementById: id => element('#' + id), head: { append() {} }, documentElement: { dataset: {} },
    createElement: () => ({}), addEventListener() {} };
  vm.runInNewContext(electronHost, { window, document, Date, URL });
  listeners.get('DOMContentLoaded')();
  const receive = (eventOrigin, state) => listeners.get('message')({
    source: parent, origin: eventOrigin, data: { channel: 'cwb-control', type: 'update-state', state },
  });
  const state = { updateAvailable: true, version: '1.4.0', releaseUrl: 'https://example.com' };
  receive('https://example.com', state);
  assert.equal(element('#desktopUpdatePill').hidden, true);
  receive(origin, state);
  assert.equal(element('#desktopUpdatePill').hidden, false);
  assert.equal(element('#desktopOpenUpdate').textContent, '发现新版 v1.4.0');
  click.get('#desktopOpenUpdate')();
  click.get('#desktopDismissUpdate')();
  assert.deepEqual(sent.slice(1).map(({ message, origin: target }) => [message.action, message.payload.version, Object.keys(message.payload), target]), [
    ['open-update-url', '1.4.0', ['version'], origin], ['dismiss-update', '1.4.0', ['version'], origin],
  ]);
  receive(origin, { updateAvailable: false });
  assert.equal(element('#desktopUpdatePill').hidden, true);
});

test('settings controls retain their data hooks, labels and native semantics', () => {
  for (const key of ['captureAudio', 'nowPlaying', 'allowControl', 'onlineLyrics']) {
    assert.match(settings, new RegExp(`<label class="effect-check">[\\s\\S]*?data-media="${key}" type="checkbox"`));
  }
  for (const [id, key] of [['transitionSelect', 'transition'], ['transitionDirectionSelect', 'transitionDirection'],
    ['videoFpsCap', 'fpsCap'], ['videoEncoder', 'encoder']]) {
    assert.match(settings, new RegExp(`for="${id}"`));
    assert.match(settings, new RegExp(`id="${id}" data-(?:effect|video)="${key}"`));
  }
  assert.match(settings, /id="systemLyricsInput" type="file" accept="\.lrc,text\/plain"/);
  assert.match(settings, /发送歌名 \/ 歌手查询，本地歌词优先/);
  assert.match(settings, /128 KiB/);
  assert.match(settings, /aria-live="polite"/);
});

test('transport buttons share a bounded four-column group, not the numeric range grid', () => {
  const transport = settings.match(/<div class="settings-actions media-transport"[\s\S]*?<\/div>/)?.[0];
  assert.ok(transport);
  assert.match(transport, /role="group" aria-label="系统媒体播放控制"/);
  assert.deepEqual([...transport.matchAll(/data-media-command="([^"]+)"/g)].map(match => match[1]),
    ['previous', 'play', 'pause', 'next']);
  assert.equal([...transport.matchAll(/<button[^>]+disabled>/g)].length, 4);
  assert.match(css, /\.settings \.media-transport\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});

test('settings have shared, scoped control tokens and explicit keyboard/disabled states', async () => {
  for (const token of ['--control-bg', '--control-border', '--control-radius', '--control-height', '--settings-ring']) {
    assert.ok(css.includes(token));
  }
  assert.match(css, /\.settings input\[type="checkbox"\]:focus-visible/);
  assert.match(css, /\.settings \.effect-advanced button:disabled/);
  assert.match(css, /\.settings input\[type="file"\]::file-selector-button/);
  assert.match(css, /\.settings > \* \{ flex-shrink: 0; \}/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /var\(--text-muted,|var\(--border,/);
  const result = await transform(css, { loader: 'css', target: 'chrome130' });
  assert.deepEqual(result.warnings, []);
});
