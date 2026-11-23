import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { CdpWallpaperInjector } from "../bridge-overrides/src/cdp-injector.mjs";
import { buildInjectionPlan } from "../bridge-overrides/src/injection-plan.mjs";
import { eligibleProjects } from "../bridge-runtime/src/library-policy.mjs";
import {
  buildCompatibilityRestoreScript,
  buildCompatibilityScript,
} from "../src/compatibility-script.mjs";

const compatibilityRestoreScript = buildCompatibilityRestoreScript();

function plan(adaptive = true) {
  return {
    bootstrapScript: "bootstrap-script",
    applyScript: "apply-script",
    compatibilityScript: buildCompatibilityScript({ adaptive }),
    compatibilityRestoreScript,
  };
}

function harness(context, { onSocket } = {}) {
  const sockets = new Map();
  const statuses = [];
  const failUrls = new Set();
  const failConnectUrls = new Set();
  let targets = [{ id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" }];
  const injector = new CdpWallpaperInjector({
    pollIntervalMs: 60_000,
    onStatus: (status) => statuses.push(status),
    socketFactory: (url) => {
      const calls = [];
      const handlers = new Map();
      const closeHandlers = new Set();
      const socket = {
        calls,
        compatibilityFailure: failUrls.has(url),
        restorationFailure: false,
        closed: false,
        ws: { readyState: 1, once(event, handler) { if (event === "close") closeHandlers.add(handler); } },
        async connect() { if (failConnectUrls.has(url)) throw new Error("target connection failed"); },
        async call(method, params = {}) {
          calls.push({ method, params });
          if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `hook:${url}` };
          if (method === "Runtime.evaluate") {
            if (params.expression === compatibilityRestoreScript) return { result: { value: !socket.restorationFailure } };
            if (params.expression.includes("codex-wallpaper-electron-compat-style")) {
              return { result: { value: { ok: !socket.compatibilityFailure } } };
            }
            return { result: { value: { ok: true, ready: true, runtimeReady: true, domReady: true } } };
          }
          return {};
        },
        onEvent(method, handler) {
          const listeners = handlers.get(method) || new Set();
          listeners.add(handler);
          handlers.set(method, listeners);
          return () => listeners.delete(handler);
        },
        emit(method) {
          for (const handler of handlers.get(method) || []) handler({});
        },
        close() {
          socket.closed = true;
          socket.ws.readyState = 3;
          for (const handler of closeHandlers) handler();
          closeHandlers.clear();
        },
      };
      onSocket?.(socket, url);
      sockets.set(url, socket);
      return socket;
    },
  });
  injector.listTargets = async () => targets;
  context.after(() => injector.close());
  return { injector, sockets, statuses, failUrls, failConnectUrls, setTargets: (value) => { targets = value; } };
}

function evaluationCount(socket, expression) {
  return socket.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression === expression).length;
}

test("compatibility is reapplied after reload and automatically installed in new targets", async (context) => {
  const { injector, sockets, setTargets } = harness(context);
  const injection = plan();
  await injector.start(injection);
  const main = sockets.get("mock:main");
  assert.equal(evaluationCount(main, injection.compatibilityScript), 1);
  main.emit("Page.loadEventFired");
  await injector.sessions.get("main").rehydrating;
  assert.equal(evaluationCount(main, injection.compatibilityScript), 2);
  setTargets([
    { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" },
    { id: "second", url: "app://second", webSocketDebuggerUrl: "mock:second" },
  ]);
  await injector.scanOnce();
  assert.equal(evaluationCount(sockets.get("mock:second"), injection.compatibilityScript), 1);
});

test("adaptive switches to safe mode and remains safe after reload", async (context) => {
  const { injector, sockets } = harness(context);
  await injector.start(plan(true));
  const safe = plan(false);
  assert.equal((await injector.update(safe)).failed, 0);
  const main = sockets.get("mock:main");
  main.emit("Page.loadEventFired");
  await injector.sessions.get("main").rehydrating;
  assert.equal(evaluationCount(main, plan(true).compatibilityScript), 1);
  assert.equal(evaluationCount(main, safe.compatibilityScript), 2);
});

test("external page reload rearms one theme refresh while automatic theme reload does not", async (context) => {
  const { injector, sockets } = harness(context, {
    onSocket(socket) {
      const originalCall = socket.call;
      socket.call = async (method, params = {}) => {
        const result = await originalCall(method, params);
        if (method === "Page.reload") {
          queueMicrotask(() => socket.emit("Page.loadEventFired"));
        }
        if (method === "Runtime.evaluate" && params.expression === "apply-script") {
          result.result.value.theme = { reloadRequired: true };
        }
        return result;
      };
    },
  });
  await injector.start(plan());
  const main = sockets.get("mock:main");
  const reloads = () => main.calls.filter(({ method }) => method === "Page.reload").length;
  assert.equal(reloads(), 1);
  await injector.update(plan(false));
  assert.equal(reloads(), 1);

  main.emit("Page.loadEventFired");
  await injector.sessions.get("main").rehydrating;
  assert.equal(reloads(), 2);
  await injector.update(plan(false));
  assert.equal(reloads(), 2);
  assert.equal(injector.sessions.get("main").themeReloadHandled, true);
});

test("restore clears both layers and stops reload and new-target reinjection", async (context) => {
  const { injector, sockets, setTargets } = harness(context);
  const injection = plan(false);
  await injector.start(injection);
  const main = sockets.get("mock:main");
  await injector.restore();
  assert.equal(evaluationCount(main, compatibilityRestoreScript), 1);
  assert.equal(injector.running, false);
  assert.equal(injector.compatibilityScript, "");
  main.emit("Page.loadEventFired");
  setTargets([{ id: "new", url: "app://new", webSocketDebuggerUrl: "mock:new" }]);
  await injector.scanOnce();
  assert.equal(evaluationCount(main, injection.compatibilityScript), 1);
  assert.equal(evaluationCount(sockets.get("mock:new"), injection.compatibilityScript), 0);
});

test("compatibility verification failure is propagated and not marked injection-ready", async (context) => {
  const { injector, sockets, statuses } = harness(context);
  await injector.start(plan());
  statuses.length = 0;
  sockets.get("mock:main").compatibilityFailure = true;
  const result = await injector.update(plan(false));
  assert.equal(result.failed, 1);
  assert.equal(statuses.some(({ type }) => type === "injection-ready"), false);
});

test("initial attach reports partial target failures instead of silently accepting another successful target", async (context) => {
  const { injector, sockets, failUrls, setTargets } = harness(context);
  failUrls.add("mock:failed");
  setTargets([
    { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" },
    { id: "failed", url: "app://failed", webSocketDebuggerUrl: "mock:failed" },
  ]);
  const result = await injector.start(plan());
  assert.equal(result.sessions, 1);
  assert.equal(result.failed, 1);
  assert.equal(evaluationCount(sockets.get("mock:failed"), compatibilityRestoreScript), 1);
});

test("restore waits for an in-flight apply and prevents its late compatibility reinjection", async (context) => {
  const { injector, sockets } = harness(context);
  await injector.start(plan());
  const main = sockets.get("mock:main");
  const originalCall = main.call;
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  main.call = async (method, params = {}) => {
    if (method === "Runtime.evaluate" && params.expression === "apply-script") {
      began();
      await pending;
    }
    return originalCall(method, params);
  };
  const update = injector.update(plan(false));
  await started;
  const restoration = injector.restore();
  await assert.rejects(injector.update(plan()), /restoration is in progress/);
  release();
  assert.equal((await update).failed, 1);
  await restoration;
  assert.equal(evaluationCount(main, plan(false).compatibilityScript), 0);
  assert.equal(evaluationCount(main, compatibilityRestoreScript), 1);
});

test("a concurrent safe-mode update wins over an older in-flight reload", async (context) => {
  const { injector, sockets } = harness(context);
  await injector.start(plan());
  const main = sockets.get("mock:main");
  const originalCall = main.call;
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  main.call = async (method, params = {}) => {
    if (method === "Runtime.evaluate" && params.expression === "bootstrap-script") {
      began();
      await pending;
    }
    return originalCall(method, params);
  };
  main.emit("Page.loadEventFired");
  const reload = injector.sessions.get("main").rehydrating;
  await started;
  const update = injector.update(plan(false));
  release();
  await reload;
  assert.equal((await update).failed, 0);
  const compatibilityCalls = main.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes("codex-wallpaper-electron-compat-style"));
  assert.equal(compatibilityCalls.at(-1).params.expression, plan(false).compatibilityScript);
});

test("an in-flight new-target attach catches up with the latest safe mode and configuration before registering", async (context) => {
  const attaching = gate();
  const { injector, sockets, setTargets } = harness(context, { onSocket: (socket, url) => {
    if (url !== "mock:second") return;
    const originalCall = socket.call;
    socket.call = async (method, params = {}) => {
      if (method === "Runtime.evaluate" && params.expression === "bootstrap-script") await attaching.wait();
      return originalCall(method, params);
    };
  } });
  await injector.start(plan(true));
  setTargets([
    { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" },
    { id: "second", url: "app://second", webSocketDebuggerUrl: "mock:second" },
  ]);
  const scan = injector.scanOnce();
  await attaching.entered;
  const latest = { ...plan(false), applyScript: "apply-latest" };
  await injector.update(plan(false));
  await injector.update(plan(true));
  await injector.update(latest);
  attaching.release();
  await scan;
  const second = sockets.get("mock:second");
  const evaluations = second.calls.filter(({ method }) => method === "Runtime.evaluate");
  assert.equal(evaluations.at(-1).params.expression, latest.compatibilityScript);
  assert.equal(evaluations.filter(({ params }) => params.expression.startsWith("apply-")).at(-1).params.expression, "apply-latest");
  assert.equal(second.calls.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
  assert.ok(injector.sessions.has("second"));
});

test("compatibility restoration failure still clears wallpaper and CSP but is not reported as restored", async (context) => {
  const { injector, sockets, statuses } = harness(context);
  await injector.start(plan());
  const main = sockets.get("mock:main");
  main.restorationFailure = true;
  await assert.rejects(injector.restore(), /compatibility restoration verification failed/);
  assert.ok(main.calls.some(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes("runtime?.restore")));
  assert.ok(main.calls.some(({ method, params }) => method === "Page.setBypassCSP" && params.enabled === false));
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
  assert.equal(injector.running, false);
});

test("a target-list scan started before restore or close cannot attach targets after cleanup", async (context) => {
  for (const close of [false, true]) {
    const { injector, sockets } = harness(context);
    await injector.start(plan());
    const scanGate = gate();
    let calls = 0;
    injector.listTargets = async () => {
      if (++calls > 1) return [{ id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" }];
      await scanGate.wait();
      return [{ id: "late", url: "app://late", webSocketDebuggerUrl: "mock:late" }];
    };
    const scan = injector.scanOnce();
    await scanGate.entered;
    if (close) await injector.close({ restore: true });
    else await injector.restore();
    scanGate.release();
    await scan;
    assert.equal(sockets.has("mock:late"), false);
  }
});

test("restore reconnects a disconnected live target without reinstalling wallpaper and removes its original hook", async (context) => {
  const { injector, sockets, statuses } = harness(context);
  await injector.start(plan(false));
  const original = sockets.get("mock:main");
  original.close();
  assert.equal(injector.sessions.size, 0);
  await injector.restore();
  const recovery = sockets.get("mock:main");
  assert.notEqual(recovery, original);
  assert.equal(evaluationCount(recovery, "bootstrap-script"), 0);
  assert.equal(evaluationCount(recovery, "apply-script"), 0);
  assert.equal(evaluationCount(recovery, plan(false).compatibilityScript), 0);
  assert.equal(evaluationCount(recovery, compatibilityRestoreScript), 1);
  assert.ok(recovery.calls.some(({ method, params }) => method === "Page.removeScriptToEvaluateOnNewDocument" && params.identifier === "hook:mock:main"));
  assert.equal(recovery.calls.some(({ method, params }) => method === "Page.setBypassCSP" && params.enabled === true), false);
  assert.ok(statuses.some(({ type }) => type === "restored"));
});

test("restore rejects no current targets instead of accepting an empty session set", async (context) => {
  const { injector, sockets, statuses, setTargets } = harness(context);
  await injector.start(plan());
  sockets.get("mock:main").close();
  setTargets([]);
  await assert.rejects(injector.restore(), /没有找到可完整恢复/);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test("restore confirms target coverage and fails if one live target cannot reconnect", async (context) => {
  const { injector, sockets, statuses, failConnectUrls, setTargets } = harness(context);
  await injector.start(plan());
  failConnectUrls.add("mock:failed");
  setTargets([
    { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" },
    { id: "failed", url: "app://failed", webSocketDebuggerUrl: "mock:failed" },
  ]);
  await assert.rejects(injector.restore(), /target connection failed/);
  assert.equal(evaluationCount(sockets.get("mock:main"), compatibilityRestoreScript), 1);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test('Restore reconciles a proven-closed HTTP500 target and covers newly created pages without reinstalling', async context => {
  const { injector, sockets, statuses, setTargets } = harness(context);
  await injector.start(plan());
  const main = { id: 'main', url: 'app://main', webSocketDebuggerUrl: 'mock:main' };
  const next = { id: 'next', url: 'app://next', webSocketDebuggerUrl: 'mock:next' };
  setTargets([main, { id: 'gone', url: 'app://gone', webSocketDebuggerUrl: 'mock:gone' }]);
  const factory = injector.socketFactory;
  injector.socketFactory = url => url !== 'mock:gone' ? factory(url) : {
    async connect() { setTargets([main, next]); throw Object.assign(Error('Unexpected server response: 500'), { cwbHandshakeStatus: 500 }); }, close() {},
  };
  await injector.restore();
  assert.equal(evaluationCount(sockets.get('mock:next'), 'bootstrap-script'), 0);
  assert.equal(evaluationCount(sockets.get('mock:next'), 'apply-script'), 0);
  assert.equal(evaluationCount(sockets.get('mock:next'), compatibilityRestoreScript), 1);
  assert.ok(statuses.some(s => s.type === 'restoration-target-gone'));
  assert.ok(statuses.some(s => s.type === 'restored'));
});

test('Restore retains hook metadata and fails for a navigated but still-live target outside the renderer cohort', async context => {
  const { injector, sockets } = harness(context);
  await injector.start(plan()); sockets.get('mock:main').close();
  const next = { id: 'next', url: 'app://next', webSocketDebuggerUrl: 'mock:next' };
  const navigated = { id: 'main', url: 'https://example.invalid/', webSocketDebuggerUrl: 'mock:main' };
  injector.listTargets = async ({ includeAll = false } = {}) => includeAll ? [next, navigated] : [next];
  await assert.rejects(injector.restore(), /live target outside renderer cohort/);
  assert.equal(injector.disconnectedSessions.get('main')?.newDocumentId, 'hook:mock:main');
});

test('Restore rejects a still-listed HTTP500 instead of claiming the unresponsive target was closed', async context => {
  const { injector, statuses, setTargets } = harness(context);
  await injector.start(plan());
  setTargets([{ id: 'main', url: 'app://main', webSocketDebuggerUrl: 'mock:main' },
    { id: 'hung', url: 'app://hung', webSocketDebuggerUrl: 'mock:hung' }]);
  const factory = injector.socketFactory;
  injector.socketFactory = url => url !== 'mock:hung' ? factory(url) : {
    async connect() { throw Object.assign(Error('Unexpected server response: 500'), { cwbHandshakeStatus: 500 }); }, close() {},
  };
  await assert.rejects(injector.restore(), /Unexpected server response: 500/);
  assert.equal(statuses.some(s => s.type === 'restored'), false);
});

test("restore rejects a failed target enumeration even if stale sessions still exist", async (context) => {
  const { injector, statuses } = harness(context);
  await injector.start(plan());
  injector.listTargets = async () => { throw new Error("CDP endpoint unreachable"); };
  await assert.rejects(injector.restore(), /CDP endpoint unreachable/);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test("a failed close retains disconnected hook metadata for a later restore-only retry", async (context) => {
  const { injector, sockets } = harness(context);
  await injector.start(plan());
  const original = sockets.get("mock:main");
  const originalCall = original.call;
  original.call = async (method, params) => {
    if (method === "Page.removeScriptToEvaluateOnNewDocument") throw new Error("hook cleanup failed");
    return originalCall(method, params);
  };
  const originalClose = original.close;
  original.close = () => queueMicrotask(originalClose);
  await assert.rejects(injector.close({ restore: true }), /hook cleanup failed/);
  assert.equal(injector.disconnectedSessions.get("main").newDocumentId, "hook:mock:main");
  await injector.restore();
  const recovery = sockets.get("mock:main");
  assert.ok(recovery.calls.some(({ method, params }) => method === "Page.removeScriptToEvaluateOnNewDocument" && params.identifier === "hook:mock:main"));
  assert.equal(evaluationCount(recovery, "apply-script"), 0);
});

test("plain script injection does not force a compatibility layer", async (context) => {
  const { injector, sockets } = harness(context);
  await injector.start("apply-script");
  assert.equal(sockets.get("mock:main").calls.some(({ params }) => String(params.expression).includes("codex-wallpaper-electron-compat-style")), false);
});

test("compatibility scripts remain separate from small media-independent runtime and apply payloads", () => {
  const token = "1234567890abcdef1234567890abcdef";
  const server = { origin: "http://127.0.0.1:43123", basePath: `/${token}` };
  const inventory = { projects: [{
    id: "video", title: "Video", type: "video", playable: true,
    previewUrl: `/${token}/api/preview/video`, mediaUrl: `/${token}/api/video/video`, webUrl: null,
  }] };
  const injection = {
    ...buildInjectionPlan({ server, config: { selectedId: "video" }, inventory }),
    compatibilityScript: buildCompatibilityScript({ adaptive: true }),
    compatibilityRestoreScript,
  };
  assert.ok(Buffer.byteLength(injection.bootstrapScript) < 100 * 1024);
  assert.ok(Buffer.byteLength(injection.applyScript) < 10 * 1024);
  assert.ok(Buffer.byteLength(injection.compatibilityScript) < 100 * 1024);
  assert.doesNotMatch(JSON.stringify(injection), /data:video|;base64,/i);
});

async function cliHarness({ startResult = { sessions: 1, failed: 0, timings: [] }, updateResult = { sessions: 1, failed: 0, timings: [] }, onStart, onUpdate, onClose, onServerClose, onMediaConfigure, nativeProvider = null } = {}) {
  const injections = [];
  const closings = [];
  const instances = [];
  const events = [];
  const signals = new Map();
  const exits = [];
  const errors = [];
  let serverOptions;
  let started;
  let registered;
  let exited;
  const ready = new Promise((resolve) => { started = resolve; });
  const handlersReady = new Promise((resolve) => { registered = resolve; });
  const exit = new Promise((resolve) => { exited = resolve; });
  const source = await readFile(new URL("../bridge-overrides/src/cli.mjs", import.meta.url), "utf8");
  // Run the CLI's actual action routing with isolated filesystem/process/media
  // dependencies. No real config, server, or target process is created.
  const sandbox = {
    path, os, fileURLToPath, eligibleProjects, sceneAssetCache: { clear() {} },
    process: {
      argv: ["node", "cli", "preview", "--no-open"], platform: "linux", env: {},
      on(signal, handler) { signals.set(signal, handler); if (signal === "SIGTERM") registered(); },
      exit(code) { exits.push(code); exited(); },
    },
    console: { log() {}, error(message) { errors.push(message); } },
    performance,
    mkdir: async () => {}, rm: async () => {}, writeFile: async () => {},
    buildCompatibilityScript, buildCompatibilityRestoreScript,
    openNativeEngineProvider: () => nativeProvider,
    LyricsStore: class {},
    MediaMiddleware: class { async configure() { await onMediaConfigure?.(); } async snapshot() { return { power: { onBattery: false } }; } async close() {} },
    createConfigStore: () => ({ filePath: path.join(os.tmpdir(), 'cwb-fixture', 'config.json'), load: async () => {}, get: async () => ({ selectedId: "video" }), set: async () => {} }),
    scanWallpaperProjects: async () => ({ projects: [{ id: "video" }], warnings: [] }),
    buildCurrentInjection: async () => ({ bootstrapScript: "bootstrap-script", applyScript: "apply-script", metrics: {} }),
    CdpWallpaperInjector: class {
      constructor() { this.running = false; this.id = instances.length + 1; instances.push(this); events.push(`create:${this.id}`); }
      async start(injection) {
        this.running = true;
        events.push(`start:${this.id}:begin`);
        injections.push(injection);
        await onStart?.(this, injection);
        events.push(`start:${this.id}:end`);
        return startResult;
      }
      async update(injection) {
        events.push(`update:${this.id}:begin`);
        injections.push(injection);
        await onUpdate?.(this, injection);
        events.push(`update:${this.id}:end`);
        return updateResult;
      }
      async updatePower() {}
      async preloadScene() { return { ok: true, status: 'skipped', targets: 0 }; }
      async close(options) {
        events.push(`close:${this.id}:begin`);
        closings.push(options);
        try { await onClose?.(this, options); }
        finally { this.running = false; events.push(`close:${this.id}:end`); }
      }
    },
    restoreCdpWallpaper: async (options) => { closings.push(options); },
    createMediaServer: (options) => {
      serverOptions = options;
      return {
        baseUrl: "http://127.0.0.1:43123/mock/", start: async () => started(),
        close: async () => { events.push("server:closed"); await onServerClose?.(); }, setProjects() {},
        projects: async () => [{ id: "video" }],
      };
    },
  };
  const executable = source.replace(/^#!.*\r?\n/, "")
    .replace(/^import .*;\r?$/gm, "")
    .replace(/import\.meta\.url/g, JSON.stringify(new URL("../bridge-overrides/src/cli.mjs", import.meta.url).href))
    .replace(/\nmain\(\)\.catch\(\(error\) => \{[\s\S]*$/, "\nglobalThis.testMain = main;");
  runInNewContext(executable, sandbox);
  void sandbox.testMain();
  await ready;
  await handlersReady;
  return { serverOptions, injections, closings, instances, events, signals, exits, exit, errors };
}

test("CLI uses trusted compatibility builders, validates adaptive and preserves safe mode across config updates", async () => {
  const { serverOptions, injections, closings } = await cliHarness();
  await assert.rejects(serverOptions.onAction("inject", { adaptive: "false" }), /兼容模式必须是布尔值/);
  assert.equal(injections.length, 0);
  await serverOptions.onAction("inject", { adaptive: false, compatibilityScript: "untrusted-script" });
  await serverOptions.onConfigChange();
  assert.equal(injections.length, 2);
  for (const injection of injections) {
    assert.equal(injection.compatibilityScript, plan(false).compatibilityScript);
    assert.equal(injection.compatibilityRestoreScript, compatibilityRestoreScript);
    assert.doesNotMatch(JSON.stringify(injection), /untrusted-script/);
  }
  await serverOptions.onAction("restore");
  await serverOptions.onConfigChange();
  assert.equal(injections.length, 2);
  assert.equal(closings[0].restore, true);
});

test('M3 cold media startup cannot block an already committed configuration save handshake', async () => {
  let blocking = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await cliHarness({ onMediaConfigure: () => blocking ? pending : undefined }); blocking = true;
  const saving = f.serverOptions.onConfigChange();
  try {
    const result = await Promise.race([saving.then(() => 'saved'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
    assert.equal(result, 'saved');
  } finally { blocking = false; release(); await saving; }
});

test("CLI rejects a partially failed initial injection and closes its injector", async () => {
  const { serverOptions, closings } = await cliHarness({ startResult: { sessions: 1, failed: 1, timings: [] } });
  await assert.rejects(serverOptions.onAction("inject", { adaptive: true }), /未能完成注入验证/);
  assert.equal(closings[0].restore, true);
});

function gate() {
  let began;
  let release;
  const entered = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { began(); await pending; } };
}

test("concurrent CLI inject and config changes wait for the first startup and use one instance", async () => {
  const startup = gate();
  const { serverOptions, instances, events, injections } = await cliHarness({ onStart: () => startup.wait() });
  const first = serverOptions.onAction("inject", { adaptive: true });
  await startup.entered;
  const second = serverOptions.onAction("inject", { adaptive: false });
  const config = serverOptions.onConfigChange();
  await Promise.resolve();
  assert.equal(instances.length, 1);
  assert.equal(events.some((event) => event.startsWith("update:")), false);
  startup.release();
  await Promise.all([first, second, config]);
  assert.ok(events.indexOf("start:1:end") < events.indexOf("update:1:begin"));
  assert.equal(instances.length, 1);
  assert.equal(injections.length, 3);
  assert.equal(injections[0].compatibilityScript, plan(true).compatibilityScript);
  assert.equal(injections[1].compatibilityScript, plan(false).compatibilityScript);
  assert.equal(injections[2].compatibilityScript, plan(false).compatibilityScript);
});

test("CLI inject cannot create another instance while the previous restore is still closing", async () => {
  const restoration = gate();
  const { serverOptions, instances, events } = await cliHarness({ onClose: () => restoration.wait() });
  await serverOptions.onAction("inject", { adaptive: true });
  const restore = serverOptions.onAction("restore");
  await restoration.entered;
  const inject = serverOptions.onAction("inject", { adaptive: false });
  const config = serverOptions.onConfigChange();
  await Promise.resolve();
  assert.equal(instances.length, 1);
  restoration.release();
  await Promise.all([restore, inject, config]);
  assert.equal(instances.length, 2);
  assert.ok(events.indexOf("close:1:end") < events.indexOf("create:2"));
});

test("CLI restore and a new inject wait for an in-flight config update", async () => {
  const update = gate();
  const { serverOptions, instances, closings, events } = await cliHarness({ onUpdate: () => update.wait() });
  await serverOptions.onAction("inject", { adaptive: true });
  const config = serverOptions.onConfigChange();
  await update.entered;
  const restore = serverOptions.onAction("restore");
  const inject = serverOptions.onAction("inject", { adaptive: false });
  await Promise.resolve();
  assert.equal(closings.length, 0);
  assert.equal(instances.length, 1);
  update.release();
  await Promise.all([config, restore, inject]);
  assert.ok(events.indexOf("update:1:end") < events.indexOf("close:1:begin"));
  assert.ok(events.indexOf("close:1:end") < events.indexOf("create:2"));
});

test("a failed CLI restore propagates its error without poisoning later queued injection", async () => {
  const restoration = gate();
  const { serverOptions, instances, events } = await cliHarness({ onClose: async () => {
    await restoration.wait();
    throw new Error("restore verification failed");
  } });
  await serverOptions.onAction("inject", { adaptive: true });
  const restore = serverOptions.onAction("restore");
  const rejected = assert.rejects(restore, /restore verification failed/);
  await restoration.entered;
  const inject = serverOptions.onAction("inject", { adaptive: false });
  await Promise.resolve();
  assert.equal(instances.length, 1);
  restoration.release();
  await rejected;
  assert.equal((await inject).ok, true);
  assert.equal(instances.length, 1);
  assert.ok(events.indexOf("close:1:end") < events.lastIndexOf("start:1:begin"));
});

test("CLI shutdown seals the queue and waits for startup before closing its only injector", async () => {
  const startup = gate();
  const { serverOptions, instances, events, signals, exits, exit } = await cliHarness({ onStart: () => startup.wait() });
  const first = serverOptions.onAction("inject", { adaptive: true });
  await startup.entered;
  const second = serverOptions.onAction("inject", { adaptive: false });
  signals.get("SIGTERM")();
  const rejected = assert.rejects(second, /正在停止/);
  await assert.rejects(serverOptions.onConfigChange(), /正在停止/);
  startup.release();
  await first;
  await rejected;
  await exit;
  assert.equal(instances.length, 1);
  assert.deepEqual(exits, [0]);
  assert.ok(events.indexOf("start:1:end") < events.indexOf("close:1:begin"));
  assert.ok(events.indexOf("close:1:end") < events.indexOf("server:closed"));
});

test("CLI configChange, rescan, play and pause propagate renderer update failures", async () => {
  const { serverOptions } = await cliHarness({ updateResult: { sessions: 1, failed: 1, timings: [] } });
  await serverOptions.onAction("inject", { adaptive: false });
  await assert.rejects(serverOptions.onConfigChange(), /未能完成注入验证/);
  for (const action of ["rescan", "play", "pause"]) {
    await assert.rejects(serverOptions.onAction(action), /未能完成注入验证/);
  }
});

test("CLI configChange treats hidden GPU deferral without failures as saved instead of save error", async () => {
  const { serverOptions } = await cliHarness({ updateResult: { sessions: 0, failed: 0, deferred: 1, timings: [] } });
  await serverOptions.onAction("inject", { adaptive: false });
  const result = await serverOptions.onConfigChange();
  assert.equal(result.ok, true);
  assert.equal(result.status, "deferred:1");
  assert.equal(result.deferred, 1);
});

test("CLI inject accepts an existing hidden Codex window whose first attach is deferred", async () => {
  const { serverOptions } = await cliHarness({ startResult: { sessions: 0, failed: 0, deferred: 1, timings: [] } });
  const result = await serverOptions.onAction("inject", { adaptive: true });
  assert.equal(result.ok, true);
  assert.equal(result.deferredTargets, 1);
  assert.match(result.message, /隐藏页面等待显示后自动应用/);
});

test("CLI shutdown waits for its owned native provider and closes it only once", async () => {
  const cleanup = gate();
  let closes = 0;
  const { events, signals, exits, exit } = await cliHarness({
    nativeProvider: { async close() { closes += 1; await cleanup.wait(); } },
  });
  signals.get("SIGTERM")();
  await cleanup.entered;
  assert.ok(events.includes("server:closed"));
  assert.equal(exits.length, 0);
  signals.get("SIGTERM")();
  cleanup.release();
  await exit;
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
});

test("CLI shutdown reports cleanup failures with a failing exit code and still closes remaining resources", async () => {
  for (const target of ["injector", "server", "provider"]) {
    const fail = async () => { throw new Error(`${target} cleanup failed`); };
    const { serverOptions, events, signals, exit, exits, errors } = await cliHarness({
      ...(target === "injector" ? { onClose: fail } : target === "server" ? { onServerClose: fail } : { nativeProvider: { close: fail } }),
    });
    await serverOptions.onAction("inject", { adaptive: false });
    signals.get("SIGTERM")();
    await exit;
    assert.deepEqual(exits, [1]);
    assert.ok(events.includes("close:1:end"));
    assert.ok(events.includes("server:closed"));
    assert.ok(errors.some((message) => message.includes(`${target} cleanup failed`)));
  }
});
