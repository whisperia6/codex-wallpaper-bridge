import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { buildRestoreScript } from "./injected-renderer.mjs";
import { NativeEngineDelivery } from "../../bridge-runtime/src/native-engine-delivery.mjs";
import { DirectSceneDelivery } from "../../bridge-runtime/src/direct-scene-delivery.mjs";
import { extractTargetOrigin, hostDisplayName, isValidTargetUrlForHost, normalizeHostType } from "../../bridge-runtime/src/host-profiles.mjs";

const SCRIPT_TIMEOUT_MS = 15_000;
// Owned media keeps its existing 15 s load gate. Leave room for that gate to
// report failure and dispose the candidate before the CDP request expires.
const MEDIA_APPLY_TIMEOUT_MS = 20_000;
const GPU_APPLY_TIMEOUT_MS = 105_000;
let nextTimingId = 0;
const STAGE_LABELS = {
  owner: "身份核验", connect: "CDP连接", visibility: "可见性探测", runtime: "Runtime安装",
  theme: "主题准备", reload: "文档刷新", resources: "场景资源", apply: "媒体应用/首帧等待",
  compatibility: "兼容样式",
};
function createInjectionTiming() {
  return { id: ++nextTimingId, startedAt: performance.now(), stages: {}, applyMs: 0, reloads: 0 };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPageLoad(socket, timeoutMs = 8_000) {
  if (typeof socket?.onEvent !== "function") return delay(250);
  return new Promise((resolve) => {
    let remove = () => {};
    const timer = setTimeout(() => {
      remove();
      resolve();
    }, timeoutMs);
    remove = socket.onEvent("Page.loadEventFired", () => {
      clearTimeout(timer);
      remove();
      resolve();
    });
  });
}

function normalizeInjection(value) {
  if (typeof value === "string") {
    return { bootstrapScript: "", applyScript: value, compatibilityScript: "", compatibilityRestoreScript: "" };
  }
  if (!value || typeof value !== "object") throw new TypeError("injection must be an object");
  const bootstrapScript = String(value.bootstrapScript || "");
  const applyScript = String(value.applyScript || value.script || "");
  const compatibilityScript = String(value.compatibilityScript || "");
  const compatibilityRestoreScript = String(value.compatibilityRestoreScript || "");
  const nativeWallpaperId = value.nativeWallpaperId ?? null;
  if (nativeWallpaperId !== null && (typeof nativeWallpaperId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(nativeWallpaperId))) throw new TypeError("Invalid native wallpaper identity");
  const directSceneId = value.directSceneId ?? null;
  if (directSceneId !== null && (value.directSceneEnabled !== true || typeof directSceneId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(directSceneId))) throw new TypeError("Invalid GPU Scene identity");
  const fallbackScripts = Array.isArray(value.fallbackScripts) ? value.fallbackScripts.filter(entry =>
    ['embedded_video', 'custom_static', 'preview', 'empty'].includes(entry?.reason) && typeof entry.script === 'string'
    && Buffer.byteLength(entry.script, 'utf8') <= 10000).slice(0, 4).map(entry => ({ reason: entry.reason, script: entry.script })) : [];
  return { bootstrapScript, applyScript, compatibilityScript, compatibilityRestoreScript, fallbackScripts,
    nativeEnabled: value.nativeEnabled === true, nativeWallpaperId,
    directSceneEnabled: value.directSceneEnabled === true, directSceneId,
    requiresMediaCsp: value.requiresMediaCsp === true || directSceneId !== null };
}

function runtimeValue(result) {
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer injection failed");
  }
  return result?.result?.value;
}

function appliedMediaReady(value) {
  return value?.ok === true && value.runtimeReady === true && value.domReady === true
    && value.switchResult?.ok !== false && !['loading', 'error', 'play-rejected'].includes(value.media?.state || value.mediaState);
}

function isTargetConnectionFailure(error) {
  return [404, 500].includes(error?.cwbHandshakeStatus)
    || ['CDP WebSocket connection timed out', 'CDP Page.enable timed out', 'CDP Runtime.enable timed out',
      'CDP socket closed', 'CDP socket is not connected'].includes(error?.message);
}

function isEndpointUnavailableError(error) {
  const code = error?.cause?.code || error?.code;
  if (["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return true;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  return error instanceof TypeError && /fetch failed/i.test(String(error.message || ""));
}

function injectionFailureDetail(error, targetIndex) {
  const message = typeof error?.message === "string" ? error.message : "";
  const cdpCode = Number.isInteger(error?.cdpCode) ? error.cdpCode : null;
  const categories = new Map([
    ["Renderer DOM application verification failed", "renderer-dom-not-ready"],
    ["Renderer runtime readiness verification failed", "renderer-runtime-not-ready"],
    ["Native renderer bootstrap failed", "native-bootstrap-failed"],
    ["Native renderer runtime is not ready", "native-runtime-not-ready"],
    ["Native receiver handle unavailable", "native-receiver-unavailable"],
    ["native_source_failed", "native-source-failed"],
    ["native_source_capacity", "native-source-capacity"],
    ["native_source_closing", "native-source-closing"],
    ["invalid_native_lease", "native-lease-invalid"],
    ["gpu_source_failed", "gpu-source-failed"],
    ["gpu_source_capacity", "gpu-source-capacity"],
    ["gpu_source_closing", "gpu-source-closing"],
    ["gpu_descriptor_rejected", "gpu-descriptor-rejected"],
    ["GPU Scene document initialization failed", "gpu-document-not-ready"],
    ["CDP socket closed", "cdp-socket-closed"],
    ["CDP socket is not connected", "cdp-socket-closed"],
  ]);
  let category = categories.get(message) || "unknown";
  if (cdpCode !== null) {
    category = cdpCode === -32000 && ["Cannot find object with given id", "Cannot find context with specified id"].includes(message)
      ? "receiver-disposed" : "cdp-command-error";
  } else if (/^CDP (?:Runtime\.(?:evaluate|callFunctionOn|releaseObject)|Page\.(?:enable|reload|addScriptToEvaluateOnNewDocument|setBypassCSP)) timed out$/.test(message)) {
    category = "cdp-timeout";
  }
  const switchFailures = new Map([
    ["Media load timed out", "media-load-timeout"],
    ["Media failed to load or decode", "media-load-or-decode"],
    ["Media commit failed", "media-commit"],
    ["native_source_failed", "native-source-failed"],
    ["native_source_capacity", "native-source-capacity"],
    ["native_source_closing", "native-source-closing"],
  ]);
  return { targetIndex, category, cdpCode,
    mediaState: ["idle", "loading", "ready", "error"].includes(error?.cwbMediaState) ? error.cwbMediaState : "unknown",
    switchFailure: switchFailures.get(error?.cwbSwitchFailure) || "unknown" };
}

class CdpSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = 5_000) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs });
    this.ws = ws;
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      const fail = error => { clearTimeout(timer); reject(error); ws.terminate(); };
      const timer = setTimeout(() => fail(new Error("CDP WebSocket connection timed out")), timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (error) => { clearTimeout(timer); reject(error); });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        fail(Object.assign(new Error(`Unexpected server response: ${response.statusCode}`), { cwbHandshakeStatus: response.statusCode }));
      });
    });
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message.id) {
        for (const handler of this.eventHandlers.get(message.method) || []) {
          try { handler(message.params || {}); } catch {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "CDP command failed"),
        Number.isInteger(message.error.code) ? { cdpCode: message.error.code } : {}));
      else pending.resolve(message.result ?? {});
    });
    ws.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  onEvent(method, handler) {
    const handlers = this.eventHandlers.get(method) || new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.eventHandlers.delete(method);
    };
  }

  call(method, params = {}, timeoutMs = 8_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not connected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

function isHostRenderer(target, hostType = "codex") {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  return isValidTargetUrlForHost(target.url, hostType);
}

export class CdpWallpaperInjector {
  constructor({
    host = "127.0.0.1",
    port = 9335,
    hostType = "codex",
    pollIntervalMs = 1_500,
    onStatus = () => {},
    installOnNewDocument = true,
    socketFactory = (url) => new CdpSocket(url),
    nativeProvider = null,
    sceneProvider = null,
    verifyEndpoint = nativeProvider ? (port) => nativeProvider.verifyEndpoint(port) : null
  } = {}) {
    this.host = host;
    this.port = Number(port);
    this.hostType = normalizeHostType(hostType, { strict: true });
    this.pollIntervalMs = pollIntervalMs;
    this.onStatus = onStatus;
    this.installOnNewDocument = installOnNewDocument;
    this.socketFactory = socketFactory;
    this.nativeDelivery = nativeProvider ? new NativeEngineDelivery({ provider: nativeProvider,
      onFailure: (failure) => this.status('native-frame-error', { message: JSON.stringify(failure) }),
      onReceiverLost: (session) => {
        if (!this.running || this.restoring) return;
        session.runtimeInstalled = false;
        this.status('native-receiver-retired', { message: 'Private renderer context was disposed' });
        void this.releaseSessionNative(session).then(() => this.rehydrateSession(session)).catch(() => {
          this.status('native-cleanup-error', { message: 'Native receiver cleanup incomplete' });
        });
      } }) : null;
    this.verifyEndpoint = verifyEndpoint;
    this.sceneDelivery = sceneProvider ? new DirectSceneDelivery({ ...sceneProvider,
      onPreloadReady: (elapsedMs) => this.status('scene-preload-ready', { message: `候选首帧已预加载：${elapsedMs} ms` }),
      onReceiverLost: (session) => {
      if (!this.running || this.restoring || session.rehydrating || session.themeReloading) return;
      session.runtimeInstalled = false;
      void this.releaseSessionNative(session).then(() => this.rehydrateSession(session)).catch(() => {
        this.status("gpu-cleanup-error", { message: "GPU Scene receiver cleanup incomplete" });
      });
    } }) : null;
    this.nativeEnabled = false;
    this.nativeWallpaperId = null;
    this.directSceneEnabled = false;
    this.directSceneId = null;
    this.requiresMediaCsp = false;
    this.fallbackScripts = [];
    this.scenePreloadVersion = 0;
    this.scenePreloadKey = null;
    this.scenePreloadTimer = null;
    this.sceneUpdateDepth = 0;
    this.nativeCleanups = new Set();
    this.bootstrapScript = "";
    this.applyScript = "";
    this.compatibilityScript = "";
    this.compatibilityRestoreScript = "";
    this.planVersion = 0;
    this.running = false;
    this.power = { onBattery: false };
    this.restoring = false;
    this.lifecycleVersion = 0;
    this.installations = new Set();
    this.attachments = new Set();
    this.lastScanFailures = 0;
    this.lastScanDeferred = 0;
    this.lastScanTimings = [];
    this.sessions = new Map();
    this.disconnectedSessions = new Map();
    this.scanning = null;
    this.waitingMessage = null;
    this.timer = null;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  status(type, detail = {}) {
    try { this.onStatus({ type, at: new Date().toISOString(), ...detail }); } catch {}
  }

  async measureStage(timing, stage, task) {
    const startedAt = performance.now();
    let ok = false;
    try { const result = await task(); ok = true; return result; }
    finally {
      const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
      timing.stages[stage] = (timing.stages[stage] || 0) + elapsedMs;
      this.status("injection-stage", { message: `#${timing.id} ${STAGE_LABELS[stage]} ${elapsedMs} ms${ok ? "" : "（未成功）"}` });
    }
  }

  async listTargets({ includeAll = false } = {}) {
    const response = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets) || targets.some(t => !t || typeof t.id !== 'string' || !t.id)) throw new Error('CDP target list is malformed');
    return includeAll ? targets : targets.filter((target) => isHostRenderer(target, this.hostType));
  }

  attach(target, options) {
    if (this.restoring) return Promise.reject(new Error("Renderer restoration is in progress"));
    const operation = this.attachInternal(target, options);
    this.attachments.add(operation);
    return operation.finally(() => this.attachments.delete(operation));
  }

  async attachInternal(target, { deferHidden = false, refreshTarget = false } = {}) {
    if (this.sessions.has(target.id)) return this.sessions.get(target.id);
    const socket = this.socketFactory(target.webSocketDebuggerUrl);
    let session = null;
    let bypassCspRequested = false;
    const previous = this.disconnectedSessions.get(target.id);
    const timing = createInjectionTiming();
    const lifecycleVersion = this.lifecycleVersion;
    let attachmentVerified = false;
    try {
      if (this.nativeEnabled || this.directSceneEnabled) {
        const url = new URL(target.webSocketDebuggerUrl);
        if (this.host !== "127.0.0.1" || url.protocol !== "ws:" || url.hostname !== "127.0.0.1"
          || Number(url.port) !== this.port || url.username || url.password || url.hash) throw new Error("Native CDP socket is outside the verified endpoint");
        if ((this.nativeEnabled && !this.nativeDelivery) || (this.directSceneEnabled && !this.sceneDelivery)
          || typeof this.verifyEndpoint !== "function"
          || (await this.measureStage(timing, "owner", () => this.verifyEndpoint(this.port)))?.verified !== true) throw new Error("Native CDP endpoint is not identity-verified");
        attachmentVerified = true;
        await Promise.all([...this.nativeCleanups]);
      }
      if (refreshTarget && attachmentVerified) {
        // Owner verification can take seconds. A startup/reload target may
        // disappear during that wait; do not open its stale debugger socket.
        const current = (await this.listTargets({ includeAll: true })).find(t => t.id === target.id);
        if (!current) throw Object.assign(new Error('CDP target disappeared before attachment'), { cwbTargetGoneAfterVerification: true });
        if (!isHostRenderer(current, this.hostType) || current.webSocketDebuggerUrl !== target.webSocketDebuggerUrl) {
          throw new Error('Verified CDP target changed before attachment');
        }
        target = current;
      }
      await this.measureStage(timing, "connect", async () => {
        await socket.connect();
      });
      if (this.restoring || lifecycleVersion !== this.lifecycleVersion) throw new Error("Renderer restoration is in progress");
      if (deferHidden) {
        // Read one boolean only, before any CSP/style/theme change. Never bring
        // another window forward or keep a speculative connection alive.
        const hidden = await this.measureStage(timing, "visibility", () =>
          this.evaluateScript({ socket }, "document.hidden === true", 750).catch(() => null));
        if (hidden === true || (this.directSceneId && hidden !== false)) {
          socket.close();
          this.status("injection-deferred", { message: hidden === true
            ? `#${timing.id} 隐藏页面延后，先应用可见页面` : `#${timing.id} 页面可见性尚未确认，延后初始化` });
          return { deferred: true };
        }
      }
      if (this.restoring || lifecycleVersion !== this.lifecycleVersion) throw new Error("Renderer restoration is in progress");
      await this.measureStage(timing, "connect", async () => {
        await socket.call("Page.enable");
        await socket.call("Runtime.enable");
      });
      if (this.restoring || lifecycleVersion !== this.lifecycleVersion) throw new Error("Renderer restoration is in progress");
      bypassCspRequested = previous?.gpuCspInitialized === true || (!this.nativeEnabled && !this.directSceneEnabled && !this.requiresMediaCsp);
      await socket.call("Page.setBypassCSP", { enabled: bypassCspRequested });
      session = {
        target,
        targetOrigin: extractTargetOrigin(target.url, this.hostType),
        socket,
        newDocumentId: previous?.newDocumentId || null,
        compatibilityRestoreScript: previous?.compatibilityRestoreScript || "",
        rehydrating: null,
        themeReloading: false,
        themeReloadHandled: false,
        runtimeInstalled: false,
        nativeLease: null,
        pendingNativeLease: null,
        engineTransportId: null,
        sceneTransportId: null,
        sceneLease: null,
        scenePreloadLease: null,
        sceneLeases: new Set(),
        gpuCspInitialized: previous?.gpuCspInitialized === true,
        cspBypassActive: previous?.cspBypassActive === true,
        attachmentVerified,
        removeLoadListener: null,
        removeContextListener: null
      };
      const convergenceDeadline = performance.now() + (this.directSceneEnabled ? GPU_APPLY_TIMEOUT_MS : SCRIPT_TIMEOUT_MS);
      let appliedVersion;
      do {
        appliedVersion = this.planVersion;
        session.lastInjection = await this.installScript(session, {
          bootstrapScript: this.bootstrapScript,
          applyScript: this.applyScript,
          compatibilityScript: this.compatibilityScript,
          compatibilityRestoreScript: this.compatibilityRestoreScript,
          nativeEnabled: this.nativeEnabled, nativeWallpaperId: this.nativeWallpaperId,
          directSceneEnabled: this.directSceneEnabled, directSceneId: this.directSceneId, fallbackScripts: this.fallbackScripts,
          requiresMediaCsp: this.requiresMediaCsp
        }, { timing });
        // This proof is for the just-opened socket's immediate initialization
        // only, not a cache for later Scene selections or reconnections.
        session.attachmentVerified = false;
        if (this.restoring || lifecycleVersion !== this.lifecycleVersion) throw new Error("Renderer restoration is in progress");
        // A target is not in sessions while attaching. Updates may therefore
        // miss it; catch up before publishing the session. Bound continuous
        // churn with the existing script timeout rather than retry forever.
        if (appliedVersion !== this.planVersion && performance.now() >= convergenceDeadline) {
          throw new Error("Renderer injection plan did not stabilize before timeout");
        }
      } while (appliedVersion !== this.planVersion);
      session.appliedPlanVersion = appliedVersion;
      this.sessions.set(target.id, session);
      this.disconnectedSessions.delete(target.id);
      if (!this.restoring && this.installOnNewDocument && typeof socket.onEvent === "function") {
        if (this.nativeEnabled || this.directSceneEnabled) {
          session.removeContextListener = socket.onEvent("Runtime.executionContextsCleared", () => {
            if (!this.running || this.restoring || session.themeReloading) return;
            session.runtimeInstalled = false;
            void this.releaseSessionNative(session).catch(() => {
              this.status("native-cleanup-error", { message: "Native receiver cleanup incomplete" });
            });
          });
        }
        session.removeLoadListener = socket.onEvent("Page.loadEventFired", () => {
          void this.rehydrateSession(session);
        });
      }
      this.trackSessionDisconnect(session);
      this.status("attached", { targetId: target.id, url: target.url, title: target.title });
      return session;
    } catch (error) {
      // Only a verified, untouched document can be classified as a stale
      // discovery target. Identity, content, CSP or restore failures cannot.
      error.cwbUntouchedTargetConnectionFailure = attachmentVerified && !session && !bypassCspRequested
        && (isTargetConnectionFailure(error) || error.cwbTargetGoneAfterVerification === true);
      if (session) session.attachmentVerified = false;
      if (session?.newDocumentId) {
        await socket.call("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.newDocumentId
        }).then(() => { session.newDocumentId = null; }).catch(() => {});
      }
      if (session) {
        await this.releaseSessionNative(session).catch(() => {});
        if (session.compatibilityRestoreScript) {
          await this.evaluateScript(session, session.compatibilityRestoreScript).catch(() => {});
        }
        await this.evaluateScript(session, buildRestoreScript()).catch(() => {});
      }
      if (bypassCspRequested || session?.cspBypassActive) {
        try {
          await socket.call("Page.setBypassCSP", { enabled: false });
          if (session?.cspBypassActive) {
            await this.reloadDocument(session);
            session.gpuCspInitialized = false; session.cspBypassActive = false;
          }
        } catch {
          this.status("gpu-csp-cleanup-error", { message: "Document CSP restoration needs another cleanup attempt" });
        }
      }
      if (session) this.rememberSessionCleanup(session);
      socket.close();
      throw error;
    }
  }

  rememberSessionCleanup(session) {
    if (session.newDocumentId || session.compatibilityRestoreScript || session.cspBypassActive) {
      this.disconnectedSessions.set(session.target.id, {
        newDocumentId: session.newDocumentId,
        compatibilityRestoreScript: session.compatibilityRestoreScript,
        gpuCspInitialized: session.gpuCspInitialized === true,
        cspBypassActive: session.cspBypassActive === true,
      });
    }
  }

  trackSessionDisconnect(session) {
    session.socket.ws?.once?.("close", () => {
      if (this.sessions.get(session.target.id) !== session) return;
      session.removeLoadListener?.();
      session.removeLoadListener = null;
      session.removeContextListener?.();
      session.removeContextListener = null;
      this.rememberSessionCleanup(session);
      this.sessions.delete(session.target.id);
      void this.releaseSessionNative(session).catch(() => {});
    });
  }

  releaseSessionNative(session) {
    const operation = (async () => {
      const leases = new Set([session.pendingNativeLease, session.nativeLease].filter(Boolean));
      session.pendingNativeLease = null; session.nativeLease = null;
      for (const lease of session.sceneLeases || []) leases.add(lease);
      session.sceneLease = null;
      session.scenePreloadLease = null;
      // Seal leases synchronously before changing the document handle or awaiting
      // CDP. Otherwise a pump can send a captured frame through a null/new handle
      // and wrongly cache a source failure during our own theme reload.
      const releasing = Promise.all([...leases].map((lease) => lease.release()));
      releasing.catch(() => {});
      const handles = [session.engineTransportId, session.sceneTransportId].filter(Boolean);
      session.engineTransportId = null; session.sceneTransportId = null;
      for (const handle of handles) {
        await session.socket.call("Runtime.callFunctionOn", { objectId: handle,
          functionDeclaration: "function(){this.close();return true}", returnByValue: true }, 6000).catch(() => {});
        await session.socket.call("Runtime.releaseObject", { objectId: handle }).catch(() => {});
      }
      await releasing;
    })();
    this.nativeCleanups.add(operation);
    return operation.finally(() => this.nativeCleanups.delete(operation));
  }

  async installNativeRuntime(session, expression, injection = { nativeEnabled: true, directSceneEnabled: false }) {
    await this.releaseSessionNative(session);
    await Promise.all([...this.nativeCleanups]);
    const result = await session.socket.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: false, objectGroup: "cwb-owned-native"
    }, SCRIPT_TIMEOUT_MS);
    if (result.exceptionDetails || !result.result?.objectId) throw new Error("Native renderer bootstrap failed");
    const objectId = result.result.objectId;
    try {
      const ready = await session.socket.call("Runtime.callFunctionOn", { objectId,
        functionDeclaration: "function(){return this.ready===true}", returnByValue: true });
      if (runtimeValue(ready) !== true) throw new Error("Native renderer runtime is not ready");
      if (injection.nativeEnabled && !injection.directSceneEnabled) {
        const transport = await session.socket.call("Runtime.callFunctionOn", { objectId,
          functionDeclaration: "function(){return this.transport}", returnByValue: false, objectGroup: "cwb-owned-native" });
        if (transport.exceptionDetails || !transport.result?.objectId) throw new Error("Native receiver handle unavailable");
        session.engineTransportId = transport.result.objectId;
      }
      if (injection.directSceneEnabled) {
        const transport = await session.socket.call("Runtime.callFunctionOn", { objectId,
          functionDeclaration: "function(){return this.sceneTransport}", returnByValue: false, objectGroup: "cwb-owned-native" });
        if (transport.exceptionDetails || !transport.result?.objectId) throw new Error("GPU Scene receiver handle unavailable");
        session.sceneTransportId = transport.result.objectId;
      }
    } finally { await session.socket.call("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async connectRestorationTargets(targets, compatibilityRestoreScript) {
    const liveIds = new Set(targets.map((target) => target.id));
    const errors = [];
    const missingIds = new Set([...this.sessions.keys(), ...this.disconnectedSessions.keys()].filter(id => !liveIds.has(id)));
    const allIds = missingIds.size ? new Set((await this.listTargets({ includeAll: true })).map(t => t.id)) : liveIds;
    for (const id of missingIds) if (allIds.has(id)) {
      errors.push({ targetId: id, message: `${id}: live target outside renderer cohort`, connectionFailure: false });
    }
    for (const [id, session] of this.sessions) {
      if (liveIds.has(id) || allIds.has(id)) continue;
      session.socket.close();
      this.sessions.delete(id);
      this.disconnectedSessions.delete(id);
    }
    for (const id of this.disconnectedSessions.keys()) {
      if (!liveIds.has(id) && !allIds.has(id)) this.disconnectedSessions.delete(id);
    }
    for (const target of targets) {
      const current = this.sessions.get(target.id);
      if (current && current.socket.closed !== true) continue;
      const previous = this.disconnectedSessions.get(target.id) || current;
      const socket = this.socketFactory(target.webSocketDebuggerUrl);
      try {
        await socket.connect();
        await socket.call("Page.enable");
        // A recovery connection deliberately does not install the bootstrap,
        // apply wallpaper, register reload hooks, or enable CSP bypass.
        const session = {
          target,
          socket,
          newDocumentId: previous?.newDocumentId || null,
          compatibilityRestoreScript: previous?.compatibilityRestoreScript || compatibilityRestoreScript,
          gpuCspInitialized: previous?.gpuCspInitialized === true,
          cspBypassActive: previous?.cspBypassActive === true,
          runtimeInstalled: false,
          removeLoadListener: null,
        };
        this.sessions.set(target.id, session);
        this.disconnectedSessions.delete(target.id);
        this.trackSessionDisconnect(session);
      } catch (error) {
        socket.close();
        errors.push({ targetId: target.id, message: `${target.id}: ${error.message}`, connectionFailure: isTargetConnectionFailure(error) });
      }
    }
    return errors;
  }

  async evaluateScript(session, expression, timeoutMs = SCRIPT_TIMEOUT_MS) {
    const result = await session.socket.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, timeoutMs);
    return runtimeValue(result);
  }

  async reloadDocument(session) {
    // A load event can be queued for the previous document. Require the old
    // document marker to disappear as well; do not alter visibility or focus.
    const marker = randomUUID();
    await this.evaluateScript(session, `globalThis.__cwbDocumentReload=${JSON.stringify(marker)};true`);
    await session.socket.call("Page.reload", { ignoreCache: false }, SCRIPT_TIMEOUT_MS);
    const originCheck = this.hostType === "antigravity"
      ? `/^https:\\/\\/127\\.0\\.0\\.1:\\d{1,5}$/.test(location.origin)`
      : `location.origin==='app://-'`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        // DOM readiness is sufficient for bootstrap; unrelated subresources
        // need not finish. The marker proves this is not a queued old load.
        if (await this.evaluateScript(session, `globalThis.__cwbDocumentReload!==${JSON.stringify(marker)}&&${originCheck}&&document.readyState!=='loading'&&Boolean(document.body)`, Math.min(1000, Math.max(1, deadline - Date.now()))) === true) {
          session.runtimeInstalled = false; return;
        }
      } catch {}
      await delay(35);
    }
    throw new Error("GPU Scene document initialization failed");
  }

  queueSessionWork(session, task) {
    if (this.restoring) return Promise.reject(new Error("Renderer restoration is in progress"));
    const operation = (session.installationQueue || Promise.resolve()).catch(() => {}).then(() => {
      if (this.restoring) throw new Error("Renderer restoration is in progress");
      return task();
    });
    session.installationQueue = operation;
    this.installations.add(operation);
    return operation.finally(() => this.installations.delete(operation));
  }

  installScript(session, injectionValue, options = {}) {
    const timing = options.timing || createInjectionTiming();
    return this.queueSessionWork(session, () => this.installScriptInternal(session, injectionValue, { ...options, timing }));
  }

  async ensureRuntime(session, injection, timing) {
    if (session.runtimeInstalled || !injection.bootstrapScript) return;
    await this.measureStage(timing, "runtime", async () => {
      if (injection.nativeEnabled || injection.directSceneEnabled) {
        if (injection.nativeEnabled && !this.nativeDelivery) throw new Error("Native provider unavailable");
        if (injection.directSceneEnabled && !this.sceneDelivery) throw new Error("GPU Scene provider unavailable");
        await session.socket.call("Page.setBypassCSP", { enabled: session.gpuCspInitialized === true });
        await this.installNativeRuntime(session, injection.bootstrapScript, injection);
      } else {
        const runtime = await this.evaluateScript(session, injection.bootstrapScript);
        if (runtime?.ready !== true) throw new Error("Renderer runtime readiness verification failed");
      }
      session.runtimeInstalled = true;
    });
  }

  async cancelSessionScenePreload(session) {
    const lease = session.scenePreloadLease;
    session.scenePreloadLease = null;
    if (!lease || lease.closed) return;
    await session.socket.call('Runtime.callFunctionOn', { objectId: lease.receiverId,
      functionDeclaration: 'function(handle){return this.cancelPreload(handle)}',
      arguments: [{ value: lease.handle }], returnByValue: true }, 6000).catch(() => {});
    await lease.release();
  }

  async prepareScenePreloads(injection) {
    const checks = await Promise.allSettled([...this.sessions.values()].map((session) => this.queueSessionWork(session, async () => {
      const lease = session.scenePreloadLease;
      if (!lease || lease.closed) { session.scenePreloadLease = null; return null; }
      // Keep the next candidate across effect-only applies of the active scene.
      if (injection.directSceneId && session.sceneLease?.key === injection.directSceneId) return null;
      if (lease.key !== injection.directSceneId) { await this.cancelSessionScenePreload(session); return null; }
      lease.preloadAdopted = await this.sceneDelivery.promote(lease).catch(() => false);
      return lease.preloadAdopted ? null : lease.key;
    })));
    const invalid = new Set(checks.filter((result) => result.status === 'fulfilled' && result.value).map((result) => result.value));
    // Drop stale candidates on ALL targets before reserving another project.
    // Otherwise one target's old lease can occupy the global two-server budget.
    if (invalid.size) await Promise.all([...this.sessions.values()].map((session) => this.queueSessionWork(session, async () => {
      if (invalid.has(session.scenePreloadLease?.key)) await this.cancelSessionScenePreload(session);
    })));
  }

  async preloadScene(key, retryVersion = null, attempt = 0) {
    if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key))) throw TypeError('Invalid GPU preload identity');
    const version = retryVersion ?? (key !== null && key === this.scenePreloadKey ? this.scenePreloadVersion : ++this.scenePreloadVersion);
    if (retryVersion === null) { this.scenePreloadKey = key; clearTimeout(this.scenePreloadTimer); this.scenePreloadTimer = null; }
    if (version !== this.scenePreloadVersion || !this.running || this.restoring || !this.directSceneEnabled || !this.sceneDelivery) {
      return { ok: true, status: 'skipped', targets: 0 };
    }
    const results = await Promise.allSettled([...this.sessions.values()].map((session) => this.queueSessionWork(session, async () => {
      if (version !== this.scenePreloadVersion || !this.running || this.restoring) return 'skipped';
      if (key === null) { await this.cancelSessionScenePreload(session); return 'cancelled'; }
      if (this.sceneUpdateDepth) return 'busy';
      // Hover must never reload a document, establish CDP or install a runtime.
      if (!session.gpuCspInitialized || !session.runtimeInstalled || !session.sceneTransportId || session.rehydrating || session.themeReloading) return 'skipped';
      if (session.sceneLease?.key === key) return 'active';
      if (session.scenePreloadLease?.key === key && !session.scenePreloadLease.closed) return 'preparing';
      await this.cancelSessionScenePreload(session);
      let lease;
      try {
        lease = await this.sceneDelivery.prepare(session, key, { speculative: true });
        if (version !== this.scenePreloadVersion || !this.running || this.restoring) { await lease.release(); return 'skipped'; }
        const result = await session.socket.call('Runtime.callFunctionOn', { objectId: lease.receiverId,
          functionDeclaration: 'function(handle,key){return this.preload(handle,key)}',
          arguments: [{ value: lease.handle }, { value: key }], returnByValue: true }, 6000);
        const value = runtimeValue(result);
        if (value?.started !== true) { await lease.release(); return value?.busy ? 'busy' : 'skipped'; }
        session.scenePreloadLease = lease;
        if (version !== this.scenePreloadVersion || !this.running || this.restoring) {
          await this.cancelSessionScenePreload(session); return 'skipped';
        }
        return 'preparing';
      } catch (error) {
        if (lease) { session.scenePreloadLease = lease; await this.cancelSessionScenePreload(session); }
        if (['gpu_source_capacity', 'gpu_source_closing'].includes(error.message)) return 'busy';
        this.status('scene-preload-skipped', { message: 'GPU candidate preload unavailable; actual selection can still cold-load' });
        return 'skipped';
      }
    })));
    const values = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (values.includes('busy') && key !== null && attempt < 10 && version === this.scenePreloadVersion && this.running && !this.restoring) {
      this.scenePreloadTimer = setTimeout(() => { void this.preloadScene(key, version, attempt + 1).catch(() => {}); }, 500);
      this.scenePreloadTimer.unref?.();
    }
    return { ok: true, status: values.includes('preparing') ? 'preparing' : values.includes('busy') ? 'busy' : 'skipped',
      targets: values.filter((value) => value === 'preparing').length };
  }

  async installScriptInternal(session, injectionValue, {
    updateReloadHook = true,
    allowThemeReload = true,
    timing = createInjectionTiming()
  } = {}) {
    const injection = normalizeInjection(injectionValue);
    if (injection.compatibilityRestoreScript) session.compatibilityRestoreScript = injection.compatibilityRestoreScript;
    if (!injection.bootstrapScript && !injection.applyScript && !injection.compatibilityScript) return null;
    const defer = () => {
      session.deferred = true; session.deferredInjection = injection;
      this.status("injection-deferred", { message: "GPU 页面隐藏，保留已提交画面并等待可见" });
      return { deferred: true };
    };
    if (injection.directSceneId && await this.evaluateScript(session, "document.hidden === true", 750).catch(() => null) === true) return defer();
    session.deferred = false; session.deferredInjection = null;
    if (updateReloadHook && this.installOnNewDocument && !session.newDocumentId && injection.bootstrapScript) {
      const installed = await session.socket.call(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: injection.bootstrapScript },
        SCRIPT_TIMEOUT_MS
      );
      session.newDocumentId = installed.identifier || null;
    }
    if (injection.requiresMediaCsp && !session.gpuCspInitialized) {
      // Chromium applies CSP bypass at document initialization, not to an
      // already loaded Codex document. Loopback video/image/srcdoc need this
      // just as much as GPU scenes. Initialize once, not on every media switch.
      if ((injection.nativeEnabled || injection.directSceneEnabled) && (typeof this.verifyEndpoint !== "function"
        || session.socket.closed === true
        || (!session.attachmentVerified && (await this.measureStage(timing, "owner", () => this.verifyEndpoint(this.port)))?.verified !== true))) throw new Error("Native CDP endpoint is not identity-verified");
      session.attachmentVerified = false;
      const beforeReload = session.lastApplied;
      session.themeReloading = true;
      try {
        // Warm raw bytes only while host/theme initialization is in progress.
        // Real prepare still checks current files/policy and vendor hashes.
        if (injection.directSceneId) void this.sceneDelivery.warm(injection.directSceneId).catch(() => {});
        await this.ensureRuntime(session, injection, timing);
        const theme = await this.measureStage(timing, "theme", () => this.evaluateScript(session,
          "globalThis.__codexWallpaperBridgeRuntime.prepareTheme()"));
        if (typeof theme?.reloadRequired !== "boolean") throw new Error("Renderer theme preparation failed");
        await this.releaseSessionNative(session);
        if (this.restoring) throw new Error("Renderer restoration is in progress");
        await session.socket.call("Page.setBypassCSP", { enabled: true });
        session.cspBypassActive = true;
        await this.measureStage(timing, "reload", () => this.reloadDocument(session));
        timing.reloads += 1;
        session.gpuCspInitialized = true;
        // Recreate the last committed wallpaper before preparing the first
        // GPU candidate, so a failed candidate can still keep that old slot.
        if (beforeReload) {
          await this.installScriptInternal(session, beforeReload, { updateReloadHook: false, allowThemeReload: false, timing });
          const prepared = await this.evaluateScript(session, "globalThis.__codexWallpaperBridgeRuntime.waitForMedia()", GPU_APPLY_TIMEOUT_MS);
          if (prepared?.ok !== true) throw new Error("Renderer DOM application verification failed");
        }
      } finally { session.themeReloading = false; }
    }
    await this.ensureRuntime(session, injection, timing);
    // The host may settle its theme only after React mounts in the new
    // document. If it still requests a refresh, do that BEFORE creating the
    // first Scene, not after paying for a first frame that will be discarded.
    if (injection.requiresMediaCsp && !session.sceneLease && allowThemeReload && !session.themeReloadHandled) {
      const theme = await this.measureStage(timing, "theme", () => this.evaluateScript(session,
        "globalThis.__codexWallpaperBridgeRuntime.prepareTheme()"));
      if (typeof theme?.reloadRequired !== "boolean") throw new Error("Renderer theme preparation failed");
      if (theme.reloadRequired) {
        session.themeReloading = true;
        try {
          await this.releaseSessionNative(session);
          if (this.restoring) throw new Error("Renderer restoration is in progress");
          await this.measureStage(timing, "reload", () => this.reloadDocument(session));
          timing.reloads += 1;
          session.themeReloadHandled = true;
          return await this.installScriptInternal(session, injection, { updateReloadHook: false, allowThemeReload: false, timing });
        } finally { session.themeReloading = false; }
      }
    }
    let apply = null;
    let preloadHit = false;
    let preloadReady = false;
    if (injection.applyScript) {
      const applyStartedAt = performance.now();
      const previous = session.nativeLease;
      if (session.sceneLease?.closed) session.sceneLease = null;
      const previousScene = session.sceneLease;
      let candidate = null;
      let sceneCandidate = null;
      try {
        if (injection.nativeWallpaperId && previous?.key !== injection.nativeWallpaperId) {
          candidate = this.nativeDelivery.prepare(session, injection.nativeWallpaperId);
          session.pendingNativeLease = candidate;
        }
        if (injection.directSceneId && previousScene?.key !== injection.directSceneId) {
          const warm = session.scenePreloadLease;
          if (warm?.key === injection.directSceneId && !warm.closed && warm.preloadAdopted === true) {
            sceneCandidate = warm; session.scenePreloadLease = null; preloadHit = true;
            preloadReady = warm.snapshot?.prepared === true;
          } else {
            if (warm) await this.cancelSessionScenePreload(session);
            sceneCandidate = await this.measureStage(timing, "resources", () => this.sceneDelivery.prepare(session, injection.directSceneId));
          }
        }
        if (this.restoring) throw new Error("Renderer restoration is in progress");
        const applyTimeout = injection.directSceneId ? GPU_APPLY_TIMEOUT_MS : MEDIA_APPLY_TIMEOUT_MS;
        apply = await this.measureStage(timing, "apply", () => this.evaluateScript(session, injection.applyScript, applyTimeout));
        if (injection.directSceneId && apply?.deferred === true) {
          if (sceneCandidate) await sceneCandidate.release();
          return defer();
        }
        if (!appliedMediaReady(apply)) {
          throw Object.assign(new Error("Renderer DOM application verification failed"), {
            cwbMediaState: apply?.media?.state || apply?.mediaState,
            cwbSwitchFailure: apply?.switchResult?.error,
          });
        }
        if (candidate) { session.nativeLease = candidate; session.pendingNativeLease = null; }
        else if (!injection.nativeWallpaperId) session.nativeLease = null;
        if (previous && previous !== session.nativeLease) await previous.release();
        if (sceneCandidate) session.sceneLease = sceneCandidate;
        else if (!injection.directSceneId) session.sceneLease = null;
        // The retired iframe may still be participating in a fade. Polling
        // closes its resource server only after M1 disposes that slot.
        if (previousScene && previousScene !== session.sceneLease) previousScene.retire();
      } catch (error) {
        if (candidate) { session.pendingNativeLease = null; await candidate.release(); }
        if (sceneCandidate) {
          if (["Media load timed out", "Media failed to load or decode", "Media commit failed"].includes(error.cwbSwitchFailure)) this.sceneDelivery.fail(sceneCandidate);
          await sceneCandidate.release();
        }
        // New candidates never replace an existing committed wallpaper on
        // failure. With no old frame, try only trusted token-scoped fallbacks;
        // no VP8, arbitrary URL, automatic failure-cache clear or reload loop.
        const contentFailure = ['gpu_source_failed', 'gpu_project_unavailable', 'scene_manifest', 'scene_resource',
          'scene project root is unavailable', 'scene manifest is unavailable', 'scene manifest is invalid'].includes(error.message)
          || ['Media load timed out', 'Media failed to load or decode', 'Media commit failed'].includes(error.cwbSwitchFailure);
        if (!contentFailure || !injection.directSceneId || (session.lastApplied && session.fallbackFor !== injection.directSceneId)
          || this.restoring || !injection.fallbackScripts.length) throw error;
        apply = null;
        for (const fallback of injection.fallbackScripts) {
          try {
            const value = await this.evaluateScript(session, fallback.script, MEDIA_APPLY_TIMEOUT_MS);
            if (appliedMediaReady(value)) {
              apply = { ...value, degraded: true, fallbackReason: fallback.reason }; break;
            }
          } catch {}
        }
        if (!apply) throw error;
        session.fallbackFor = injection.directSceneId;
      }
      if (!apply?.degraded) session.fallbackFor = null;
      timing.applyMs += performance.now() - applyStartedAt;
      if (!appliedMediaReady(apply)) {
        throw new Error("Renderer DOM application verification failed");
      }
      if (allowThemeReload && !session.themeReloadHandled && apply.theme?.reloadRequired === true) {
        session.themeReloading = true;
        try {
          await this.releaseSessionNative(session);
          await this.measureStage(timing, "reload", async () => {
            const loaded = waitForPageLoad(session.socket);
            await session.socket.call("Page.reload", { ignoreCache: false }, SCRIPT_TIMEOUT_MS);
            await loaded;
            // A queued event may still belong to the old document.
            await delay(350);
          });
          timing.reloads += 1;
          // The renderer caches theme activation, including reloadRequired.
          // Consume that request for this document lifecycle so lightweight
          // config applies do not repeatedly reload and recreate the media.
          session.themeReloadHandled = true;
          session.runtimeInstalled = false;
          if (this.restoring) throw new Error("Renderer restoration is in progress");
          return await this.installScriptInternal(session, injection, {
            updateReloadHook: false,
            allowThemeReload: false,
            timing
          });
        } finally {
          session.themeReloading = false;
        }
      }
    }
    let compatibility = null;
    if (injection.compatibilityScript) {
      if (this.restoring) throw new Error("Renderer restoration is in progress");
      compatibility = await this.measureStage(timing, "compatibility", () => this.evaluateScript(session, injection.compatibilityScript));
      if (compatibility?.ok !== true) throw new Error("Renderer compatibility verification failed");
    }
    const detail = {
      targetId: session.target.id,
      runtimeMs: Math.round((timing.stages.runtime || 0) * 10) / 10,
      applyMs: Math.round(timing.applyMs * 10) / 10,
      totalMs: Math.round((performance.now() - timing.startedAt) * 10) / 10,
      timingId: timing.id,
      stages: { ...timing.stages },
      reloads: timing.reloads,
      preloadHit,
      preloadReady,
      mediaState: apply?.media?.state || apply?.mediaState || "idle",
      compatibility
    };
    if (apply?.degraded) { detail.degraded = true; detail.fallbackReason = apply.fallbackReason; }
    detail.message = `Runtime ${detail.runtimeMs} ms · DOM ${detail.applyMs} ms · 合计 ${detail.totalMs} ms · 媒体 ${detail.mediaState}`;
    detail.message += ` · 计时 #${timing.id} · 刷新 ${timing.reloads} 次`;
    detail.renderer = injection.directSceneId ? "direct-gpu" : injection.nativeWallpaperId ? "vp8" : "media";
    if (injection.directSceneId) detail.message += ` · GPU ${preloadHit
      ? preloadReady ? "预加载命中（首帧已就绪）" : "复用预加载（仍等待首帧）"
      : apply?.switchResult?.reused ? "当前场景复用" : "冷加载"}`;
    if (apply?.degraded) detail.message += ` · 引擎失败，已降级 ${apply.fallbackReason}（需显式重试）`;
    if (this.power.onBattery) await this.applyPower(session);
    session.lastApplied = injection;
    session.deferred = false; session.deferredInjection = null;
    this.status("injection-ready", detail);
    return detail;
  }

  async rehydrateSession(session) {
    if (!this.running || !this.sessions.has(session.target.id) || session.rehydrating || session.themeReloading) return;
    // Only an external page load starts a fresh theme lifecycle. Our own theme
    // reload is filtered above and must not rearm the cached reload request.
    session.themeReloadHandled = false;
    session.runtimeInstalled = false;
    session.appliedPlanVersion = 0;
    const planVersion = this.planVersion;
    session.rehydrating = this.installScript(
      session,
      {
        bootstrapScript: this.bootstrapScript,
        applyScript: this.applyScript,
        compatibilityScript: this.compatibilityScript,
        compatibilityRestoreScript: this.compatibilityRestoreScript,
        nativeEnabled: this.nativeEnabled, nativeWallpaperId: this.nativeWallpaperId,
        directSceneEnabled: this.directSceneEnabled, directSceneId: this.directSceneId, fallbackScripts: this.fallbackScripts,
        requiresMediaCsp: this.requiresMediaCsp
      },
      { updateReloadHook: false }
    ).then((result) => {
      if (planVersion === this.planVersion) session.appliedPlanVersion = planVersion;
      if (result && !result.deferred) session.lastInjection = result;
    }).catch((error) => {
      this.status("rehydrate-error", { targetId: session.target.id, message: error.message });
    }).finally(() => {
      session.rehydrating = null;
    });
    await session.rehydrating;
  }

  async retryNative(key) {
    if (!this.running || !this.nativeDelivery || this.restoring) throw new Error("Native retry unavailable");
    await this.nativeDelivery.retry(key);
    for (const session of this.sessions.values()) {
      if (session.nativeLease?.closed) session.nativeLease = null;
      if (session.pendingNativeLease?.closed) session.pendingNativeLease = null;
      if (session.engineTransportId) await session.socket.call("Runtime.callFunctionOn", {
        objectId: session.engineTransportId, functionDeclaration: "function(key){return this.retry(key)}",
        arguments: [{ value: key }], returnByValue: true
      });
    }
    return { cleared: true };
  }

  async retryScene(key) {
    if (!this.running || !this.sceneDelivery || this.restoring) throw new Error("GPU Scene retry unavailable");
    await this.sceneDelivery.retry(key);
    for (const session of this.sessions.values()) {
      if (session.sceneLease?.closed) session.sceneLease = null;
      if (session.sceneTransportId) await session.socket.call("Runtime.callFunctionOn", {
        objectId: session.sceneTransportId, functionDeclaration: "function(key){return this.retry(key)}",
        arguments: [{ value: key }], returnByValue: true
      });
    }
    return { cleared: true };
  }

  async applyPower(session) {
    return this.evaluateScript(session, `globalThis.__codexWallpaperBridgeRuntime?.setPower?.(${JSON.stringify(this.power)})`, 3000);
  }

  async updatePower(value) {
    if (typeof value?.onBattery !== "boolean") throw TypeError("power_invalid");
    this.power = { onBattery: value.onBattery };
    if (!this.running || this.restoring) return;
    await Promise.allSettled([...this.sessions.values()].filter(session => session.runtimeInstalled).map(session => this.applyPower(session)));
  }

  async update(injectionValue, { scan = false } = {}) {
    if (this.restoring) throw new Error("Renderer restoration is in progress");
    const injection = normalizeInjection(injectionValue);
    this.bootstrapScript = injection.bootstrapScript || this.bootstrapScript;
    this.applyScript = injection.applyScript;
    this.compatibilityScript = injection.compatibilityScript;
    this.compatibilityRestoreScript = injection.compatibilityRestoreScript;
    this.nativeEnabled = injection.nativeEnabled;
    this.nativeWallpaperId = injection.nativeWallpaperId;
    this.directSceneEnabled = injection.directSceneEnabled;
    this.directSceneId = injection.directSceneId;
    this.requiresMediaCsp = injection.requiresMediaCsp;
    this.fallbackScripts = injection.fallbackScripts;
    const targetPlanVersion = ++this.planVersion;
    this.scenePreloadVersion += 1;
    this.scenePreloadKey = null;
    clearTimeout(this.scenePreloadTimer); this.scenePreloadTimer = null;
    this.sceneUpdateDepth += 1;
    let results = [];
    let scanFailures = 0;
    let scanDeferred = 0;
    let scannedTimings = [];
    let alreadyAppliedCount = 0;
    let alreadyDeferredCount = 0;
    try {
      if (scan) {
        if (this.scanning) await this.scanning.catch(() => {});
        while (this.attachments.size > 0) {
          await Promise.allSettled([...this.attachments]);
        }
        if (this.restoring) throw new Error("Renderer restoration is in progress");
        await this.scanOnce();
        if (this.restoring) throw new Error("Renderer restoration is in progress");
        scanFailures = this.lastScanFailures;
        scanDeferred = this.lastScanDeferred;
        scannedTimings = [...this.lastScanTimings];
      }
      await this.prepareScenePreloads(injection);
      const sessionsToUpdate = [];
      for (const session of this.sessions.values()) {
        if ((session.appliedPlanVersion || 0) >= targetPlanVersion
          && !session.rehydrating
          && (session.deferred || session.runtimeInstalled)) {
          if (session.deferred) alreadyDeferredCount += 1;
          else {
            alreadyAppliedCount += 1;
            if (session.lastInjection && !scannedTimings.includes(session.lastInjection)) {
              scannedTimings.push(session.lastInjection);
            }
          }
        } else {
          sessionsToUpdate.push(session);
        }
      }
      results = await Promise.allSettled(sessionsToUpdate.map((session) => this.installScript(session, injection).then((value) => {
        if ((session.appliedPlanVersion || 0) < targetPlanVersion) {
          session.appliedPlanVersion = targetPlanVersion;
        }
        return value;
      })));
    } finally { this.sceneUpdateDepth -= 1; }
    const failed = results.filter((result) => result.status === "rejected");
    // Ordinal and fixed enums only: renderer exception text, target identities,
    // URLs and private CDP handles must not escape into diagnostic logs.
    const failureDetails = results.flatMap((result, targetIndex) => result.status === "rejected"
      ? [injectionFailureDetail(result.reason, targetIndex)] : []).slice(0, 8);
    for (const detail of failureDetails) this.status("injection-failed", { message: JSON.stringify(detail) });
    const updatedDeferred = results.filter((result) => result.status === "fulfilled" && result.value?.deferred === true).length;
    let deferredCount;
    if (scan) {
      const attachedDeferred = [...this.sessions.values()].filter((session) => session.deferred === true).length;
      const unattachedDeferred = Math.max(0, scanDeferred - attachedDeferred);
      deferredCount = updatedDeferred + alreadyDeferredCount + unattachedDeferred;
    } else {
      deferredCount = updatedDeferred || (this.sessions.size === 0 ? this.lastScanDeferred : 0);
    }
    const timings = [
      ...scannedTimings,
      ...results
        .filter((result) => result.status === "fulfilled" && result.value && !result.value.deferred)
        .map((result) => result.value),
    ];
    const totalFailed = failed.length + scanFailures;
    const totalSessions = (results.length - updatedDeferred) + alreadyAppliedCount;
    this.status("updated", { sessions: results.length + alreadyAppliedCount + alreadyDeferredCount, failed: totalFailed, timings });
    return { sessions: totalSessions, failed: totalFailed, deferred: deferredCount, timings, failureDetails };
  }

  scanOnce() {
    if (this.restoring) return Promise.resolve(0);
    if (this.scanning) return this.scanning;
    const operation = this.scanOnceInternal().finally(() => {
      if (this.scanning === operation) this.scanning = null;
    });
    this.scanning = operation;
    return operation;
  }

  async scanOnceInternal() {
    if (this.restoring) return 0;
    const lifecycleVersion = this.lifecycleVersion;
    this.lastScanFailures = 0;
    this.lastScanDeferred = 0;
    this.lastScanTimings = [];
    let targets;
    try {
      targets = await this.listTargets();
      this.waitingMessage = null;
    } catch (error) {
      const message = String(error?.message || error || "");
      if (this.waitingMessage !== message) {
        this.waitingMessage = message;
        this.status("waiting", { message, endpoint: this.endpoint });
      }
      return 0;
    }
    if (this.restoring || lifecycleVersion !== this.lifecycleVersion) return 0;
    const liveIds = new Set(targets.map((target) => target.id));
    for (const [id, session] of this.sessions) {
      if (!liveIds.has(id)) {
        session.removeLoadListener?.(); session.removeContextListener?.();
        await this.releaseSessionNative(session).catch(() => {});
        session.socket.close();
        this.sessions.delete(id);
      } else if (session.deferred && session.deferredInjection && !session.rehydrating) {
        try {
          const planVersion = this.planVersion;
          const result = await this.installScript(session, {
            bootstrapScript: this.bootstrapScript,
            applyScript: this.applyScript,
            compatibilityScript: this.compatibilityScript,
            compatibilityRestoreScript: this.compatibilityRestoreScript,
            nativeEnabled: this.nativeEnabled, nativeWallpaperId: this.nativeWallpaperId,
            directSceneEnabled: this.directSceneEnabled, directSceneId: this.directSceneId, fallbackScripts: this.fallbackScripts,
            requiresMediaCsp: this.requiresMediaCsp,
          });
          if (planVersion === this.planVersion) session.appliedPlanVersion = planVersion;
          if (result?.deferred) this.lastScanDeferred += 1;
          else if (result) {
            session.lastInjection = result;
            this.lastScanTimings.push(result);
          }
        } catch (error) {
          this.lastScanFailures += 1;
          this.status("attach-error", { targetId: id, message: error.message });
        }
      }
    }
    const pending = targets.filter((target) => !this.sessions.has(target.id));
    const deferred = [];
    const attachTarget = async (target, deferHidden = false) => {
      if (this.restoring || lifecycleVersion !== this.lifecycleVersion) return 0;
      if (this.sessions.has(target.id)) return;
      try {
        const session = await this.attach(target, { deferHidden, refreshTarget: this.nativeEnabled || this.directSceneEnabled });
        if (session.deferred) { deferred.push(target); this.lastScanDeferred += 1; return; }
        if (session.lastInjection) this.lastScanTimings.push(session.lastInjection);
        return true;
      } catch (error) {
        if (error.cwbUntouchedTargetConnectionFailure === true) {
          let current;
          try { current = await this.listTargets({ includeAll: true }); } catch {}
          if (current && !current.some(entry => entry.id === target.id)) {
            this.status("attach-gone", { message: "已核验的未修改目标在连接前消失，等待新目标" });
            return false;
          }
        }
        this.lastScanFailures += 1;
        this.status("attach-error", { targetId: target.id, message: error.message });
      }
    };
    let hasReadyTarget = false;
    for (const target of pending) {
      const attached = await attachTarget(target, Boolean(this.directSceneId) || pending.length > 1);
      if (attached === true) hasReadyTarget = true;
    }
    // A hidden GPU iframe can load all assets while Chromium suspends its
    // animation frames. Do not turn that into a source failure, mutate CSP or
    // steal focus: the regular scan will attach it after it becomes visible.
    // Keep the existing eager hidden-page contract for ordinary media.
    if (this.directSceneId) return targets.length;
    // Visible targets get their first frame first. Hidden pages retain their
    // existing success/failure contract, with bounded rather than fan-out work.
    // If every page is hidden, initialize one successfully first: theme and
    // the saved original preference share the host's localStorage origin.
    let index = 0;
    while (!hasReadyTarget && index < deferred.length) {
      hasReadyTarget = await attachTarget(deferred[index++]) === true;
    }
    for (; index < deferred.length; index += 2) {
      await Promise.all(deferred.slice(index, index + 2).map((target) => attachTarget(target)));
    }
    return targets.length;
  }

  async start(injectionValue) {
    if (this.restoring) throw new Error("Renderer restoration is in progress");
    if (injectionValue !== undefined) {
      const injection = normalizeInjection(injectionValue);
      this.bootstrapScript = injection.bootstrapScript || this.bootstrapScript;
      this.applyScript = injection.applyScript || this.applyScript;
      this.compatibilityScript = injection.compatibilityScript;
      this.compatibilityRestoreScript = injection.compatibilityRestoreScript;
      this.nativeEnabled = injection.nativeEnabled;
      this.nativeWallpaperId = injection.nativeWallpaperId;
      this.directSceneEnabled = injection.directSceneEnabled;
      this.directSceneId = injection.directSceneId;
      this.requiresMediaCsp = injection.requiresMediaCsp;
      this.fallbackScripts = injection.fallbackScripts;
      this.planVersion += 1;
    }
    if (this.running) return;
    this.waitingMessage = null;
    this.running = true;
    await this.scanOnce();
    const tick = async () => {
      if (!this.running) return;
      await this.scanOnce();
      if (this.running) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    this.timer = setTimeout(tick, this.pollIntervalMs);
    this.status("started", { endpoint: this.endpoint });
    return { sessions: [...this.sessions.values()].filter(session => !session.deferred).length, failed: this.lastScanFailures, deferred: this.lastScanDeferred, timings: this.lastScanTimings };
  }

  async restore({ allowEndpointUnavailable = false } = {}) {
    this.scenePreloadVersion += 1;
    this.scenePreloadKey = null;
    clearTimeout(this.scenePreloadTimer); this.scenePreloadTimer = null;
    this.lifecycleVersion += 1;
    this.running = false;
    this.waitingMessage = null;
    clearTimeout(this.timer);
    this.restoring = true;
    const compatibilityRestoreScript = this.compatibilityRestoreScript;
    this.bootstrapScript = "";
    this.applyScript = "";
    this.compatibilityScript = "";
    this.compatibilityRestoreScript = "";
    for (const session of this.sessions.values()) {
      session.removeLoadListener?.();
      session.removeLoadListener = null;
      session.removeContextListener?.();
      session.removeContextListener = null;
    }
    try {
      await Promise.all([...this.sessions.values()].map((session) => this.releaseSessionNative(session)));
      // Finish already-sent CDP work before clearing DOM so a late apply cannot
      // recreate either layer after restoration.
      while (this.installations.size > 0 || this.attachments.size > 0) {
        await Promise.allSettled([...this.installations, ...this.attachments]);
      }
      let targets;
      try {
        targets = await this.listTargets();
      } catch (error) {
        if (allowEndpointUnavailable && isEndpointUnavailableError(error)) {
          this.disconnectedSessions.clear();
          this.status("restored", { sessions: 0, endpointUnavailable: true });
          return;
        }
        throw error;
      }
      if (targets.length === 0) {
        if (allowEndpointUnavailable) {
          let allIds = new Set();
          try {
            allIds = new Set((await this.listTargets({ includeAll: true })).map((t) => t.id));
          } catch (error) {
            if (!isEndpointUnavailableError(error)) throw error;
          }
          const trackedIds = [...this.sessions.keys(), ...this.disconnectedSessions.keys()];
          if (!trackedIds.some((id) => allIds.has(id))) {
            this.disconnectedSessions.clear();
            this.status("restored", { sessions: 0, endpointUnavailable: true });
            return;
          }
        }
        throw new Error(`没有找到可完整恢复的 ${hostDisplayName(this.hostType)} renderer`);
      }
      const coverageErrors = [];
      let cohortSettled = false;
      for (let round = 0; round < 3; round++) {
        const connectionErrors = await this.connectRestorationTargets(targets, compatibilityRestoreScript);
        let current;
        try {
          current = await this.listTargets();
        } catch (error) {
          if (allowEndpointUnavailable && isEndpointUnavailableError(error)) {
            this.disconnectedSessions.clear();
            this.status("restored", { sessions: 0, endpointUnavailable: true });
            return;
          }
          throw error;
        }
        if (current.length === 0) {
          if (allowEndpointUnavailable) {
            let allIds = new Set();
            try {
              allIds = new Set((await this.listTargets({ includeAll: true })).map((t) => t.id));
            } catch (error) {
              if (!isEndpointUnavailableError(error)) throw error;
            }
            const trackedIds = [...this.sessions.keys(), ...this.disconnectedSessions.keys()];
            if (!trackedIds.some((id) => allIds.has(id))) {
              this.disconnectedSessions.clear();
              this.status("restored", { sessions: 0, endpointUnavailable: true });
              return;
            }
          }
          throw new Error(`没有找到可完整恢复的 ${hostDisplayName(this.hostType)} renderer`);
        }
        const currentIds = new Set(current.map(t => t.id));
        const removed = targets.filter(t => !currentIds.has(t.id));
        const allIds = removed.length ? new Set((await this.listTargets({ includeAll: true })).map(t => t.id)) : currentIds;
        for (const error of connectionErrors) {
          if (error.connectionFailure && !allIds.has(error.targetId)) {
            this.status('restoration-target-gone', { message: '恢复连接期间目标已消失，复核新目标覆盖' });
          } else coverageErrors.push(error.message);
        }
        for (const target of removed) if (allIds.has(target.id)) {
          coverageErrors.push(`${target.id}: live target outside renderer cohort`);
        }
        const stable = targets.length === current.length && targets.every(t => current.some(c =>
          c.id === t.id && c.webSocketDebuggerUrl === t.webSocketDebuggerUrl));
        targets = current;
        if (stable) { cohortSettled = true; break; }
      }
      if (!cohortSettled) coverageErrors.push('Renderer restoration target cohort did not settle');
      const restorationSessions = targets.flatMap((target) => {
        const session = this.sessions.get(target.id);
        if (!session || session.socket.closed === true) {
          coverageErrors.push(`${target.id}: restoration target disconnected`);
          return [];
        }
        return [session];
      });
      const restoreScript = buildRestoreScript();
      const results = await Promise.allSettled(restorationSessions.map(async (session) => {
        const errors = [];
        const attempt = async (task) => {
          try { return await task(); }
          catch (error) { errors.push(error); return null; }
        };
        if (session.newDocumentId) {
          await attempt(async () => {
            await session.socket.call("Page.removeScriptToEvaluateOnNewDocument", {
              identifier: session.newDocumentId
            });
            session.newDocumentId = null;
          });
        }
        const restoreCompatibility = session.compatibilityRestoreScript || compatibilityRestoreScript;
        if (restoreCompatibility) {
          await attempt(async () => {
            const restored = await this.evaluateScript(session, restoreCompatibility);
            if (restored !== true && restored?.ok !== true) throw new Error("Renderer compatibility restoration verification failed");
          });
        }
        const restored = await attempt(async () => {
          const value = await this.evaluateScript(session, restoreScript);
          if (value?.ok !== true) throw new Error("Renderer restoration verification failed");
          return value;
        });
        // Disabling bypass affects new documents. Do it before the restore
        // reload, not afterwards; remove reload hooks above before navigating.
        const cspReset = await attempt(async () => {
          await session.socket.call("Page.setBypassCSP", { enabled: false }); return true;
        });
        const needsGpuReload = restored?.cspReloadRequired === true || session.cspBypassActive === true;
        if (cspReset && (needsGpuReload || restored?.theme?.reloadRequired === true)) {
          session.themeReloading = true;
          try {
            await attempt(async () => {
              if (needsGpuReload) await this.reloadDocument(session);
              else {
                const loaded = waitForPageLoad(session.socket);
                await session.socket.call("Page.reload", { ignoreCache: false }, SCRIPT_TIMEOUT_MS);
                await loaded; await delay(350);
              }
              session.runtimeInstalled = false;
              session.gpuCspInitialized = false; session.cspBypassActive = false;
            });
          } finally {
            session.themeReloading = false;
          }
        }
        session.runtimeInstalled = false;
        if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
        session.compatibilityRestoreScript = "";
      }));
      const failed = results.filter((result) => result.status === "rejected");
      const errors = [...coverageErrors, ...failed.map((result) => result.reason.message)];
      if (errors.length) throw new Error(`Renderer restoration failed: ${errors.join("; ")}`);
      this.status("restored", { sessions: this.sessions.size });
    } finally {
      this.restoring = false;
    }
  }

  async preserveCurrentPage() {
    if ([...this.sessions.values(), ...this.disconnectedSessions.values()].some((session) => session.cspBypassActive)) {
      throw new Error("GPU Scene requires full restoration before stopping the bridge");
    }
    const results = await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      if (session.newDocumentId) {
        await session.socket.call("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.newDocumentId
        });
        session.newDocumentId = null;
      }
      await session.socket.call("Page.setBypassCSP", { enabled: false });
    }));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) {
      throw new Error(`无法安全结束一次性注入（${failed.length} 个 renderer 清理失败）`);
    }
    this.status("preserved", { sessions: this.sessions.size });
  }

  async close({ restore = false, preserveCurrentPage = false, allowEndpointUnavailable = false } = {}) {
    this.scenePreloadVersion += 1;
    this.scenePreloadKey = null;
    clearTimeout(this.scenePreloadTimer); this.scenePreloadTimer = null;
    this.lifecycleVersion += 1;
    this.running = false;
    this.waitingMessage = null;
    clearTimeout(this.timer);
    try {
      if (restore || (!preserveCurrentPage && [...this.sessions.values(), ...this.disconnectedSessions.values()].some((session) => session.cspBypassActive))) {
        await this.restore({ allowEndpointUnavailable });
      }
      else if (preserveCurrentPage) {
        try {
          await this.preserveCurrentPage();
        } catch (error) {
          await this.restore({ allowEndpointUnavailable });
          throw error;
        }
      }
    } finally {
      const cleanupResults = await Promise.allSettled([
        this.nativeDelivery?.close(), this.sceneDelivery?.close(), ...this.nativeCleanups
      ]);
      for (const session of this.sessions.values()) {
        session.removeLoadListener?.();
        session.removeContextListener?.();
        // WebSocket close is asynchronous, so save failed-cleanup metadata
        // before clearing the live session map.
        this.rememberSessionCleanup(session);
        session.socket.close();
      }
      this.sessions.clear();
      this.status("closed");
      await delay(0);
      if (cleanupResults.some((result) => result.status === "rejected")) throw new Error("Wallpaper resource cleanup incomplete");
    }
  }
}

export async function restoreCdpWallpaper({ port = 9335, host = "127.0.0.1", hostType = "codex", onStatus, compatibilityRestoreScript = "" } = {}) {
  const injector = new CdpWallpaperInjector({ port, host, hostType, onStatus });
  injector.compatibilityRestoreScript = compatibilityRestoreScript;
  try {
    await injector.restore();
  } finally {
    await injector.close();
  }
}
