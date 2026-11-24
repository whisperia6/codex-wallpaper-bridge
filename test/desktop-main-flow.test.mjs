import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { resolveBridgeRoot, resolveBridgeUtilityPath } from "../src/bridge-runner.mjs";
import { verifyCdpEndpointOwner } from "../src/cdp-owner.mjs";
import { selectInstallationId, validateCdpPort } from "../src/installations.mjs";
import { runCodexTakeoverFlow } from "../src/codex-takeover-flow.mjs";
import { runLaunchAndInjectFlow } from "../src/launch-flow.mjs";
import { dailyLogFilename, formatLogEntry, sanitizeLogText } from "../src/local-logging.mjs";
import { createPreviewSession, stopPreviewProcess } from "../src/preview-session.mjs";
import { DESKTOP_RENDERER_URL } from "../bridge-runtime/src/desktop-origin.mjs";
import { registerDesktopRendererScheme } from "../src/desktop-renderer-protocol.mjs";
import { desktopWindowChromeOptions, setWindowChromeTheme } from "../src/window-chrome.mjs";

const mainUrl = new URL("../src/main.mjs", import.meta.url);
const mainSource = (await readFile(mainUrl, "utf8"))
  .replace(/^import\s[\s\S]*?;\r?\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(mainUrl.href));
const root = fileURLToPath(new URL("..", import.meta.url));
const rendererUrl = DESKTOP_RENDERER_URL;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const controlUrl = (port) => `http://127.0.0.1:${port}/abcdefghijklmnopqrstuv/`;
const installations = [
  { id: "local", kind: "local", path: "D:\\fixture-local\\ChatGPT.exe", label: "local", isRunning: true, processIds: [1001] },
  { id: "store", kind: "store", path: "C:\\fixture-store\\ChatGPT.exe", label: "store", isRunning: true, processIds: [1002] },
];

async function harness(context, { acceptance = true, endpointReady = true, autoExit = true, rejectKill = false, actionFailure = false, duringAction = null, nativeCloseDeferred = null, diagnostics = { targets: [] }, detectedInstallations = installations, savedSelectedId = "local", messageBoxResponse = 0, takeoverProcesses = [], duringClose = null, duringWrite = null } = {}) {
  const calls = { monitors: [], watchers: [], order: [], forks: [], starts: [], actions: [], launch: [], close: [], owner: [], collect: [], expectedProcess: [], reads: [], writes: [], appends: [], dialogs: [], prevented: [], errors: [], detects: 0, trayDestroyed: 0, nativeHosts: [], nativePeers: [], nativeCloses: 0 };
  const acceptanceRoot = path.join(root, "out", "live-acceptance", "main-flow-fixture");
  const acceptanceContext = acceptance ? {
    userData: path.join(acceptanceRoot, "desktop-user-data"),
    stateRoot: path.join(acceptanceRoot, "bridge-state"),
    logsRoot: path.join(acceptanceRoot, "desktop-logs"),
    expectedHost: { exe: installations[0].path, pid: 1001, port: 19335, creation: "2026-10-09T01:00:00.0000000Z", profile: path.join(acceptanceRoot, "host-profile") },
    bridgeEnv: {
      LOCALAPPDATA: path.join(acceptanceRoot, "bridge-state"),
      XDG_CONFIG_HOME: path.join(acceptanceRoot, "bridge-state"),
      XDG_STATE_HOME: path.join(acceptanceRoot, "bridge-state"),
    },
  } : null;
  const children = [];
  let readyPromise;
  let trayActions;
  const paths = { userData: path.join(root, "daily-data-must-not-be-used"), temp: path.join(root, "fixture-temp") };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    getAppPath: () => root,
    getPath: (name) => paths[name],
    setPath: (name, value) => { calls.order.push(`setPath:${name}`); paths[name] = value; },
    requestSingleInstanceLock: () => { calls.order.push("instance-lock"); return true; },
    whenReady: () => ({ then: (callback) => { readyPromise = Promise.resolve().then(callback); return readyPromise; } }),
    setAppUserModelId: () => {},
    quit: () => {
      calls.order.push("app.quit");
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      app.emit("before-quit", event);
      calls.prevented.push(event.prevented);
      if (!event.prevented) app.emit("will-quit");
    },
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      calls.windows ??= [];
      calls.windows.push(this);
      this.options = copy(options);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler: () => {}, send: () => {}, isLoadingMainFrame: () => false });
    }
    removeMenu() {}
    loadURL(url) { calls.order.push(`loadURL:${url}`); }
    show() {}
    hide() { calls.hidden = (calls.hidden || 0) + 1; }
    setTitleBarOverlay(value) { (calls.overlays ??= []).push(copy(value)); }
    setBackgroundColor(value) { (calls.backgrounds ??= []).push(value); }
    focus() {}
    restore() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
  }
  const sandbox = createContext({
    app, BrowserWindow: FakeWindow, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    Menu: {}, nativeImage: {}, session: {}, Tray: {}, shell: { openPath: async () => "" },
    protocol: { registerSchemesAsPrivileged: () => calls.order.push("register-desktop-scheme") },
    DESKTOP_RENDERER_URL, registerDesktopRendererScheme,
    desktopWindowChromeOptions, setWindowChromeTheme,
    installDesktopRendererProtocol: async () => calls.order.push("install-desktop-protocol"),
    createDesktopEngineHost: (options) => {
      calls.nativeHosts.push(options);
      return { attach: (child) => { calls.nativePeers.push(child); }, close: async () => {
        calls.nativeCloses++; await nativeCloseDeferred; calls.order.push("native.resources-closed");
      } };
    },
    dialog: {
      showMessageBox: async (...args) => { calls.dialogs.push(args); return { response: typeof messageBoxResponse === "function" ? await messageBoxResponse() : messageBoxResponse }; },
      showOpenDialog: async (...args) => { calls.dialogs.push(args); return { canceled: true, filePaths: [] }; },
      showErrorBox: (...args) => calls.errors.push(args),
    },
    utilityProcess: {
      fork: (modulePath, args, options) => {
        calls.forks.push({ modulePath, args: copy(args), options: copy(options) });
        const child = new EventEmitter();
        Object.assign(child, { autoExit, rejectKill, killCount: 0, exited: false });
        child.finish = () => {
          if (child.exited) return;
          child.exited = true;
          calls.order.push("child.exit");
          child.emit("exit", 0);
        };
        child.kill = () => {
          child.killCount += 1;
          calls.order.push("child.kill");
          if (child.rejectKill) return false;
          if (child.autoExit) child.finish();
          return true;
        };
        children.push(child);
        return child;
      },
    },
    path, fileURLToPath, pathToFileURL, URL, performance, AbortController,
    runCodexTakeoverFlow,
    listCodexProcesses: async () => takeoverProcesses,
    startCodexProcessMonitor: (options) => {
      const record = { options, stopped: false }; calls.monitors.push(record);
      return { stop: () => { record.stopped = true; } };
    },
    createCodexTakeoverWatcher: (options) => {
      const record = { options, stopped: false }; calls.watchers.push(record);
      return { start() {}, stop: () => { record.stopped = true; } };
    },
    process: { platform: "win32", execPath: "C:\\fixture-electron\\electron.exe", resourcesPath: path.join(root, "fixture-resources"), env: { LOCALAPPDATA: path.join(root, "daily-local-app-data"), KEEP_EXISTING: "kept" } },
    appendFile: async (filePath, content) => calls.appends.push({ filePath, content }),
    mkdir: async () => {},
    readFile: async (filePath) => { calls.reads.push(filePath); return JSON.stringify({ selectedId: savedSelectedId, port: 19335, adaptive: true }); },
    writeFile: async (filePath, content) => { calls.writes.push({ filePath, content }); await duringWrite?.(); },
    resolveBridgeRoot, resolveBridgeUtilityPath,
    invokeBridgeAction: async (options) => {
      calls.actions.push(copy(options));
      await duringAction?.(calls, options);
      if (actionFailure) throw new Error("fixture apply failed");
      return { ok: true, compatibility: [] };
    },
    startBridgePreview: async (options) => {
      calls.starts.push(options.port);
      const child = options.processFactory(path.join(options.bridgeRoot, "src", "cli.mjs"), ["preview", "--no-open"], { cwd: options.bridgeRoot });
      options.onChild(child);
      options.onLog({ text: "isolated bridge started", stream: "system" });
      return { child, url: controlUrl(options.port) };
    },
    collectCdpDiagnostics: async (port) => { calls.order.push("collect-diagnostics"); calls.collect.push(port); return diagnostics; },
    isCdpEndpointReady: async () => typeof endpointReady === "function" ? endpointReady() : endpointReady,
    waitForCodexTarget: async () => {},
    closeCodexProcesses: async (options) => { calls.close.push(options); await duringClose?.(); return { closedCount: 1 }; },
    launchCodex: async (options) => { calls.launch.push(options); return {}; },
    detectInstallations: async () => { calls.detects += 1; return detectedInstallations; },
    inspectExecutableIdentity: async () => ({ productName: "Codex", fileDescription: "Codex", looksLikeCodex: true, hasDesktopLayout: true }),
    selectInstallationId, validateCdpPort, validateExecutable: async (value) => value, runLaunchAndInjectFlow,
    dailyLogFilename, formatLogEntry, sanitizeLogText,
    TRAY_ICON_DATA_URL: "",
    createTrayController: ({ actions }) => {
      trayActions = actions;
      return { showResidentNotice: () => {}, destroy: () => { calls.trayDestroyed += 1; } };
    },
    prepareAcceptanceContext: async () => { calls.order.push("acceptance-context"); return acceptanceContext; },
    verifyCdpEndpointOwner: async (options) => {
      calls.order.push("owner-query");
      calls.owner.push({ installationId: options.installation.id, port: options.port });
      if (options.expectedProcess) calls.expectedProcess.push(copy(options.expectedProcess));
      const owner = options.port === 19335 ? installations[0] : installations[1];
      return verifyCdpEndpointOwner({
        ...options, platform: "win32",
        processRunner: async () => ({ stdout: JSON.stringify({
          listeners: [{ localAddress: "127.0.0.1", localPort: options.port, owningProcess: owner.processIds[0] }],
          owners: [{ processId: owner.processIds[0], executablePath: owner.path, remoteDebuggingPorts: [options.port], hasInvalidRemoteDebuggingPort: false }],
          independentIdentity: { processIdMatches: true, creationMatches: true, profileMatches: true, notQueryAncestor: true, ancestorChainVerified: true },
        }) }),
      });
    },
    createPreviewSession, stopPreviewProcess,
  });
  const handlers = new Map();
  context.after(async () => { for (const child of children) child.finish(); await turn(); });
  await runInContext(`(async () => {\n${mainSource}\n})()`, sandbox, { filename: "main.mjs" });
  await readyPromise;
  return {
    calls, app, children, acceptanceContext, trayActions,
    ipc: (channel, payload, url = rendererUrl) => handlers.get(channel)({ senderFrame: { url } }, payload),
  };
}

test("native caption uses trusted theme-only IPC without persisting or starting a bridge", async context => {
  const f = await harness(context);
  assert.equal(f.calls.windows[0].options.titleBarStyle, "hidden");
  assert.equal(f.calls.windows[0].options.titleBarOverlay.height, 40);
  const writes = f.calls.writes.length;
  assert.equal((await f.ipc("cwb:set-workbench-theme", "light")).supported, true);
  assert.equal(f.calls.overlays.at(-1).color, "#f4f5f7");
  await assert.rejects(f.ipc("cwb:set-workbench-theme", "red"), /theme/i);
  await assert.rejects(f.ipc("cwb:set-workbench-theme", "dark", "http://127.0.0.1:12345/"), /IPC/);
  assert.equal(f.calls.overlays.length, 1);
  assert.equal(f.calls.writes.length, writes);
  assert.deepEqual(f.calls.starts, []); assert.deepEqual(f.calls.actions, []);
});

test("integrated caption keeps minimize and close resident in the tray", async context => {
  const f = await harness(context), win = f.calls.windows[0];
  let prevented = 0;
  for (const type of ["minimize", "close"]) win.emit(type, { preventDefault() { prevented++; } });
  assert.equal(prevented, 2); assert.equal(f.calls.hidden, 2);
  assert.equal(f.calls.trayDestroyed, 0);
});

test("startup reuses only installation metadata and single-flights overlapping owner checks", async (context) => {
  const fixture = await harness(context, { duringAction: async (calls) => {
    const verify = calls.nativeHosts[0].verifyEndpoint;
    await Promise.all([verify(19335), verify(19335)]);
  } });
  const detects = fixture.calls.detects;
  assert.equal((await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335 })).ok, true);
  assert.equal(fixture.calls.detects, detects + 1, "native callbacks must not enumerate all installations again");
  assert.equal(fixture.calls.owner.length, 2, "launch-flow check plus one overlapping native check");
  await fixture.calls.nativeHosts[0].verifyEndpoint(19335);
  assert.equal(fixture.calls.owner.length, 3, "a settled owner result must never be cached");
  assert.equal(fixture.calls.detects, detects + 1);
  await turn();
  const log = fixture.calls.appends.map(({ content }) => content).join("");
  assert.match(log, /注入计时.*安装发现/);
  assert.match(log, /注入计时.*点击到流程结束/);
});

test("cached installation descriptor cannot authorize another port or defeat shutdown", async (context) => {
  const fixture = await harness(context);
  await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335 });
  const verify = fixture.calls.nativeHosts[0].verifyEndpoint;
  await assert.rejects(verify(19336), /只允许/);
  fixture.app.quit();
  await assert.rejects(verify(19335), /正在退出/);
});

for (const savedSelectedId of [null, "removed", "store"]) {
  test(`main defaults to the running installation without overriding a valid saved target (${savedSelectedId})`, async (context) => {
    const fixture = await harness(context, {
      savedSelectedId,
      detectedInstallations: [{ ...installations[1], isRunning: false, processIds: [] }, installations[0]],
    });
    const state = await fixture.ipc("cwb:get-state");
    assert.equal(state.selectedId, savedSelectedId === "store" ? "store" : "local");
    assert.equal(fixture.calls.dialogs.length, 0);
  });
}

test("main cancels opening another version, shows both paths, and defaults the dialog to cancel", async (context) => {
  const fixture = await harness(context, {
    acceptance: false,
    endpointReady: false,
    messageBoxResponse: 1,
    detectedInstallations: [installations[0], { ...installations[1], isRunning: false, processIds: [] }],
  });
  const detects = fixture.calls.detects;
  const result = await fixture.ipc("cwb:apply-codex", { installationId: "store", port: 19336 });
  assert.equal(result.ok, true);
  assert.equal(result.canceled, true);
  assert.match(result.message, /未启动另一版本/);
  assert.equal(fixture.calls.detects, detects + 1, "selected target and running peers must come from the same fresh snapshot");
  assert.equal(fixture.calls.dialogs.length, 1);
  const dialog = fixture.calls.dialogs[0][1];
  assert.equal(dialog.defaultId, 1);
  assert.equal(dialog.cancelId, 1);
  assert.deepEqual(copy(dialog.buttons), ["另开所选版本", "取消"]);
  assert.ok(dialog.detail.includes(installations[0].path));
  assert.ok(dialog.detail.includes(installations[1].path));
  assert.match(dialog.detail, /不会关闭/);
  assert.match(dialog.detail, /不会应用到原有窗口/);
  for (const key of ["launch", "close", "starts", "actions", "owner", "collect"]) assert.equal(fixture.calls[key].length, 0, key);
});

test("main explicitly opens the chosen separate version without closing any other installation", async (context) => {
  const fixture = await harness(context, {
    acceptance: false,
    endpointReady: false,
    detectedInstallations: [installations[0], { ...installations[1], isRunning: false, processIds: [] }],
  });
  const result = await fixture.ipc("cwb:apply-codex", { installationId: "store", port: 19336 });
  assert.equal(result.ok, true);
  assert.equal(result.closedCount, 0);
  assert.equal(fixture.calls.dialogs.length, 1);
  assert.equal(fixture.calls.close.length, 0);
  assert.equal(fixture.calls.launch.length, 1);
  assert.equal(fixture.calls.launch[0].installation.path, installations[1].path);
  assert.deepEqual(fixture.calls.owner, [{ installationId: "store", port: 19336 }]);
  assert.deepEqual(fixture.calls.actions.map(({ action }) => action), ["inject"]);
});

test("main needs no other-version dialog when all installations are stopped", async (context) => {
  const fixture = await harness(context, {
    acceptance: false,
    endpointReady: false,
    detectedInstallations: installations.map((entry) => ({ ...entry, isRunning: false, processIds: [] })),
  });
  assert.equal((await fixture.ipc("cwb:apply-codex", { installationId: "store", port: 19336 })).ok, true);
  assert.equal(fixture.calls.dialogs.length, 0);
  assert.equal(fixture.calls.close.length, 0);
  assert.equal(fixture.calls.launch.length, 1);
});

test("main only uses the existing close confirmation for a running selected target even if another version runs", async (context) => {
  const fixture = await harness(context, { acceptance: false, endpointReady: false });
  assert.equal((await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335 })).ok, true);
  assert.equal(fixture.calls.dialogs.length, 1);
  assert.equal(fixture.calls.dialogs[0][1].title, "Codex 正在运行");
  assert.equal(fixture.calls.close.length, 1);
  assert.equal(fixture.calls.close[0].installation.id, "local");
  assert.equal(fixture.calls.launch.length, 1);
  assert.equal(fixture.calls.launch[0].installation.id, "local");
});

test("main installs acceptance userData before the instance lock and isolates bridge environment and logs", async (context) => {
  const fixture = await harness(context);
  assert.deepEqual(fixture.calls.order.slice(0, 4), ["register-desktop-scheme", "acceptance-context", "setPath:userData", "instance-lock"]);
  assert.deepEqual(fixture.calls.reads, [path.join(fixture.acceptanceContext.userData, "settings.json")]);
  assert.equal((await fixture.ipc("cwb:open-control-panel", { port: 19335 })).ok, true);
  await turn();
  const fork = fixture.calls.forks[0];
  assert.equal(fork.options.env.LOCALAPPDATA, fixture.acceptanceContext.stateRoot);
  assert.equal(fork.options.env.XDG_CONFIG_HOME, fixture.acceptanceContext.stateRoot);
  assert.equal(fork.options.env.XDG_STATE_HOME, fixture.acceptanceContext.stateRoot);
  assert.equal(fork.options.env.KEEP_EXISTING, "kept");
  assert.equal(fork.options.env.CWB_BRIDGE_CLI, path.join(root, "bridge-runtime", "src", "cli.mjs"));
  assert.ok(fixture.calls.writes.every(({ filePath }) => filePath === path.join(fixture.acceptanceContext.userData, "settings.json")));
  assert.ok(fixture.calls.appends.length > 0);
  assert.ok(fixture.calls.appends.every(({ filePath }) => path.dirname(filePath) === fixture.acceptanceContext.logsRoot));
});

test("main installs the exact desktop origin before loading and rejects all old or foreign IPC origins", async context => {
  const fixture = await harness(context);
  assert.ok(fixture.calls.order.indexOf('install-desktop-protocol') < fixture.calls.order.indexOf(`loadURL:${rendererUrl}`));
  for (const url of [pathToFileURL(path.join(root, 'src', 'renderer', 'index.html')).href,
    'cwb-desktop://other/index.html', 'cwb-desktop://shell/index.html?foreign=1', 'http://127.0.0.1:1234/']) {
    await assert.rejects(fixture.ipc('cwb:get-state', undefined, url), /非本地页面/);
  }
  assert.ok((await fixture.ipc('cwb:get-state')).installations.length > 0);
});

test("main binds only the owned utility native provider using isolated parent config paths", async (context) => {
  const fixture = await harness(context);
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  assert.equal(fixture.calls.nativeHosts.length, 1); assert.equal(fixture.calls.nativePeers[0], fixture.children[0]);
  assert.equal(fixture.calls.nativeHosts[0].env.LOCALAPPDATA, fixture.acceptanceContext.stateRoot);
  assert.equal(fixture.calls.forks[0].options.env.CWB_NATIVE_ENGINE_PROVIDER, "owned-parent-v1");
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  assert.equal(fixture.calls.nativeHosts.length, 1); assert.equal(fixture.calls.nativePeers.length, 1);
});

test("desktop quit waits for native resource acknowledgement after actual utility exit", async (context) => {
  let resolve; const nativeCloseDeferred = new Promise((yes) => { resolve = yes; });
  const fixture = await harness(context, { nativeCloseDeferred });
  await fixture.ipc("cwb:open-control-panel", { port: 19335 }); fixture.trayActions.quit(); await turn();
  assert.equal(fixture.children[0].exited, true); assert.equal(fixture.calls.nativeCloses, 1);
  assert.deepEqual(fixture.calls.prevented, [true]); assert.equal(fixture.calls.trayDestroyed, 0);
  resolve(); await turn(); assert.deepEqual(fixture.calls.prevented, [true, false]);
  assert.ok(fixture.calls.order.indexOf("child.exit") < fixture.calls.order.indexOf("native.resources-closed"));
});

test("acceptance apply refuses an unavailable endpoint without launch, close, confirmation or injection", async (context) => {
  const fixture = await harness(context, { endpointReady: false });
  const result = await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335, adaptive: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /独立验收/);
  for (const key of ["launch", "close", "dialogs", "starts", "actions"]) assert.equal(fixture.calls[key].length, 0, key);
  // The failed apply may request diagnostics, but collection must first verify
  // the exact isolated manifest identity, independently of endpoint readiness.
  assert.deepEqual(fixture.calls.owner, [{ installationId: "local", port: 19335 }]);
  assert.deepEqual(fixture.calls.collect, [19335]);
  assert.ok(fixture.calls.order.indexOf("owner-query") < fixture.calls.order.indexOf("collect-diagnostics"));
});

test("main blocks the wrong installation and CDP port before apply or restore starts any bridge", async (context) => {
  const fixture = await harness(context, { acceptance: false });
  for (const channel of ["cwb:apply-codex", "cwb:restore"]) {
    const invalid = await fixture.ipc(channel, { installationId: "missing", port: 19335 });
    assert.equal(invalid.ok, false);
    assert.match(invalid.message, /有效的 Codex 安装/);
    const mismatch = await fixture.ipc(channel, { installationId: "store", port: 19335 });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.message, /不属于所选 Codex 安装/);
  }
  assert.deepEqual(fixture.calls.owner, [{ installationId: "store", port: 19335 }, { installationId: "store", port: 19335 }, { installationId: "store", port: 19335 }]);
  assert.equal(fixture.calls.collect.length, 0, "wrong ownership must never be followed by a diagnostic probe");
  for (const key of ["launch", "close", "starts", "actions"]) assert.equal(fixture.calls[key].length, 0, key);
});

test("main passes matched installation ownership gates before apply and restore use the shared bridge", async (context) => {
  const fixture = await harness(context);
  assert.equal((await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335, adaptive: false })).ok, true);
  assert.equal((await fixture.ipc("cwb:restore", { installationId: "local", port: 19335 })).ok, true);
  assert.deepEqual(fixture.calls.owner, [{ installationId: "local", port: 19335 }, { installationId: "local", port: 19335 }]);
  assert.deepEqual(fixture.calls.starts, [19335]);
  assert.deepEqual(fixture.calls.actions.map(({ action }) => action), ["inject", "restore"]);
  assert.equal(fixture.calls.actions[0].adaptive, false);
  const { pid, creation, profile } = fixture.acceptanceContext.expectedHost;
  assert.deepEqual(fixture.calls.expectedProcess, [{ pid, creation, profile }, { pid, creation, profile }]);
});

test("before-quit prevents exit until the actual preview session confirms child exit, then quits once more", async (context) => {
  const fixture = await harness(context, { autoExit: false });
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  fixture.trayActions.quit();
  await turn();
  assert.deepEqual(fixture.calls.prevented, [true]);
  assert.equal(fixture.children[0].killCount, 1);
  assert.equal(fixture.calls.trayDestroyed, 0);
  for (const channel of ["cwb:apply-codex", "cwb:restore", "cwb:open-control-panel"]) {
    await assert.rejects(fixture.ipc(channel, { installationId: "local", port: 19335 }), /退出/);
  }
  assert.equal(fixture.calls.starts.length, 1);
  assert.equal(fixture.calls.actions.length, 0);
  fixture.children[0].finish();
  await turn();
  assert.deepEqual(fixture.calls.prevented, [true, false]);
  assert.equal(fixture.calls.trayDestroyed, 1);
  assert.deepEqual(fixture.calls.order.filter((value) => ["app.quit", "child.kill", "child.exit"].includes(value)), ["app.quit", "child.kill", "child.exit", "app.quit"]);
});

test("failed shutdown retains its child, rejects restarting the bridge and can retry quitting", async (context) => {
  const fixture = await harness(context, { rejectKill: true });
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  fixture.trayActions.quit();
  await turn();
  assert.equal(fixture.calls.errors.length, 1);
  assert.deepEqual(fixture.calls.prevented, [true]);
  const reopen = await fixture.ipc("cwb:open-control-panel", { port: 19336 })
    .catch((error) => ({ ok: false, message: error.message }));
  assert.equal(reopen.ok, false);
  assert.match(reopen.message, /退出|关闭/);
  assert.equal(fixture.calls.starts.length, 1);
  fixture.children[0].rejectKill = false;
  fixture.trayActions.quit();
  await turn();
  assert.deepEqual(fixture.calls.prevented, [true, true, false]);
  assert.equal(fixture.children[0].killCount, 2);
  assert.equal(fixture.calls.trayDestroyed, 1);
});

test("quitting rejects every mutating IPC without settings writes or dialogs", async (context) => {
  const fixture = await harness(context, { autoExit: false });
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  fixture.trayActions.quit();
  await turn();
  const before = { writes: fixture.calls.writes.length, dialogs: fixture.calls.dialogs.length, detects: fixture.calls.detects };
  for (const channel of ["cwb:refresh-installations", "cwb:choose-executable"]) {
    await assert.rejects(fixture.ipc(channel), /退出/, `${channel} must fail while quitting`);
  }
  assert.deepEqual({ writes: fixture.calls.writes.length, dialogs: fixture.calls.dialogs.length, detects: fixture.calls.detects }, before);
});

test("failed shutdown never reopens apply paths that could close or launch Codex", async (context) => {
  const fixture = await harness(context, { acceptance: false, endpointReady: false, rejectKill: true });
  await fixture.ipc("cwb:open-control-panel", { port: 19335 });
  fixture.trayActions.quit();
  await turn();
  assert.equal(fixture.calls.errors.length, 1);
  // IPC may reject at its outer guard or return a structured operation failure.
  const result = await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335 })
    .catch((error) => ({ ok: false, message: error.message }));
  assert.equal(result.ok, false);
  assert.match(result.message, /退出|关闭/);
  for (const key of ["launch", "close", "dialogs", "actions"]) assert.equal(fixture.calls[key].length, 0, key);
  assert.equal(fixture.calls.starts.length, 1);
});

test("acceptance refuses a valid but unlisted host instead of widening its target manifest", async (context) => {
  const fixture = await harness(context);
  for (const channel of ["cwb:apply-codex", "cwb:restore"]) {
    const result = await fixture.ipc(channel, { installationId: "store", port: 19336 });
    assert.equal(result.ok, false);
    assert.match(result.message, /target\.json/);
  }
  for (const key of ["owner", "collect", "launch", "close", "starts", "actions"]) assert.equal(fixture.calls[key].length, 0, key);
});

test("failed apply diagnostics verify ownership again and save only probe metadata, never URLs or titles", async (context) => {
  const fixture = await harness(context, { actionFailure: true, diagnostics: {
    collectedAt: "2026-10-09T00:00:00.000Z",
    endpoint: "PRIVATE_ENDPOINT_URL",
    browser: { Browser: "155.0.0.0", ProtocolVersion: "1.3" },
    targets: [{
      id: "PRIVATE_TARGET_ID", type: "page", score: 15, titleMatchesCodex: true,
      url: "PRIVATE_TARGET_URL", title: "PRIVATE_TARGET_TITLE", error: "PRIVATE_TARGET_ERROR",
      probe: { title: "PRIVATE_PROBE_TITLE", href: "PRIVATE_PROBE_HREF", userAgent: "PRIVATE_PROBE_AGENT", hasRoot: true, semanticHookCount: 4, composerHookCount: 2, descendantCount: 200 },
      diagnostics: { viewport: { width: 1040, height: 700 }, wallpaperMedia: null, surfaces: [] },
    }],
  } });
  assert.equal((await fixture.ipc("cwb:apply-codex", { installationId: "local", port: 19335 })).ok, false);
  assert.deepEqual(fixture.calls.owner, [{ installationId: "local", port: 19335 }, { installationId: "local", port: 19335 }]);
  assert.deepEqual(fixture.calls.collect, [19335]);
  const trace = fixture.calls.order.filter((value) => ["owner-query", "collect-diagnostics"].includes(value));
  assert.deepEqual(trace, ["owner-query", "owner-query", "collect-diagnostics"]);
  const records = fixture.calls.writes.filter(({ filePath }) => path.basename(filePath).startsWith("codex-compat-"));
  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0].content, /PRIVATE_|"url"|"href"|"title"/);
  const saved = JSON.parse(records[0].content);
  assert.equal(saved.collectionError, null);
  assert.deepEqual(saved.targets[0].probe, { hasRoot: true, semanticHookCount: 4, composerHookCount: 2, descendantCount: 200 });
  assert.deepEqual(saved.targets[0].diagnostics.viewport, { width: 1040, height: 700 });
  assert.equal(path.dirname(records[0].filePath), fixture.acceptanceContext.logsRoot);
});

const takeoverOrdinary = { processId: 2001, commandLine: 'ChatGPT.exe', mainWindowHandle: 99 };
test('restore cancels an in-flight takeover before launch and drains it before restoring', async context => {
  let ready = true, releaseClose;
  const f = await harness(context, { acceptance: false, endpointReady: () => ready,
    takeoverProcesses: [takeoverOrdinary], duringClose: () => new Promise(r => { releaseClose = r; }) });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 });
  ready = false;
  const takeover = f.calls.watchers[0].options.onTakeover({ ordinary: [takeoverOrdinary] });
  await turn(); assert.equal(f.calls.close.length, 1);
  const restoring = f.ipc('cwb:restore', { installationId: 'local', port: 19335 });
  await turn(); assert.equal(f.calls.watchers[0].stopped, true);
  assert.equal(f.calls.actions.filter(a => a.action === 'restore').length, 0);
  releaseClose(); await takeover; assert.equal((await restoring).ok, true);
  assert.equal(f.calls.launch.length, 0);
  assert.equal(f.calls.actions.filter(a => a.action === 'restore').length, 1);
});
test('quit cancels takeover and waits for an in-flight close without relaunching Codex', async context => {
  let ready = true, releaseClose;
  const f = await harness(context, { acceptance: false, endpointReady: () => ready,
    takeoverProcesses: [takeoverOrdinary], duringClose: () => new Promise(r => { releaseClose = r; }) });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 }); ready = false;
  const takeover = f.calls.watchers[0].options.onTakeover({ ordinary: [takeoverOrdinary] });
  await turn(); f.app.quit(); await turn(); assert.equal(f.calls.trayDestroyed, 0);
  releaseClose(); await takeover; await turn(); await turn();
  assert.equal(f.calls.launch.length, 0); assert.equal(f.calls.trayDestroyed, 1);
});
test('canceled apply to another installation stops the old watcher and ignores late snapshots', async context => {
  let ready = true;
  const f = await harness(context, { acceptance: false, endpointReady: () => ready, messageBoxResponse: 1 });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 }); ready = false;
  const old = f.calls.watchers[0];
  const result = await f.ipc('cwb:apply-codex', { installationId: 'store', port: 19336 });
  assert.equal(result.canceled, true); assert.equal(old.stopped, true);
  f.calls.monitors[0].options.onSnapshot({ sequence: 99, capturedAt: Date.now(), processes: [takeoverOrdinary] });
  assert.equal(await old.options.listProcesses(), null);
  await old.options.onTakeover({ ordinary: [takeoverOrdinary] });
  assert.equal(f.calls.close.length, 0); assert.equal(f.calls.launch.length, 0);
});
test('monitor failure stops takeover and discards its cached snapshot', async context => {
  const f = await harness(context, { acceptance: false });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 });
  const monitor = f.calls.monitors[0], watcher = f.calls.watchers[0];
  monitor.options.onSnapshot({ sequence: 1, capturedAt: Date.now(), processes: [takeoverOrdinary] });
  monitor.options.onError(new Error('monitor exited'));
  assert.equal(monitor.stopped, true); assert.equal(watcher.stopped, true);
  assert.equal(await watcher.options.listProcesses(), null);
  await watcher.options.onTakeover({ ordinary: [takeoverOrdinary] });
  assert.equal(f.calls.close.length, 0);
});

test('same port as string or omitted does not disable the active takeover monitor', async context => {
  const f = await harness(context, { acceptance: false });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 });
  assert.equal((await f.ipc('cwb:open-control-panel', { port: '19335' })).ok, true);
  assert.equal((await f.ipc('cwb:open-control-panel', {})).ok, true);
  assert.equal(f.calls.watchers[0].stopped, false);
});
test('busy apply and restore do not disable monitoring when a different operation owns the lock', async context => {
  let block = false, releaseWrite;
  const f = await harness(context, { acceptance: false,
    duringWrite: () => block ? new Promise(r => { releaseWrite = r; }) : undefined });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 });
  block = true; const panel = f.ipc('cwb:open-control-panel', { port: 19335 }); await turn();
  for (const channel of ['cwb:apply-codex', 'cwb:restore']) {
    const result = await f.ipc(channel, { installationId: 'local', port: 19335 });
    assert.equal(result.ok, false); assert.match(result.message, /载入壁纸面板/);
    assert.equal(f.calls.watchers[0].stopped, false);
  }
  block = false; releaseWrite(); assert.equal((await panel).ok, true);
});
test('opening a different panel port cancels and drains an active takeover', async context => {
  let ready = true, releaseClose;
  const f = await harness(context, { acceptance: false, endpointReady: () => ready,
    takeoverProcesses: [takeoverOrdinary], duringClose: () => new Promise(r => { releaseClose = r; }) });
  await f.ipc('cwb:apply-codex', { installationId: 'local', port: 19335 }); ready = false;
  const takeover = f.calls.watchers[0].options.onTakeover({ ordinary: [takeoverOrdinary] }); await turn();
  const panel = f.ipc('cwb:open-control-panel', { port: '19336' }); await turn();
  assert.equal(f.calls.watchers[0].stopped, true); assert.equal(f.calls.launch.length, 0);
  releaseClose(); await takeover; assert.equal((await panel).ok, true);
  assert.equal(f.calls.launch.length, 0); assert.equal(f.calls.starts.at(-1), 19336);
});

test('second-instance with --quit-running-instance triggers graceful quit instead of showing the window', async context => {
  const f = await harness(context, { acceptance: false });
  await f.ipc('cwb:open-control-panel', { port: 19335 });
  f.app.emit('second-instance', {}, ['CodexWallpaperDesktop.exe', '--quit-running-instance']);
  await turn();
  assert.equal(f.calls.trayDestroyed, 1);
  assert.equal(f.children[0].killCount, 1);
});
