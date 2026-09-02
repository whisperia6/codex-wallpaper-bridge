import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { WebSocket } from "ws";
import { buildRestoreScript } from "./injected-renderer.mjs";

const MINIMUM_SCRIPT_TIMEOUT_MS = 15_000;
const MAXIMUM_SCRIPT_TIMEOUT_MS = 120_000;
const SCRIPT_TIMEOUT_PER_MIB_MS = 2_000;
const FAST_ASSET_CHUNK_BYTES = 8 * 1024 * 1024;
const FAST_ASSET_CONCURRENCY = 3;
const FALLBACK_ASSET_CHUNK_BYTES = 2 * 1024 * 1024;
const FALLBACK_ASSET_CONCURRENCY = 1;
const ASSET_COMMAND_TIMEOUT_MS = 30_000;
const ASSET_REGISTRY_KEY = "__codexWallpaperBridgeAssets";
const ASSET_TRANSFER_KEY = "__codexWallpaperBridgeAssetTransfer";

function scriptCommandTimeout(script) {
  const scriptMiB = Math.ceil(Buffer.byteLength(script, "utf8") / (1024 * 1024));
  return Math.min(
    MAXIMUM_SCRIPT_TIMEOUT_MS,
    Math.max(MINIMUM_SCRIPT_TIMEOUT_MS, 8_000 + scriptMiB * SCRIPT_TIMEOUT_PER_MIB_MS)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInjection(value) {
  if (typeof value === "string") return { script: value, assets: [] };
  if (!value || typeof value !== "object" || typeof value.script !== "string") {
    throw new TypeError("injection must be a script string or an object containing script");
  }
  return {
    script: value.script,
    assets: Array.isArray(value.assets) ? value.assets : []
  };
}

function runtimeValue(result) {
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer asset transfer failed");
  }
  return result?.result?.value;
}

function transferProgressDetail(mode, transferred, size) {
  const label = mode === "fast" ? "高速模式" : "兼容模式";
  const percent = Math.min(100, Math.round((transferred / size) * 100));
  const transferredMiB = (transferred / (1024 * 1024)).toFixed(2);
  const sizeMiB = (size / (1024 * 1024)).toFixed(2);
  return {
    mode,
    transferred,
    size,
    percent,
    message: `${label} ${transferredMiB}/${sizeMiB} MiB · ${percent}%`
  };
}

async function* readAssetChunks(asset, chunkBytes) {
  if (Buffer.isBuffer(asset.bytes)) {
    for (let offset = 0; offset < asset.bytes.length; offset += chunkBytes) {
      yield asset.bytes.subarray(offset, offset + chunkBytes);
    }
    return;
  }
  const info = await stat(asset.filePath);
  if (!info.isFile() || info.size !== asset.size) {
    throw new Error("大型视频在注入期间发生变化，请重新扫描后再试");
  }
  if (Number.isFinite(asset.mtimeMs) && Math.abs(info.mtimeMs - asset.mtimeMs) > 1) {
    throw new Error("大型视频在注入期间发生变化，请重新扫描后再试");
  }
  yield* createReadStream(asset.filePath, { highWaterMark: chunkBytes });
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
    this.script = "";
    this.assets = [];
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
      session = { target, socket, newDocumentId: null, rehydrating: null, removeLoadListener: null };
      await this.installScript(session, { script: this.script, assets: this.assets });
      this.sessions.set(target.id, session);
      if (this.installOnNewDocument && typeof socket.onEvent === "function") {
        session.removeLoadListener = socket.onEvent("Page.loadEventFired", () => {
          void this.rehydrateSession(session);
        });
      }
      socket.ws.once("close", () => this.sessions.delete(target.id));
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

  async hasRendererAsset(session, key, size) {
    const result = await session.socket.call("Runtime.evaluate", {
      expression: `(() => {
        const registry = globalThis[${JSON.stringify(ASSET_REGISTRY_KEY)}] ||
          (globalThis[${JSON.stringify(ASSET_REGISTRY_KEY)}] = new Map());
        const cached = registry.get(${JSON.stringify(key)});
        return Boolean(cached?.url && cached.size === ${size});
      })()`,
      returnByValue: true
    }, ASSET_COMMAND_TIMEOUT_MS);
    return runtimeValue(result) === true;
  }

  async initializeAssetTransfer(session, { key, contentType, size, chunkBytes }) {
    const partCount = Math.ceil(size / chunkBytes);
    const result = await session.socket.call("Runtime.evaluate", {
      expression: `(() => {
        globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}] = {
          key: ${JSON.stringify(key)},
          parts: new Array(${partCount}),
          completed: 0,
          received: 0,
          size: ${size},
          partCount: ${partCount},
          contentType: ${JSON.stringify(contentType)}
        };
        return true;
      })()`,
      returnByValue: true
    }, ASSET_COMMAND_TIMEOUT_MS);
    runtimeValue(result);
  }

  async appendAssetChunk(session, { key, chunk, partIndex }) {
    const base64 = Buffer.from(chunk).toString("base64");
    const result = await session.socket.call("Runtime.evaluate", {
      expression: `(() => {
        const transfer = globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}];
        if (!transfer || transfer.key !== ${JSON.stringify(key)}) {
          throw new Error("renderer asset transfer state was lost");
        }
        if (transfer.parts[${partIndex}]) {
          throw new Error("renderer asset chunk was duplicated");
        }
        const binary = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        transfer.parts[${partIndex}] = bytes;
        transfer.completed += 1;
        transfer.received += bytes.byteLength;
        return transfer.received;
      })()`,
      returnByValue: true
    }, ASSET_COMMAND_TIMEOUT_MS);
    runtimeValue(result);
  }

  async finalizeAssetTransfer(session, { key, size }) {
    const finalized = await session.socket.call("Runtime.evaluate", {
      expression: `(() => {
        const transfer = globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}];
        if (!transfer || transfer.key !== ${JSON.stringify(key)} ||
            transfer.received !== ${size} || transfer.completed !== transfer.partCount) {
          throw new Error("renderer asset transfer is incomplete");
        }
        const blob = new Blob(transfer.parts, { type: transfer.contentType });
        const url = URL.createObjectURL(blob);
        const registry = globalThis[${JSON.stringify(ASSET_REGISTRY_KEY)}] ||
          (globalThis[${JSON.stringify(ASSET_REGISTRY_KEY)}] = new Map());
        const previous = registry.get(transfer.key);
        if (previous?.url) URL.revokeObjectURL(previous.url);
        registry.set(transfer.key, { url, size: blob.size, contentType: blob.type });
        delete globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}];
        return { size: blob.size };
      })()`,
      returnByValue: true
    }, ASSET_COMMAND_TIMEOUT_MS);
    if (runtimeValue(finalized)?.size !== size) {
      throw new Error("renderer asset Blob size does not match the source video");
    }
  }

  async cleanupAssetTransfer(session, key) {
    await session.socket.call("Runtime.evaluate", {
      expression: `(() => {
        const transfer = globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}];
        if (transfer?.key === ${JSON.stringify(key)}) {
          delete globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}];
        }
        return true;
      })()`,
      returnByValue: true
    }, ASSET_COMMAND_TIMEOUT_MS).catch(() => {});
  }

  async transferAssetAttempt(session, asset, { mode, chunkBytes, concurrency, startType }) {
    const key = String(asset.key);
    const size = Number(asset.size ?? asset.bytes?.length);
    const contentType = String(asset.contentType || "application/octet-stream");
    await this.initializeAssetTransfer(session, { key, contentType, size, chunkBytes });
    if (startType) {
      this.status(startType, {
        key,
        chunkBytes,
        concurrency,
        ...transferProgressDetail(mode, 0, size)
      });
    }

    let readBytes = 0;
    let transferredBytes = 0;
    let partIndex = 0;
    const pending = new Set();
    try {
      for await (const chunk of readAssetChunks(asset, chunkBytes)) {
        const currentIndex = partIndex;
        partIndex += 1;
        readBytes += chunk.length;
        let request;
        request = this.appendAssetChunk(session, { key, chunk, partIndex: currentIndex })
          .then(() => {
            transferredBytes += chunk.length;
            this.status("asset-transfer-progress", {
              key,
              chunkBytes,
              concurrency,
              ...transferProgressDetail(mode, transferredBytes, size)
            });
          })
          .finally(() => pending.delete(request));
        pending.add(request);
        if (pending.size >= concurrency) await Promise.race(pending);
      }
      await Promise.all(pending);
      if (readBytes !== size) throw new Error("大型视频读取长度与扫描结果不一致");
      await this.finalizeAssetTransfer(session, { key, size });
      this.status("asset-transfer-complete", {
        key,
        chunkBytes,
        concurrency,
        ...transferProgressDetail(mode, size, size)
      });
    } catch (error) {
      await Promise.allSettled([...pending]);
      throw error;
    }
  }

  async transferAsset(session, asset) {
    const key = String(asset?.key || "");
    const size = Number(asset?.size ?? asset?.bytes?.length);
    if (!key || !Number.isSafeInteger(size) || size <= 0) {
      throw new TypeError("invalid renderer asset descriptor");
    }
    if (!Buffer.isBuffer(asset.bytes) && (typeof asset.filePath !== "string" || !asset.filePath)) {
      throw new TypeError("renderer asset requires bytes or filePath");
    }
    if (await this.hasRendererAsset(session, key, size)) {
      this.status("asset-transfer-complete", {
        key,
        cached: true,
        chunkBytes: 0,
        concurrency: 0,
        ...transferProgressDetail("fast", size, size)
      });
      return;
    }

    try {
      await this.transferAssetAttempt(session, asset, {
        mode: "fast",
        chunkBytes: FAST_ASSET_CHUNK_BYTES,
        concurrency: FAST_ASSET_CONCURRENCY,
        startType: "asset-transfer-start"
      });
      return;
    } catch (fastError) {
      await this.cleanupAssetTransfer(session, key);
      const fallbackProgress = transferProgressDetail("compatibility", 0, size);
      this.status("asset-transfer-fallback", {
        key,
        chunkBytes: FALLBACK_ASSET_CHUNK_BYTES,
        concurrency: FALLBACK_ASSET_CONCURRENCY,
        reason: fastError.message,
        ...fallbackProgress,
        message: `高速传输失败，切换兼容模式 · ${fallbackProgress.message}`
      });
      try {
        await this.transferAssetAttempt(session, asset, {
          mode: "compatibility",
          chunkBytes: FALLBACK_ASSET_CHUNK_BYTES,
          concurrency: FALLBACK_ASSET_CONCURRENCY,
          startType: null
        });
      } catch (fallbackError) {
        await this.cleanupAssetTransfer(session, key);
        throw new Error(
          `大型视频高速传输失败（${fastError.message}），兼容模式也失败（${fallbackError.message}）`
        );
      }
    }
  }

  async installScript(session, injectionValue, { updateReloadHook = true } = {}) {
    const { script, assets } = normalizeInjection(injectionValue);
    if (!script) return;
    const timeoutMs = scriptCommandTimeout(script);
    for (const asset of assets) await this.transferAsset(session, asset);
    if (updateReloadHook && session.newDocumentId) {
      await session.socket.call("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: session.newDocumentId
      }).catch(() => {});
      session.newDocumentId = null;
    }
    if (updateReloadHook && this.installOnNewDocument) {
      const installed = await session.socket.call(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: script },
        timeoutMs
      );
      session.newDocumentId = installed.identifier || null;
    }
    const result = await session.socket.call(
      "Runtime.evaluate",
      {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      },
      timeoutMs
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Renderer injection failed");
  }

  async rehydrateSession(session) {
    if (!this.running || !this.sessions.has(session.target.id) || session.rehydrating) return;
    session.rehydrating = this.installScript(
      session,
      { script: this.script, assets: this.assets },
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
    this.script = injection.script;
    this.assets = injection.assets;
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.installScript(session, injection))
    );
    const failed = results.filter((result) => result.status === "rejected");
    this.status("updated", { sessions: results.length, failed: failed.length });
    return { sessions: results.length, failed: failed.length };
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
      this.script = injection.script || this.script;
      this.assets = injection.assets;
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
    this.script = "";
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
