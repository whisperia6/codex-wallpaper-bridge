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
  assert.match(hostScript, /#injectButton,#restoreButton/);
});

test("desktop renderer embeds the control page and flushes it before both injection paths", async () => {
  const [html, renderer] = await Promise.all([
    source("src/renderer/index.html"),
    source("src/renderer/renderer-desktop.mjs"),
  ]);
  assert.match(html, /id="controlFrame"/);
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\*/);
  assert.match(html, /renderer-desktop\.mjs/);
  assert.match(renderer, /async function flushControlSettings/);
  assert.match(renderer, /await prepareInjection\(\);\s+return api\.launchCodex/s);
  assert.match(renderer, /await prepareInjection\(\);\s+return api\.injectOnce/s);
  assert.match(renderer, /consumeTransferProgress/);
  assert.match(renderer, /start\|progress\|fallback\|complete/);
  assert.match(renderer, /视频注入/);
  assert.match(renderer, /兼容模式/);
});

test("main process owns one BrowserWindow and redirects tray actions to the shared renderer flow", async () => {
  const main = await source("src/main.mjs");
  assert.equal((main.match(/new BrowserWindow\(/g) || []).length, 1);
  assert.match(main, /createApplicationTray/);
  assert.match(main, /window\.on\("minimize", hideToTray\)/);
  assert.match(main, /window\.on\("close", hideToTray\)/);
  assert.match(main, /sendTrayAction\("launch"\)/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.doesNotMatch(main, /previewWindow/);
});
