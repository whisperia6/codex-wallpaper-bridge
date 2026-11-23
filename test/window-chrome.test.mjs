import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const read = name => readFile(new URL(`../${name}`, import.meta.url), "utf8");
let chrome;
try { chrome = await import("../src/window-chrome.mjs"); }
catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));

test("Windows hides only the native title text and keeps native caption controls and window frame", () => {
  assert.ok(chrome, "native window chrome module must exist");
  const options = chrome.desktopWindowChromeOptions("win32");
  assert.equal(options.titleBarStyle, "hidden");
  assert.deepEqual(options.titleBarOverlay, { color: "#0c0d10", symbolColor: "#f3f4f6", height: 40 });
  assert.equal(Object.hasOwn(options, "frame"), false);
  assert.equal(Object.hasOwn(options, "transparent"), false);
  options.titleBarOverlay.color = "red";
  assert.equal(chrome.desktopWindowChromeOptions("win32").titleBarOverlay.color, "#0c0d10");
  for (const platform of ["darwin", "linux"]) assert.deepEqual(chrome.desktopWindowChromeOptions(platform), {});
});

test("native caption theme uses a fixed palette and never accepts arbitrary styles", () => {
  assert.ok(chrome);
  const overlays = [], backgrounds = [];
  const win = { isDestroyed: () => false, setTitleBarOverlay: v => overlays.push(v), setBackgroundColor: v => backgrounds.push(v) };
  for (const theme of ["light", "dark", "light"]) assert.equal(chrome.setWindowChromeTheme(win, theme, "win32").supported, true);
  assert.deepEqual(overlays.map(v => v.color), ["#f4f5f7", "#0c0d10", "#f4f5f7"]);
  assert.deepEqual(backgrounds, overlays.map(v => v.color));
  for (const value of [null, undefined, {}, [], "__proto__", "constructor", "red", "url(script)"]) {
    assert.throws(() => chrome.setWindowChromeTheme(win, value, "win32"), /theme/i);
  }
  assert.equal(overlays.length, 3);
  assert.equal(chrome.setWindowChromeTheme(win, "light", "linux").supported, false);
  assert.equal(chrome.setWindowChromeTheme({ isDestroyed: () => true }, "dark", "win32").supported, false);
  assert.equal(overlays.length, 3);
});

test("preload exposes an enum-only theme invocation, not window commands or ipcRenderer", async () => {
  const source = await read("src/preload.cjs"), calls = [];
  let exposed;
  runInNewContext(source, { process: { platform: "win32" }, require: () => ({
    contextBridge: { exposeInMainWorld: (_key, value) => { exposed = value; } },
    ipcRenderer: { invoke: (...args) => calls.push(args), on() {}, off() {} },
  }) });
  assert.equal(exposed.windowChrome, true);
  exposed.setWorkbenchTheme("light");
  assert.deepEqual(plain(calls), [["cwb:set-workbench-theme", "light"]]);
  for (const key of ["ipcRenderer", "send", "invoke", "close", "minimize", "maximize"]) assert.equal(Object.hasOwn(exposed, key), false);
});

async function rendererFixture({ saved = "dark", rejectTheme = false, themeResponse } = {}) {
  const source = await read("src/renderer/renderer-desktop.mjs");
  const calls = [], listeners = {}, storage = new Map([["cwb.workbench.theme", saved]]);
  const connection = { textContent: "", dataset: {} }, titlebar = { hidden: true };
  const frame = { src: "", contentWindow: { postMessage() {} } };
  const placeholder = { hidden: false, querySelector: () => ({ textContent: "" }) };
  const document = { documentElement: { dataset: {} }, querySelector: s => ({
    "#controlFrame": frame, "#controlPlaceholder": placeholder, "#desktopTitlebar": titlebar, "#desktopConnectionStatus": connection,
  })[s] };
  const api = { windowChrome: true,
    setWorkbenchTheme: async theme => { calls.push(theme); if (themeResponse) return themeResponse(theme); if (rejectTheme) throw Error("fixture native failure"); return { supported: true }; },
    getState: async () => ({ installations: [], port: 9335 }),
    openControlPanel: async () => ({ ok: true, url: "http://127.0.0.1:43210/fixture/" }),
    onTrayAction: handler => { listeners.tray = handler; },
  };
  const window = { cwbDesktop: api, localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v) },
    addEventListener: (name, handler) => { listeners[name] = handler; }, setTimeout, clearTimeout };
  runInNewContext(source, { window, document, URL }); await turn();
  const emit = (theme, origin = "http://127.0.0.1:43210", from = frame.contentWindow) => listeners.message({
    data: { channel: "cwb-control", type: "workbench-theme", theme }, origin, source: from,
  });
  return { calls, document, frame, connection, titlebar, emit, listeners };
}

test("saved theme and trusted iframe theme changes synchronize caption without applying wallpaper", async () => {
  const f = await rendererFixture({ saved: "light" });
  assert.equal(f.titlebar.hidden, false);
  assert.deepEqual(f.calls, ["light"]);
  f.emit("dark"); await turn();
  assert.deepEqual(f.calls, ["light", "dark"]);
  assert.equal(f.document.documentElement.dataset.workbenchTheme, "dark");
  f.emit("red"); f.emit("light", "https://evil.test"); f.emit("light", undefined, {}); await turn();
  assert.deepEqual(f.calls, ["light", "dark"]);
});

test("native theme failure cannot block the UI preference or leave an unhandled rejection", async () => {
  const f = await rendererFixture({ saved: "light", rejectTheme: true });
  assert.equal(f.document.documentElement.dataset.workbenchTheme, "light");
  assert.equal(f.document.documentElement.dataset.titlebarThemeSync, "failed");
});

test("a late failed theme reply cannot undo a newer native theme acknowledgment", async () => {
  let rejectOld;
  const old = new Promise((_resolve, reject) => { rejectOld = reject; });
  const f = await rendererFixture({ themeResponse: theme => theme === "dark" ? old : Promise.resolve({ supported: true }) });
  f.emit("light"); await turn();
  assert.equal(f.document.documentElement.dataset.titlebarThemeSync, "ready");
  rejectOld(Error("stale failure")); await turn();
  assert.equal(f.document.documentElement.dataset.titlebarThemeSync, "ready");
  assert.equal(f.document.documentElement.dataset.workbenchTheme, "light");
});

test("titlebar connection status reflects the real control handshake and disconnection", async () => {
  const f = await rendererFixture();
  assert.equal(f.connection.dataset.state, "connecting");
  f.listeners.message({ source: f.frame.contentWindow, origin: "http://127.0.0.1:43210", data: { channel: "cwb-control", type: "ready" } });
  assert.equal(f.connection.dataset.state, "connected");
  assert.match(f.connection.textContent, /已连接/);
  f.listeners.tray("control-disconnected");
  assert.notEqual(f.connection.dataset.state, "connected");
});

test("shell reserves native caption space and only the titlebar is draggable", async () => {
  const [html, css, main] = await Promise.all([read("src/renderer/index.html"), read("src/renderer/styles.css"), read("src/main.mjs")]);
  assert.match(html, /id="desktopTitlebar"/); assert.match(html, /id="desktopConnectionStatus"/);
  assert.match(css, /env\(titlebar-area-width/); assert.match(css, /app-region:\s*drag/);
  assert.match(css, /app-region:\s*no-drag/);
  assert.match(main, /desktopWindowChromeOptions/);
  assert.match(main, /registerHandler\("cwb:set-workbench-theme"/);
  assert.match(main, /window\.on\("minimize", hideToTray\)/);
  assert.match(main, /window\.on\("close", hideToTray\)/);
});
