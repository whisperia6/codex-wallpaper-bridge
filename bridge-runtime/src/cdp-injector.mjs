import { WebSocket } from "ws";
import { buildRestoreScript } from "./injected-renderer.mjs";

const SCRIPT_TIMEOUT_MS = 15_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInjection(value) {
  if (typeof value === "string") {
    return { bootstrapScript: "", applyScript: value };
  }
  if (!value || typeof value !== "object") throw new TypeError("injection must be an object");
  const bootstrapScript = String(value.bootstrapScript || "");
  const applyScript = String(value.applyScript || value.script || "");
  if (!bootstrapScript && !applyScript) {
    return { bootstrapScript: "", applyScript: "" };
  }
  return { bootstrapScript, applyScript };
}

function runtimeValue(result) {
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer injection failed");
  }
  return result?.result?.value;
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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (error) => { clearTimeout(timer); reject(error); });
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
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
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

function isCodexRenderer(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "");
  if (/initialRoute=.*(?:avatar|pet|overlay)/i.test(url)) return false;
  return url.startsWith("app://");
}

export class CdpWallpaperInjector {
  constructor({
    host = "127.0.0.1",
    port = 9335,
    pollIntervalMs = 1_500,
    onStatus = () => {},
    installOnNewDocument = true,
    socketFactory = (url) => new CdpSocket(url)
  } = {}) {
    this.host = host;
    this.port = Number(port);
    this.pollIntervalMs = pollIntervalMs;
    this.onStatus = onStatus;
    this.installOnNewDocument = installOnNewDocument;
    this.socketFactory = socketFactory;
    this.bootstrapScript = "";
    this.applyScript = "";
    this.running = false;
    this.sessions = new Map();
    this.timer = null;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  status(type, detail = {}) {
    try { this.onStatus({ type, at: new Date().toISOString(), ...detail }); } catch {}
  }

  async listTargets() {
    const response = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
    const targets = await response.json();
    return Array.isArray(targets) ? targets.filter(isCodexRenderer) : [];
  }

  async attach(target) {
    if (this.sessions.has(target.id)) return this.sessions.get(target.id);
    const socket = this.socketFactory(target.webSocketDebuggerUrl);
    let session = null;
    let bypassCspRequested = false;
    try {
      await socket.connect();
      await socket.call("Page.enable");
      await socket.call("Runtime.enable");
      bypassCspRequested = true;
      await socket.call("Page.setBypassCSP", { enabled: true });
      session = {
        target,
        socket,
        newDocumentId: null,
        rehydrating: null,
        runtimeInstalled: false,
        removeLoadListener: null
      };
      await this.installScript(session, {
        bootstrapScript: this.bootstrapScript,
        applyScript: this.applyScript
      });
      this.sessions.set(target.id, session);
      if (this.installOnNewDocument && typeof socket.onEvent === "function") {
        session.removeLoadListener = socket.onEvent("Page.loadEventFired", () => {
          void this.rehydrateSession(session);
        });
      }
      socket.ws?.once?.("close", () => this.sessions.delete(target.id));
      this.status("attached", { targetId: target.id, url: target.url, title: target.title });
      return session;
    } catch (error) {
      if (session?.newDocumentId) {
        await socket.call("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.newDocumentId
        }).catch(() => {});
      }
      if (bypassCspRequested) {
        await socket.call("Page.setBypassCSP", { enabled: false }).catch(() => {});
      }
      socket.close();
      throw error;
    }
  }

  async evaluateScript(session, expression) {
    const result = await session.socket.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, SCRIPT_TIMEOUT_MS);
    return runtimeValue(result);
  }

  async installScript(session, injectionValue, { updateReloadHook = true } = {}) {
    const injection = normalizeInjection(injectionValue);
    if (!injection.bootstrapScript && !injection.applyScript) return null;
    const startedAt = performance.now();
    if (updateReloadHook && this.installOnNewDocument && !session.newDocumentId && injection.bootstrapScript) {
      const installed = await session.socket.call(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: injection.bootstrapScript },
        SCRIPT_TIMEOUT_MS
      );
      session.newDocumentId = installed.identifier || null;
    }
    let runtimeMs = 0;
    if (!session.runtimeInstalled && injection.bootstrapScript) {
      const runtimeStartedAt = performance.now();
      const runtime = await this.evaluateScript(session, injection.bootstrapScript);
      runtimeMs = performance.now() - runtimeStartedAt;
      if (runtime?.ready !== true) throw new Error("Renderer runtime readiness verification failed");
      session.runtimeInstalled = true;
    }
    let apply = null;
    let applyMs = 0;
    if (injection.applyScript) {
      const applyStartedAt = performance.now();
      apply = await this.evaluateScript(session, injection.applyScript);
      applyMs = performance.now() - applyStartedAt;
      if (apply?.ok !== true || apply.runtimeReady !== true || apply.domReady !== true) {
        throw new Error("Renderer DOM application verification failed");
      }
    }
    const detail = {
      targetId: session.target.id,
      runtimeMs: Math.round(runtimeMs * 10) / 10,
      applyMs: Math.round(applyMs * 10) / 10,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      mediaState: apply?.media?.state || apply?.mediaState || "idle"
    };
    detail.message = `Runtime ${detail.runtimeMs} ms · DOM ${detail.applyMs} ms · 合计 ${detail.totalMs} ms · 媒体 ${detail.mediaState}`;
    this.status("injection-ready", detail);
    return detail;
  }

  async rehydrateSession(session) {
    if (!this.running || !this.sessions.has(session.target.id) || session.rehydrating) return;
    session.runtimeInstalled = false;
    session.rehydrating = this.installScript(
      session,
      {
        bootstrapScript: this.bootstrapScript,
        applyScript: this.applyScript
      },
      { updateReloadHook: false }
    ).catch((error) => {
      this.status("rehydrate-error", { targetId: session.target.id, message: error.message });
    }).finally(() => {
      session.rehydrating = null;
    });
    await session.rehydrating;
  }

  async update(injectionValue) {
    const injection = normalizeInjection(injectionValue);
    this.bootstrapScript = injection.bootstrapScript || this.bootstrapScript;
    this.applyScript = injection.applyScript;
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.installScript(session, injection))
    );
    const failed = results.filter((result) => result.status === "rejected");
    const timings = results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    this.status("updated", { sessions: results.length, failed: failed.length, timings });
    return { sessions: results.length, failed: failed.length, timings };
  }

  async scanOnce() {
    let targets;
    try {
      targets = await this.listTargets();
    } catch (error) {
      this.status("waiting", { message: error.message, endpoint: this.endpoint });
      return 0;
    }
    const liveIds = new Set(targets.map((target) => target.id));
    for (const [id, session] of this.sessions) {
      if (!liveIds.has(id)) {
        session.socket.close();
        this.sessions.delete(id);
      }
    }
    for (const target of targets) {
      if (this.sessions.has(target.id)) continue;
      try { await this.attach(target); }
      catch (error) { this.status("attach-error", { targetId: target.id, message: error.message }); }
    }
    return targets.length;
  }

  async start(injectionValue) {
    if (injectionValue !== undefined) {
      const injection = normalizeInjection(injectionValue);
      this.bootstrapScript = injection.bootstrapScript || this.bootstrapScript;
      this.applyScript = injection.applyScript || this.applyScript;
    }
    if (this.running) return;
    this.running = true;
    await this.scanOnce();
    const tick = async () => {
      if (!this.running) return;
      await this.scanOnce();
      if (this.running) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    this.timer = setTimeout(tick, this.pollIntervalMs);
    this.status("started", { endpoint: this.endpoint });
  }

  async restore() {
    this.bootstrapScript = "";
    this.applyScript = "";
    const restoreScript = buildRestoreScript();
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      if (session.newDocumentId) {
        await session.socket.call("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.newDocumentId
        }).catch(() => {});
        session.newDocumentId = null;
      }
      await session.socket.call("Runtime.evaluate", {
        expression: restoreScript,
        awaitPromise: true,
        returnByValue: true
      }).catch(() => {});
      await session.socket.call("Page.setBypassCSP", { enabled: false }).catch(() => {});
    }));
    this.status("restored", { sessions: this.sessions.size });
  }

  async preserveCurrentPage() {
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

  async close({ restore = false, preserveCurrentPage = false } = {}) {
    this.running = false;
    clearTimeout(this.timer);
    try {
      if (restore) await this.restore();
      else if (preserveCurrentPage) {
        try {
          await this.preserveCurrentPage();
        } catch (error) {
          await this.restore();
          throw error;
        }
      }
    } finally {
      for (const session of this.sessions.values()) {
        session.removeLoadListener?.();
        session.socket.close();
      }
      this.sessions.clear();
      this.status("closed");
      await delay(0);
    }
  }
}

export async function restoreCdpWallpaper({ port = 9335, host = "127.0.0.1", onStatus } = {}) {
  const injector = new CdpWallpaperInjector({ port, host, onStatus });
  await injector.scanOnce();
  await injector.restore();
  await injector.close();
}
