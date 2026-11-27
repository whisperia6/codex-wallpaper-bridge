import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { WebSocketServer } from "ws";
import { invokeBridgeAction } from "../src/bridge-runner.mjs";
import { createMediaServer } from "../bridge-runtime/src/media-server.mjs";
import { NativeEngineDelivery } from "../bridge-runtime/src/native-engine-delivery.mjs";
import { CdpWallpaperInjector, restoreCdpWallpaper } from "../bridge-overrides/src/cdp-injector.mjs";
import { buildInjectionPlan } from "../bridge-overrides/src/injection-plan.mjs";
import { eligibleProjects } from "../bridge-runtime/src/library-policy.mjs";
import {
  buildCompatibilityRestoreScript,
  buildCompatibilityScript,
} from "../src/compatibility-script.mjs";
import { defaultCdpPort, hostDisplayName, hostPortConflict, normalizeHostType } from "../bridge-runtime/src/host-profiles.mjs";
import { validateCdpPort } from "../src/installations.mjs";
import { validateWebWallpaperInput } from "../bridge-runtime/src/web-wallpaper-input.mjs";

const compatibilityRestoreScript = buildCompatibilityRestoreScript();

function plan(adaptive = true) {
  return {
    bootstrapScript: "bootstrap-script",
    applyScript: "apply-script",
    compatibilityScript: buildCompatibilityScript({ adaptive }),
    compatibilityRestoreScript,
  };
}

const verifiedEndpoint = async () => ({ verified: true });
const recoveryTarget = (id, port = 9335) => ({
  id, type: "page", url: `app://${id}`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
});

function harness(context, { onSocket, injectorOptions, initialTarget } = {}) {
  const sockets = new Map();
  const statuses = [];
  const failUrls = new Set();
  const failConnectUrls = new Set();
  let targets = [initialTarget ?? { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" }];
  const injector = new CdpWallpaperInjector({
    ...injectorOptions,
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
  const checks = [];
  const main = recoveryTarget("main").webSocketDebuggerUrl;
  const { injector, sockets, statuses } = harness(context, { initialTarget: recoveryTarget("main"), injectorOptions: {
    verifyEndpoint: async (port, purpose) => { checks.push({ port, purpose }); return { verified: true }; },
  } });
  await injector.start(plan(false));
  const original = sockets.get(main);
  original.close();
  assert.equal(injector.sessions.size, 0);
  await injector.restore();
  const recovery = sockets.get(main);
  assert.deepEqual(checks, [{ port: 9335, purpose: "restore" }, { port: 9335, purpose: "restore" }]);
  assert.notEqual(recovery, original);
  assert.equal(evaluationCount(recovery, "bootstrap-script"), 0);
  assert.equal(evaluationCount(recovery, "apply-script"), 0);
  assert.equal(evaluationCount(recovery, plan(false).compatibilityScript), 0);
  assert.equal(evaluationCount(recovery, compatibilityRestoreScript), 1);
  assert.ok(recovery.calls.some(({ method, params }) => method === "Page.removeScriptToEvaluateOnNewDocument" && params.identifier === `hook:${main}`));
  assert.equal(recovery.calls.some(({ method, params }) => method === "Page.setBypassCSP" && params.enabled === true), false);
  assert.ok(statuses.some(({ type }) => type === "restored"));
});

test("restore checks the owner again before connecting to an enumerated replacement renderer", async (context) => {
  let verified = true;
  const { injector, sockets, setTargets } = harness(context, { injectorOptions: {
    verifyEndpoint: async () => ({ verified }),
  } });
  await injector.start(plan());
  sockets.get("mock:main").close();
  setTargets([{ id: "replacement", url: "app://main", webSocketDebuggerUrl: "mock:replacement" }]);
  const list = injector.listTargets;
  injector.listTargets = async () => { verified = false; return list(); };
  await assert.rejects(injector.restore(), /未通过身份核验/);
  assert.equal(sockets.has("mock:replacement"), false);
  assert.equal(injector.disconnectedSessions.size, 0);
});

test("restore uses a still-connected renderer without opening a new socket", async (context) => {
  let checks = 0;
  const { injector, sockets } = harness(context, { injectorOptions: {
    verifyEndpoint: async () => { checks++; return { verified: false }; },
  } });
  await injector.start(plan());
  const original = sockets.get("mock:main");
  await injector.close({ restore: true });
  assert.equal(checks, 0);
  assert.equal(sockets.get("mock:main"), original);
  assert.equal(evaluationCount(original, compatibilityRestoreScript), 1);
  assert.equal(original.closed, true);
});

test("verified recovery rejects debugger URLs outside the checked loopback endpoint", async (context) => {
  const checks = [];
  const { injector, sockets, setTargets } = harness(context, { injectorOptions: {
    verifyEndpoint: async (port, purpose) => { checks.push({ port, purpose }); return { verified: true }; },
  } });
  await injector.start(plan());
  const invalid = [
    "ws://127.0.0.1:9444/devtools/page/wrong-port",
    "ws://127.0.0.2:9335/devtools/page/wrong-address",
    "wss://127.0.0.1:9335/devtools/page/wrong-protocol",
    "ws://user:password@127.0.0.1:9335/devtools/page/credentials",
    "ws://127.0.0.1:9335/devtools/page/fragment#",
  ];
  setTargets([{ ...recoveryTarget("main"), webSocketDebuggerUrl: "mock:main" },
    ...invalid.map((webSocketDebuggerUrl, index) => ({ ...recoveryTarget(`invalid-${index}`), webSocketDebuggerUrl }))]);
  await assert.rejects(injector.close({ restore: true }), /outside the verified endpoint/);
  assert.deepEqual(checks, invalid.map(() => ({ port: 9335, purpose: "restore" })));
  assert.deepEqual([...sockets.keys()], ["mock:main"]);
  assert.equal(evaluationCount(sockets.get("mock:main"), compatibilityRestoreScript), 1);
  assert.equal(sockets.get("mock:main").closed, true);
});

test("implicit close without a verifier cleans up only established sessions and their leases", async (context) => {
  const { injector, sockets, setTargets } = harness(context);
  const gone = recoveryTarget("gone");
  setTargets([{ ...recoveryTarget("main"), webSocketDebuggerUrl: "mock:main" }, gone]);
  await injector.start(plan());
  const original = sockets.get(gone.webSocketDebuggerUrl);
  original.close();
  const active = sockets.get("mock:main");
  let releases = 0;
  injector.sessions.get("main").nativeLease = { release: async () => { releases++; } };
  setTargets([gone, recoveryTarget("replacement")]);
  await injector.close({ restore: true });
  assert.equal(sockets.get(gone.webSocketDebuggerUrl), original);
  assert.equal(sockets.has(recoveryTarget("replacement").webSocketDebuggerUrl), false);
  assert.equal(evaluationCount(active, compatibilityRestoreScript), 1);
  assert.equal(releases, 1);
  assert.equal(active.closed, true);
  assert.equal(injector.sessions.size, 0);
});

test("explicit standalone restore can open a matching loopback debugger URL without a verifier", async (context) => {
  const server = createServer((_req, res) => {
    res.end(JSON.stringify([recoveryTarget("standalone", server.address().port)]));
  });
  const sockets = new WebSocketServer({ server });
  const evaluated = [];
  sockets.on("connection", (socket) => socket.on("message", (message) => {
    const { id, method, params } = JSON.parse(message);
    if (method === "Runtime.evaluate") evaluated.push(params.expression);
    socket.send(JSON.stringify({ id, result: { result: { value: { ok: true } } } }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await Promise.all([new Promise(resolve => sockets.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  await restoreCdpWallpaper({ port: server.address().port, compatibilityRestoreScript });
  assert.ok(evaluated.includes(compatibilityRestoreScript));
});

test("restore rejects no current targets instead of accepting an empty session set", async (context) => {
  const { injector, sockets, statuses, setTargets } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan());
  sockets.get("mock:main").close();
  setTargets([]);
  await assert.rejects(injector.restore(), /没有找到可完整恢复/);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test("restore confirms target coverage and fails if one live target cannot reconnect", async (context) => {
  const { injector, sockets, statuses, failConnectUrls, setTargets } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan());
  failConnectUrls.add(recoveryTarget("failed").webSocketDebuggerUrl);
  setTargets([
    { id: "main", url: "app://main", webSocketDebuggerUrl: "mock:main" },
    recoveryTarget("failed"),
  ]);
  await assert.rejects(injector.restore(), /target connection failed/);
  assert.equal(evaluationCount(sockets.get("mock:main"), compatibilityRestoreScript), 1);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test('Restore reconciles a proven-closed HTTP500 target and covers newly created pages without reinstalling', async context => {
  const { injector, sockets, statuses, setTargets } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan());
  const main = { id: 'main', url: 'app://main', webSocketDebuggerUrl: 'mock:main' };
  const next = recoveryTarget('next');
  setTargets([main, recoveryTarget('gone')]);
  const factory = injector.socketFactory;
  injector.socketFactory = url => url !== recoveryTarget('gone').webSocketDebuggerUrl ? factory(url) : {
    async connect() { setTargets([main, next]); throw Object.assign(Error('Unexpected server response: 500'), { cwbHandshakeStatus: 500 }); }, close() {},
  };
  await injector.restore();
  assert.equal(evaluationCount(sockets.get(next.webSocketDebuggerUrl), 'bootstrap-script'), 0);
  assert.equal(evaluationCount(sockets.get(next.webSocketDebuggerUrl), 'apply-script'), 0);
  assert.equal(evaluationCount(sockets.get(next.webSocketDebuggerUrl), compatibilityRestoreScript), 1);
  assert.ok(statuses.some(s => s.type === 'restoration-target-gone'));
  assert.ok(statuses.some(s => s.type === 'restored'));
});

test('Restore retains hook metadata and fails for a navigated but still-live target outside the renderer cohort', async context => {
  const { injector, sockets } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan()); sockets.get('mock:main').close();
  const next = recoveryTarget('next');
  const navigated = { id: 'main', url: 'https://example.invalid/', webSocketDebuggerUrl: 'mock:main' };
  injector.listTargets = async ({ includeAll = false } = {}) => includeAll ? [next, navigated] : [next];
  await assert.rejects(injector.restore(), /live target outside renderer cohort/);
  assert.equal(injector.disconnectedSessions.get('main')?.newDocumentId, 'hook:mock:main');
});

test('Restore rejects a still-listed HTTP500 instead of claiming the unresponsive target was closed', async context => {
  const { injector, statuses, setTargets } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan());
  setTargets([{ id: 'main', url: 'app://main', webSocketDebuggerUrl: 'mock:main' },
    recoveryTarget('hung')]);
  const factory = injector.socketFactory;
  injector.socketFactory = url => url !== recoveryTarget('hung').webSocketDebuggerUrl ? factory(url) : {
    async connect() { throw Object.assign(Error('Unexpected server response: 500'), { cwbHandshakeStatus: 500 }); }, close() {},
  };
  await assert.rejects(injector.restore(), /Unexpected server response: 500/);
  assert.equal(statuses.some(s => s.type === 'restored'), false);
});

test("restore rejects a failed target enumeration even if stale sessions still exist", async (context) => {
  const { injector, statuses } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan());
  injector.listTargets = async () => { throw new Error("CDP endpoint unreachable"); };
  await assert.rejects(injector.restore(), /CDP endpoint unreachable/);
  assert.equal(statuses.some(({ type }) => type === "restored"), false);
});

test("a failed close retains disconnected hook metadata for a later restore-only retry", async (context) => {
  const main = recoveryTarget("main").webSocketDebuggerUrl;
  const { injector, sockets } = harness(context, {
    initialTarget: recoveryTarget("main"), injectorOptions: { verifyEndpoint: verifiedEndpoint },
  });
  await injector.start(plan());
  const original = sockets.get(main);
  const originalCall = original.call;
  original.call = async (method, params) => {
    if (method === "Page.removeScriptToEvaluateOnNewDocument") throw new Error("hook cleanup failed");
    return originalCall(method, params);
  };
  const originalClose = original.close;
  original.close = () => queueMicrotask(originalClose);
  await assert.rejects(injector.close({ restore: true }), /hook cleanup failed/);
  assert.equal(injector.disconnectedSessions.get("main").newDocumentId, `hook:${main}`);
  await injector.restore();
  const recovery = sockets.get(main);
  assert.ok(recovery.calls.some(({ method, params }) => method === "Page.removeScriptToEvaluateOnNewDocument" && params.identifier === `hook:${main}`));
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

async function cliHarness({ startResult = { sessions: 1, failed: 0, timings: [] }, updateResult = { sessions: 1, failed: 0, timings: [] }, onStart, onUpdate, onClose, onServerClose, onMediaConfigure, nativeProvider = null, createInjector, sceneRenderer, onRetryNative } = {}) {
  const injections = [];
  const runtimeWrites = [];
  const fanout = [];
  let mediaOptions;
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
      argv: ["node", "cli", "preview", "--no-open"], platform: "linux", env: { CWB_SCENE_RENDERER: sceneRenderer },
      on(signal, handler) { signals.set(signal, handler); if (signal === "SIGTERM") registered(); },
      exit(code) { exits.push(code); exited(); },
    },
    console: { log() {}, error(message) { errors.push(message); } },
    performance,
    mkdir: async () => {}, rm: async () => {}, writeFile: async (_path, json) => { runtimeWrites.push(JSON.parse(json)); },
    buildCompatibilityScript, buildCompatibilityRestoreScript,
    defaultCdpPort, hostDisplayName, hostPortConflict, normalizeHostType, validateCdpPort, validateWebWallpaperInput,
    openNativeEngineProvider: () => nativeProvider, NativeEngineDelivery,
    LyricsStore: class {},
    MediaMiddleware: class { constructor(options) { mediaOptions = options; } async configure() { await onMediaConfigure?.(); } async snapshot() { return { power: { onBattery: false } }; } async close() {} },
    createConfigStore: () => ({ filePath: path.join(os.tmpdir(), 'cwb-fixture', 'config.json'), load: async () => {}, get: () => ({ selectedId: "video" }), set: async () => {} }),
    scanWallpaperProjects: async () => ({ projects: [{ id: "video" }], warnings: [] }),
    buildCurrentInjection: async (_server, _config, { hostType }) => ({ bootstrapScript: "bootstrap-script", applyScript: "apply-script", metrics: {}, hostType }),
    CdpWallpaperInjector: class {
      constructor(options = {}) {
        if (createInjector) return createInjector(options);
        this.running = false; this.hostType = options.hostType; this.port = options.port;
        this.id = instances.length + 1; instances.push(this); events.push(`create:${this.id}`);
        this.nativeDelivery = options.sharedNativeDelivery;
        if (options.sceneProvider) {
          this.nativeDelivery = { diagnostics: () => [] };
          this.sceneDelivery = {
            input: async (id, input) => { fanout.push(["input", this.hostType, id, input.op]); return { delivered: 1 }; },
            properties: async (id, values) => { fanout.push(["properties", this.hostType, id, values]); return { phase: "ready", values }; },
            diagnostics: () => [{ id: this.id }],
          };
        }
      }
      async start(injection) {
        this.running = true;
        events.push(`start:${this.id}:begin`);
        injections.push(injection);
        await onStart?.(this, injection);
        events.push(`start:${this.id}:end`);
        return startResult;
      }
      async update(injection, options) {
        events.push(`update:${this.id}:begin`);
        injections.push(injection);
        const result = await onUpdate?.(this, injection, options);
        events.push(`update:${this.id}:end`);
        return result ?? updateResult;
      }
      async updatePower(power) { fanout.push(["power", this.hostType, power.onBattery]); }
      async preloadScene(id) {
        fanout.push(["preload", this.hostType, id]);
        return { ok: true, status: id ? "preparing" : "skipped", targets: id ? 1 : 0 };
      }
      async retryScene(id) { fanout.push(["retry", this.hostType, id]); return { cleared: true }; }
      async retryNative(id, options) { return onRetryNative?.(this.hostType, id, options); }
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
        projects: async () => [{ id: "video", type: "web" }],
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
  return { serverOptions, injections, closings, instances, events, signals, exits, exit, errors, runtimeWrites, fanout, mediaOptions };
}

test("CLI routes concurrent hosts independently, fans out updates and restores each port", async () => {
  const checks = [];
  let offline = false;
  const fixture = await cliHarness({
    nativeProvider: { verifyEndpoint: async (port, hostType) => { checks.push([port, hostType]); return { verified: true }; }, async close() {} },
    onUpdate: (injector) => { if (offline && injector.hostType === "codex") throw Error("Codex disconnected"); },
  });
  const { serverOptions: api, instances, injections, closings, signals, exit, exits, runtimeWrites, fanout, mediaOptions } = fixture;
  const codex = { hostType: "codex", port: 9335 };
  const ag = { hostType: "antigravity", port: 9336 };
  await Promise.all([api.onAction("inject", { ...codex, adaptive: false }), api.onAction("inject", { ...ag, adaptive: true })]);
  assert.deepEqual(instances.map(({ hostType, port }) => ({ hostType, port })), [codex, ag]);
  assert.deepEqual(checks, [[9335, "codex"], [9336, "antigravity"]]);
  for (const action of ["inject", "restore"]) {
    await assert.rejects(api.onAction(action, { ...ag, port: 9335 }), /9335.*Codex.*不同的端口/);
  }
  await assert.rejects(api.onAction("inject", { port: 65536 }), /1024 到 65535/);
  assert.equal(closings.length, 0);
  assert.equal(checks.length, 2);
  await api.onConfigChange();
  assert.deepEqual(injections.map(({ hostType }) => hostType), ["codex", "antigravity", "codex", "antigravity"]);
  assert.equal(injections[2].compatibilityScript, buildCompatibilityScript({ adaptive: false, hostType: "codex" }));
  assert.equal(injections[3].compatibilityScript, buildCompatibilityScript({ adaptive: true, hostType: "antigravity" }));
  offline = true;
  assert.equal((await api.onConfigChange()).status, "updated:1");
  assert.equal(injections.at(-1).hostType, "antigravity");
  offline = false;
  for (const action of ["rescan", "pause", "play"]) {
    const before = injections.length;
    await api.onAction(action);
    assert.deepEqual(injections.slice(before).map(({ hostType }) => hostType), ["codex", "antigravity"]);
  }
  assert.equal((await api.onScenePreload("video")).targets, 2);
  await mediaOptions.onPower({ onBattery: true });
  await api.onAuthorProperties({ operation: "apply", project: { id: "video", type: "web" }, values: { enabled: true } });
  const input = { op: "mediaStatus", value: { enabled: true } };
  assert.equal((await mediaOptions.dispatch("video", input)).delivered, 2);
  assert.equal((await api.onAction("web-input", { projectId: "video", input })).delivered, 2);
  await api.onAction("retry-engine", { projectId: "video" });
  for (const operation of ["preload", "power", "properties", "input", "retry"]) {
    assert.deepEqual([...new Set(fanout.filter(([type]) => type === operation).map(([, host]) => host))], ["codex", "antigravity"]);
  }
  const status = await api.onAction("engine-status");
  assert.deepEqual(Array.from(status.engine, ({ port }) => port), [9335, 9336]);
  assert.equal((await api.onAction("restore", codex)).injectorActive, true);
  assert.equal(runtimeWrites.at(-1).injectorActive, true);
  assert.equal(instances[0].running, false);
  assert.equal(instances[1].running, true);
  assert.equal((await api.onAction("restore", ag)).injectorActive, false);
  await api.onAction("inject", ag);
  await api.onAction("inject", codex);
  const moved = { ...ag, port: 9446 };
  await api.onAction("inject", moved);
  assert.equal(instances[2].running, false);
  assert.equal(instances[3].running, true);
  assert.equal(instances[4].port, 9446);
  signals.get("SIGTERM")();
  await exit;
  assert.deepEqual(exits, [0]);
  assert.ok(instances.every(({ running }) => !running));
  assert.equal(closings.length, 5);
  assert.ok(closings.every(({ restore }) => restore));
});

test("HTTP inject with an explicit host and omitted port uses that host's registered port or default", async (context) => {
  const fixture = await cliHarness();
  const server = createMediaServer({ onAction: fixture.serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const inject = (options) => invokeBridgeAction({ controlUrl: server.baseUrl, action: "inject", ...options });
  const codex = { hostType: "codex", port: 9335 };
  const ag = { hostType: "antigravity", port: 9336 };
  assert.deepEqual((await inject()).activeHosts, [codex]);
  assert.deepEqual((await inject({ hostType: ag.hostType })).activeHosts, [codex, ag]);
  const moved = { ...ag, port: 9446 };
  await inject(moved);
  assert.deepEqual((await inject({ hostType: ag.hostType })).activeHosts, [codex, moved]);
  await inject({ ...codex, port: 9445 });
  assert.deepEqual((await inject()).activeHosts, [moved, codex]);
  assert.deepEqual(fixture.instances.map(({ port }) => port), [9335, 9336, 9446, 9445, 9335]);
});

test("HTTP restore without a host selects the sole active host or the host owning the requested port", async (context) => {
  const { serverOptions, instances } = await cliHarness();
  const server = createMediaServer({ onAction: serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const invoke = (action, options) => invokeBridgeAction({ controlUrl: server.baseUrl, action, ...options });
  const antigravity = { hostType: "antigravity", port: 9336 };

  await invoke("inject", antigravity);
  const restored = await invoke("restore");
  assert.equal(restored.status, "restored");
  assert.deepEqual(restored.activeHosts, []);
  assert.equal(instances[0].running, false);

  await invoke("inject");
  await invoke("inject", antigravity);
  const restoredByPort = await invoke("restore", { port: "9336" });
  assert.deepEqual(restoredByPort.activeHosts, [{ hostType: "codex", port: 9335 }]);
  assert.equal(instances[2].running, false);
});

test("HTTP restore without a host selects the only active host after another host fails to restore", async (context) => {
  const codex = { hostType: "codex", port: 9335 };
  const antigravity = { hostType: "antigravity", port: 9336 };
  const closeAttempts = [];
  const { serverOptions } = await cliHarness({
    onClose({ hostType }) {
      closeAttempts.push(hostType);
      if (closeAttempts.length === 1 && hostType === codex.hostType) {
        throw new Error("restore verification failed");
      }
    },
  });
  const server = createMediaServer({ onAction: serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const invoke = (action, options) => invokeBridgeAction({ controlUrl: server.baseUrl, action, ...options });

  await invoke("inject", codex);
  await invoke("inject", antigravity);
  await assert.rejects(invoke("restore", codex), /restore verification failed/);
  assert.deepEqual((await invoke("injection-status")).registeredHosts, [codex, antigravity]);
  assert.deepEqual((await invoke("engine-status")).activeHosts, [antigravity]);

  const restored = await invoke("restore");
  assert.equal(restored.status, "restored");
  assert.deepEqual(restored.activeHosts, []);
  assert.deepEqual(closeAttempts, [codex.hostType, antigravity.hostType]);
  assert.deepEqual((await invoke("injection-status")).registeredHosts, [codex]);
});

test("HTTP restore with an explicit host and omitted port cleans up its default port when unregistered", async (context) => {
  const { serverOptions, closings, instances } = await cliHarness();
  const server = createMediaServer({ onAction: serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const invoke = (action, options) => invokeBridgeAction({ controlUrl: server.baseUrl, action, ...options });

  await invoke("inject");
  const restored = await invoke("restore", { hostType: "antigravity" });
  assert.equal(restored.status, "restored");
  assert.deepEqual(restored.activeHosts, [{ hostType: "codex", port: 9335 }]);
  assert.equal(instances[0].running, true);
  assert.equal(closings.length, 1);
  assert.equal(closings[0].hostType, "antigravity");
  assert.equal(closings[0].port, 9336);
});

test("HTTP VP8 retry reports the failed host even when another host retries successfully", async (context) => {
  let mode = "mixed";
  const attempts = [];
  const fixture = await cliHarness({
    sceneRenderer: "vp8",
    nativeProvider: { create() { throw Error("fixture has no native scene"); } },
    onRetryNative(hostType, id, { retrySource }) {
      attempts.push({ hostType, id, retrySource });
      if (mode === "mixed" && hostType === "codex") throw Error("CDP retry failed");
      return { cleared: mode === "mixed" };
    },
  });
  const server = createMediaServer({ onAction: fixture.serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const action = (action, options) => invokeBridgeAction({ controlUrl: server.baseUrl, action, ...options });
  await action("inject");
  await action("inject", { hostType: "antigravity" });
  await assert.rejects(action("retry-engine"), /Codex.*CDP retry failed/);
  assert.deepEqual(attempts, ["codex", "antigravity"].map((hostType) => ({ hostType, id: "video", retrySource: false })));
  assert.deepEqual(fixture.injections.map(({ hostType }) => hostType), ["codex", "antigravity", "antigravity"]);
  mode = "skip";
  assert.match((await action("retry-engine")).message, /无需重试/);
  assert.equal(fixture.injections.length, 3);
});

test("HTTP GPU retry reports a host whose renderer falls back again even though its update reports success", async (context) => {
  let stillDegraded = true;
  const fixture = await cliHarness({
    sceneRenderer: "gpu",
    nativeProvider: {},
    onUpdate({ hostType }) {
      return { sessions: 1, failed: 0, timings: [{ degraded: stillDegraded && hostType === "antigravity" }] };
    },
  });
  const server = createMediaServer({ onAction: fixture.serverOptions.onAction });
  await server.start();
  context.after(() => server.close());
  const action = (action, options) => invokeBridgeAction({ controlUrl: server.baseUrl, action, ...options });
  await action("inject");
  await action("inject", { hostType: "antigravity" });
  await assert.rejects(action("retry-engine"), /场景重试失败.*Antigravity.*降级背景/);
  assert.deepEqual(fixture.fanout.filter(([action]) => action === "retry"), [
    ["retry", "codex", "video"],
    ["retry", "antigravity", "video"],
  ]);
  stillDegraded = false;
  assert.equal((await action("retry-engine")).status, "engine-retried");
});

for (const cleanup of ["port switch", "shutdown"]) {
  test(`CLI ${cleanup} retires a reassigned endpoint without contacting its new owner`, async (context) => {
    const checks = [], created = [];
    let changedOwner = false;
    const { serverOptions, signals, exit, exits, runtimeWrites } = await cliHarness({
      nativeProvider: {
        create() { throw Error("fixture has no native wallpaper"); },
        async verifyEndpoint(port, hostType, purpose) {
          checks.push({ port, hostType, purpose });
          if (port === 9335 && changedOwner) throw Error("owner_changed");
          return { verified: true };
        },
        async close() {},
      },
      createInjector({ port, hostType, nativeProvider }) {
        const fixture = harness(context, { injectorOptions: { port, hostType, nativeProvider } });
        created.push(fixture);
        return fixture.injector;
      },
    });
    await serverOptions.onAction("inject", { port: 9335 });
    const { injector, sockets, statuses, setTargets } = created[0];
    const oldSocket = sockets.get("mock:main");
    const leaseReleases = [];
    injector.sessions.get("main").nativeLease = { release: async () => leaseReleases.push("released") };
    oldSocket.close();
    changedOwner = true;
    setTargets([{ id: "replacement", url: "app://main", webSocketDebuggerUrl: "mock:replacement" }]);
    let targetReads = 0;
    const listTargets = injector.listTargets;
    injector.listTargets = async () => { targetReads++; return listTargets(); };
    if (cleanup === "port switch") {
      await serverOptions.onAction("inject", { port: 9445 });
      assert.deepEqual(runtimeWrites.at(-1).activeHosts, [{ hostType: "codex", port: 9445 }]);
    }
    signals.get("SIGTERM")();
    await exit;
    assert.deepEqual(exits, [0]);
    assert.ok(checks.some(({ port, hostType, purpose }) => port === 9335 && hostType === "codex" && purpose === "restore"));
    assert.equal(targetReads, 0);
    assert.equal(sockets.has("mock:replacement"), false);
    assert.equal(evaluationCount(oldSocket, compatibilityRestoreScript), 0);
    assert.deepEqual(leaseReleases, ["released"]);
    assert.equal(injector.disconnectedSessions.size, 0);
    assert.ok(statuses.some(({ type }) => type === "restoration-owner-unverified"));
  });
}

test("CLI config ignores a detached or deferred host as evidence of application and rescan saves on failure", async () => {
  let codexDeferred = 0, failAntigravity = true;
  const { serverOptions, runtimeWrites, injections } = await cliHarness({
    onUpdate: ({ hostType }) => hostType === "codex"
      ? { sessions: 0, failed: 0, deferred: codexDeferred }
      : { sessions: failAntigravity ? 0 : 1, failed: Number(failAntigravity) },
  });
  await serverOptions.onAction("inject", { hostType: "codex", port: 9335 });
  await serverOptions.onAction("inject", { hostType: "antigravity", port: 9336 });
  await assert.rejects(serverOptions.onConfigChange(), /Antigravity.*未能完成注入验证/);
  codexDeferred = 1;
  await assert.rejects(serverOptions.onConfigChange(), /Antigravity.*未能完成注入验证/);
  codexDeferred = 0;
  const beforeFailure = runtimeWrites.length;
  await assert.rejects(serverOptions.onAction("rescan"), /Antigravity.*未能完成注入验证/);
  assert.equal(runtimeWrites.length, beforeFailure + 1);
  for (const action of ["pause", "play"]) {
    await assert.rejects(serverOptions.onAction(action), /Antigravity.*未能完成注入验证/);
  }
  failAntigravity = false;
  for (const [action, status] of [["pause", "pause"], ["play", "play"], ["rescan", "rescanned"]]) {
    const before = injections.length;
    assert.equal((await serverOptions.onAction(action)).status, status);
    assert.deepEqual(injections.slice(before).map(({ hostType }) => hostType), ["codex", "antigravity"]);
  }
  assert.equal(runtimeWrites.length, beforeFailure + 2);
  assert.equal((await serverOptions.onConfigChange()).status, "updated:1");
});

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

test("re-inject with scan attaches a restarted Codex after the previous session closed", async (context) => {
  const { injector, sockets, setTargets } = harness(context);
  await injector.start(plan(true));
  sockets.get("mock:main").close();
  assert.equal(injector.sessions.size, 0);
  setTargets([{ id: "restarted", url: "app://restarted", webSocketDebuggerUrl: "mock:restarted" }]);
  const result = await injector.update(plan(false), { scan: true });
  assert.equal(result.failed, 0);
  assert.equal(result.sessions, 1);
  assert.equal(result.timings.length, 1);
  assert.equal(injector.sessions.has("restarted"), true);
  assert.equal(evaluationCount(sockets.get("mock:restarted"), plan(false).compatibilityScript), 1);
});

test("re-inject with scan waits for an in-flight background attach instead of failing on empty sessions", async (context) => {
  const attaching = gate();
  const { injector, sockets, setTargets } = harness(context, {
    onSocket(socket, url) {
      if (url !== "mock:restarted") return;
      const originalCall = socket.call;
      socket.call = async (method, params = {}) => {
        if (method === "Runtime.evaluate" && params.expression === "bootstrap-script") await attaching.wait();
        return originalCall(method, params);
      };
    },
  });
  await injector.start(plan(true));
  sockets.get("mock:main").close();
  assert.equal(injector.sessions.size, 0);
  setTargets([{ id: "restarted", url: "app://restarted", webSocketDebuggerUrl: "mock:restarted" }]);
  const backgroundScan = injector.scanOnce();
  await attaching.entered;
  const reinject = injector.update(plan(false), { scan: true });
  await Promise.resolve();
  attaching.release();
  const [, result] = await Promise.all([backgroundScan, reinject]);
  assert.equal(result.failed, 0);
  assert.equal(result.sessions, 1);
  assert.equal(result.timings.length, 1);
  assert.equal(injector.sessions.has("restarted"), true);
  const restarted = sockets.get("mock:restarted");
  const compatCalls = restarted.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes("codex-wallpaper-electron-compat-style"));
  assert.equal(compatCalls.at(-1).params.expression, plan(false).compatibilityScript);
});

test("CLI inject passes scan:true on reinject and configChange stays saved when Codex is temporarily detached", async () => {
  const updateOptions = [];
  const { serverOptions } = await cliHarness({
    onUpdate: (_inst, _injection, options) => { updateOptions.push(options ? { scan: options.scan } : null); },
    updateResult: { sessions: 0, failed: 0, deferred: 0, timings: [] },
  });
  await serverOptions.onAction("inject", { adaptive: true });
  const saved = await serverOptions.onConfigChange();
  assert.equal(saved.ok, true);
  assert.equal(saved.status, "detached");
  assert.deepEqual(updateOptions, [null]);
  await assert.rejects(serverOptions.onAction("inject", { adaptive: true }), /未能完成注入验证/);
  assert.deepEqual(updateOptions, [null, { scan: true }]);
});

test("close with allowEndpointUnavailable succeeds when Codex already exited and waiting status is deduplicated", async (context) => {
  const { injector, sockets, statuses } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan(true));
  sockets.get("mock:main").close();
  assert.equal(injector.sessions.size, 0);
  injector.listTargets = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  await injector.scanOnce();
  await injector.scanOnce();
  assert.equal(statuses.filter((status) => status.type === "waiting").length, 1);
  await assert.rejects(injector.close({ restore: true }), /fetch failed/);
  await injector.close({ restore: true, allowEndpointUnavailable: true });
  assert.ok(statuses.some((status) => status.type === "restored" && status.endpointUnavailable === true));
});

test("close with allowEndpointUnavailable succeeds when Codex has 0 open renderer windows or exits before socket close", async (context) => {
  const { injector, setTargets, statuses } = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await injector.start(plan(true));
  assert.equal(injector.sessions.size, 1);
  // Codex closed its window while staying resident (returns empty target list)
  setTargets([]);
  await injector.close({ restore: true, allowEndpointUnavailable: true });
  assert.ok(statuses.some((status) => status.type === "restored" && status.endpointUnavailable === true));

  const second = harness(context, { injectorOptions: { verifyEndpoint: verifiedEndpoint } });
  await second.injector.start(plan(true));
  assert.equal(second.injector.sessions.size, 1);
  // Codex exited right before WebSocket close fired: sessions still has 1 entry when fetch fails
  second.injector.listTargets = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  await second.injector.close({ restore: true, allowEndpointUnavailable: true });
  assert.ok(second.statuses.some((status) => status.type === "restored" && status.endpointUnavailable === true));
});
