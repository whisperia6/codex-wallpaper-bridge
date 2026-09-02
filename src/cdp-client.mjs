import { WebSocket } from "ws";

const CDP_HOST = "127.0.0.1";
const TARGET_SCORE_THRESHOLD = 10;
const PROBE_EXPRESSION = `(() => {
  const semanticSelectors = [
    "[data-app-shell-left-panel-appearance]",
    "[data-app-shell-application-menu-bar]",
    "[data-app-shell-main-surface]",
    "[data-app-shell-main-content-top-fade]",
    "[data-ds-part]",
    "[data-pip-obstacle=\\"app-shell-header\\"]"
  ];
  const composerSelectors = [
    "[data-composer-placement]",
    "[data-composer-surface-variant]",
    "[data-above-composer-portal]"
  ];
  return {
    href: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    hasRoot: Boolean(document.querySelector("#root")),
    semanticHookCount: semanticSelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
    composerHookCount: composerSelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
    descendantCount: document.querySelectorAll("body *").length
  };
})()`;
const DIAGNOSTIC_EXPRESSION = `(() => {
  const viewportArea = Math.max(1, innerWidth * innerHeight);
  const surfaces = [];
  for (const element of document.querySelectorAll("body *")) {
    if (surfaces.length >= 40) break;
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < viewportArea * 0.08) continue;
    const style = getComputedStyle(element);
    const hasBackground = style.backgroundImage !== "none" || !/rgba?\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(style.backgroundColor);
    const hasBackdropFilter = [style.backdropFilter, style.webkitBackdropFilter]
      .some((value) => Boolean(value && value !== "none"));
    if (!hasBackground && !hasBackdropFilter) continue;
    surfaces.push({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      dataAttributes: [...element.attributes].map(({ name }) => name).filter((name) => name.startsWith("data-")).slice(0, 12),
      classTokens: [...element.classList].filter((token) => /shell|surface|panel|sidebar|header|title|main|thread|composer|fade/i.test(token)).slice(0, 8),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      backgroundColor: style.backgroundColor,
      hasBackgroundImage: style.backgroundImage !== "none",
      backdropFilter: style.backdropFilter || "none",
      webkitBackdropFilter: style.webkitBackdropFilter || "none"
    });
  }
  const mediaFrame = document.getElementById("codex-wallpaper-bridge-media");
  const media = mediaFrame?.tagName === "IFRAME"
    ? mediaFrame.contentDocument?.getElementById("cwb-media")
    : mediaFrame;
  const mediaSource = String(media?.currentSrc || media?.src || "");
  const mediaStyle = media ? getComputedStyle(media) : null;
  const wallpaperMedia = media ? {
    frameTag: mediaFrame?.tagName.toLowerCase() || null,
    tag: media.tagName.toLowerCase(),
    sourceKind: mediaSource.startsWith("blob:")
      ? "blob"
      : mediaSource.startsWith("data:") ? "data" : mediaSource ? "other" : "empty",
    readyState: Number(media.readyState ?? 0),
    paused: typeof media.paused === "boolean" ? media.paused : null,
    videoWidth: Number(media.videoWidth ?? 0),
    videoHeight: Number(media.videoHeight ?? 0),
    naturalWidth: Number(media.naturalWidth ?? 0),
    naturalHeight: Number(media.naturalHeight ?? 0),
    filter: mediaStyle?.filter || "none"
  } : null;
  return { viewport: { width: innerWidth, height: innerHeight }, wallpaperMedia, surfaces };
})()`;

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 5_000) {
    const socket = new WebSocket(this.url, { handshakeTimeout: timeoutMs });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败"));
      else pending.resolve(message.result || {});
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    });
  }

  call(method, params = {}, timeoutMs = 20_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 连接尚未建立"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

export function isAuxiliaryTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return true;
  return /initialRoute=.*(?:avatar|pet|overlay)/i.test(String(target.url || ""));
}

export function scoreCodexTarget(target, probe = {}) {
  if (isAuxiliaryTarget(target)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (/^app:\/\//i.test(String(target.url || ""))) score += 5;
  if (/codex/i.test(String(target.title || ""))) score += 3;
  if (probe.hasRoot) score += 3;
  score += Math.min(6, Math.max(0, Number(probe.semanticHookCount) || 0));
  score += Math.min(3, Math.max(0, Number(probe.composerHookCount) || 0) * 2);
  if ((Number(probe.descendantCount) || 0) >= 200) score += 2;
  return score;
}

export function selectCodexTargets(entries, threshold = TARGET_SCORE_THRESHOLD) {
  return entries
    .map((entry) => ({ ...entry, score: scoreCodexTarget(entry.target, entry.probe) }))
    .filter((entry) => entry.score >= threshold);
}

function endpoint(port) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) {
    throw new Error("CDP 端口无效");
  }
  return `http://${CDP_HOST}:${normalizedPort}`;
}

async function fetchJson(url, timeoutMs = 3_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`);
  return response.json();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluate(connection, expression) {
  const response = await connection.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "renderer 执行失败");
  }
  return response.result?.value;
}

export async function inspectCodexTargets(port, { includeSurfaces = false } = {}) {
  const targets = await fetchJson(`${endpoint(port)}/json/list`);
  const entries = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (isAuxiliaryTarget(target)) continue;
    const connection = new CdpConnection(target.webSocketDebuggerUrl);
    try {
      await connection.connect();
      const probe = await evaluate(connection, PROBE_EXPRESSION);
      const diagnostics = includeSurfaces ? await evaluate(connection, DIAGNOSTIC_EXPRESSION) : undefined;
      entries.push({ target, probe, diagnostics });
    } catch (error) {
      entries.push({ target, probe: {}, error: error.message });
    } finally {
      connection.close();
    }
  }
  return selectCodexTargets(entries);
}

export async function evaluateInCodexTargets(port, expression) {
  const selected = await inspectCodexTargets(port);
  if (selected.length === 0) throw new Error(`127.0.0.1:${port} 没有匹配的 Codex renderer`);
  const results = [];
  for (const entry of selected) {
    const connection = new CdpConnection(entry.target.webSocketDebuggerUrl);
    try {
      await connection.connect();
      const value = await evaluate(connection, expression);
      results.push({ targetId: entry.target.id, title: entry.target.title, url: entry.target.url, ok: true, value });
    } catch (error) {
      results.push({ targetId: entry.target.id, title: entry.target.title, url: entry.target.url, ok: false, error: error.message });
    } finally {
      connection.close();
    }
  }
  if (results.every((result) => !result.ok)) {
    throw new Error(results.map((result) => result.error).filter(Boolean).join("；") || "兼容层注入失败");
  }
  return results;
}

export async function collectCdpDiagnostics(port) {
  const [browser, targets] = await Promise.all([
    fetchJson(`${endpoint(port)}/json/version`),
    inspectCodexTargets(port, { includeSurfaces: true }),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    endpoint: endpoint(port),
    browser: {
      Browser: browser.Browser,
      ProtocolVersion: browser["Protocol-Version"],
      UserAgent: browser["User-Agent"],
      V8Version: browser["V8-Version"],
      WebKitVersion: browser["WebKit-Version"],
    },
    targets: targets.map(({ target, probe, diagnostics, score, error }) => ({
      id: target.id,
      titleMatchesCodex: /codex/i.test(String(target.title || "")),
      type: target.type,
      url: target.url,
      score,
      probe,
      diagnostics,
      error,
    })),
  };
}

export async function isCdpEndpointReady(port) {
  try {
    const version = await fetchJson(`${endpoint(port)}/json/version`, 1_500);
    return Boolean(version.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

export async function waitForCodexTarget(port, {
  timeoutMs = 30_000,
  intervalMs = 500,
  inspectTargets = inspectCodexTargets,
  delayFn = delay,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("等待 Codex renderer 的超时时间无效");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5_000) {
    throw new Error("等待 Codex renderer 的轮询间隔无效");
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const targets = await inspectTargets(port);
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await delayFn(intervalMs);
  } while (Date.now() < deadline);
  const suffix = lastError?.message ? `：${lastError.message}` : "";
  throw new Error(`Codex 已启动，但 ${timeoutMs / 1000} 秒内 renderer 未就绪${suffix}`);
}
