import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(prototypeRoot, relativePath), "utf8");
}

test("bundled control runtime contains exactly one Electron save handshake", async () => {
  const [runtimeIndex, hostScript] = await Promise.all([
    source("bridge-runtime/public/index.html"),
    source("bridge-runtime/public/electron-host.js"),
  ]);
  assert.match(runtimeIndex, /electron-host\.js/);
  assert.equal((runtimeIndex.match(/electron-host\.js/g) || []).length, 1);
  assert.ok(runtimeIndex.indexOf("electron-host.js") < runtimeIndex.indexOf("app.js"));
  assert.match(hostScript, /pendingWrites/);
  assert.match(hostScript, /flush-config/);
  assert.match(hostScript, /CONFIG_QUIET_MS = 360/);
  assert.match(runtimeIndex, /id="desktopTargetBar"/);
  assert.match(runtimeIndex, /id="desktopInstallationSelect"/);
  assert.match(runtimeIndex, /id="desktopApplyButton"/);
  assert.match(hostScript, /desktop-request/);
  assert.match(hostScript, /desktop-response/);
  assert.match(hostScript, /desktop-state/);
});

test("desktop renderer is only a wallpaper workbench and exposes one apply path", async () => {
  const [html, renderer] = await Promise.all([
    source("src/renderer/index.html"),
    source("src/renderer/renderer-desktop.mjs"),
  ]);
  assert.match(html, /id="controlFrame"/);
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\*/);
  assert.match(html, /renderer-desktop\.mjs/);
  assert.doesNotMatch(html, /installationSelect|launchButton|injectButton|diagnoseButton|logOutput/);
  assert.match(renderer, /async function flushControlSettings/);
  assert.match(renderer, /await flushControlSettings\(\)/);
  assert.match(renderer, /await api\.applyCodex/);
  assert.match(renderer, /desktop-request/);
  assert.doesNotMatch(renderer, /api\.injectOnce|consumeTransferProgress|logOutput/);
});

test("main process owns one BrowserWindow, one apply IPC, and local-only logs", async () => {
  const [main, preload] = await Promise.all([
    source("src/main.mjs"),
    source("src/preload.cjs"),
  ]);
  assert.equal((main.match(/new BrowserWindow\(/g) || []).length, 1);
  assert.match(main, /createApplicationTray/);
  assert.match(main, /window\.on\("minimize", hideToTray\)/);
  assert.match(main, /window\.on\("close", hideToTray\)/);
  assert.match(main, /sendTrayAction\("apply"\)/);
  assert.match(main, /invokeBridgeAction/);
  assert.match(main, /action: "inject"/);
  assert.match(main, /cwb:apply-codex/);
  assert.match(main, /writeCompatibilityDiagnostic/);
  assert.match(main, /CodexWallpaperDesktop", "logs/);
  assert.doesNotMatch(main, /cwb:inject-once|cwb:export-diagnostics|cwb:log/);
  assert.match(preload, /applyCodex/);
  assert.doesNotMatch(preload, /injectOnce|exportDiagnostics|revealDiagnostics|onLog/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.doesNotMatch(main, /previewWindow/);
});
