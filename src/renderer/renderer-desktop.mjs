const api = window.cwbDesktop;
const CONTROL_CHANNEL = "cwb-control";
const CONTROL_READY_TIMEOUT_MS = 10_000;
const CONTROL_FLUSH_TIMEOUT_MS = 7_000;
const WORKBENCH_THEME_KEY = "cwb.workbench.theme";

function savedWorkbenchTheme() {
  try { return window.localStorage.getItem(WORKBENCH_THEME_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}
const elements = {
  controlFrame: document.querySelector("#controlFrame"),
  controlPlaceholder: document.querySelector("#controlPlaceholder"),
  desktopTitlebar: document.querySelector("#desktopTitlebar"),
  desktopConnectionStatus: document.querySelector("#desktopConnectionStatus"),
};
if (api.windowChrome === true) elements.desktopTitlebar.hidden = false;
let titlebarThemeRevision = 0;
const state = {
  installations: [],
  selectedId: null,
  port: 9335,
  adaptive: true,
  busy: false,
  feedback: "选择壁纸后，点击应用即可生效",
  feedbackTone: "idle",
  controlUrl: null,
  controlPort: null,
  controlReady: false,
  controlLoadPromise: null,
  requestSequence: 0,
  flushRequests: new Map(),
  workbenchTheme: savedWorkbenchTheme(),
};

function applyWorkbenchTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  state.workbenchTheme = theme;
  if (document.documentElement) document.documentElement.dataset.workbenchTheme = theme;
  try { window.localStorage.setItem(WORKBENCH_THEME_KEY, theme); } catch { /* Theme still works for this session. */ }
  if (api.windowChrome === true) {
    const revision = ++titlebarThemeRevision;
    void api.setWorkbenchTheme(theme).then(
      result => { if (revision === titlebarThemeRevision) document.documentElement.dataset.titlebarThemeSync = result.supported ? "ready" : "unsupported"; },
      () => { if (revision === titlebarThemeRevision) document.documentElement.dataset.titlebarThemeSync = "failed"; },
    );
  }
}
applyWorkbenchTheme(state.workbenchTheme);

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("CDP 端口必须在 1024 到 65535 之间");
  }
  return port;
}

function trustedControlUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("壁纸工作台地址不是受信任的本机回环地址");
  }
  return parsed.href;
}

function setTitlebarConnection(connection) {
  if (api.windowChrome !== true) return;
  const labels = { connecting: "正在连接本地服务", connected: "本地服务已连接", disconnected: "本地服务连接已断开", error: "本地服务连接失败" };
  elements.desktopConnectionStatus.dataset.state = connection;
  elements.desktopConnectionStatus.textContent = labels[connection];
}

function showPlaceholder(title, detail, connection = "connecting") {
  elements.controlPlaceholder.hidden = false;
  elements.controlPlaceholder.querySelector("strong").textContent = title;
  elements.controlPlaceholder.querySelector("p").textContent = detail;
  setTitlebarConnection(connection);
}

function desktopPayload() {
  return {
    installations: state.installations,
    selectedId: state.selectedId,
    port: state.port,
    adaptive: state.adaptive,
    busy: state.busy,
    feedback: state.feedback,
    feedbackTone: state.feedbackTone,
    workbenchTheme: state.workbenchTheme,
  };
}

function postToControl(message) {
  if (!state.controlUrl || !elements.controlFrame.contentWindow) return;
  elements.controlFrame.contentWindow.postMessage(
    { channel: CONTROL_CHANNEL, ...message },
    new URL(state.controlUrl).origin,
  );
}

function sendDesktopState() {
  postToControl({ type: "desktop-state", state: desktopPayload() });
}

function updateDesktopState(payload = {}) {
  state.installations = payload.installations || state.installations;
  state.selectedId = payload.selectedId || state.installations[0]?.id || null;
  if (Number.isInteger(payload.port)) state.port = payload.port;
  if (typeof payload.adaptive === "boolean") state.adaptive = payload.adaptive;
  sendDesktopState();
}

function setFeedback(message, tone = "idle") {
  state.feedback = message;
  state.feedbackTone = tone;
  sendDesktopState();
}

function loadControlFrame(url, forceReload = false) {
  const themedUrl = new URL(url);
  themedUrl.searchParams.set("workbenchTheme", state.workbenchTheme);
  const frameUrl = themedUrl.href;
  state.controlReady = false;
  showPlaceholder("正在连接壁纸工作台", "配置、目标应用和应用操作都将在同一页完成。");
  if (forceReload && elements.controlFrame.src === frameUrl) {
    elements.controlFrame.src = "about:blank";
    window.setTimeout(() => { elements.controlFrame.src = frameUrl; }, 0);
  } else {
    elements.controlFrame.src = frameUrl;
  }
}

async function ensureControlPanel({ port = state.port, forceReload = false } = {}) {
  const desiredPort = normalizePort(port);
  if (!forceReload && state.controlReady && state.controlPort === desiredPort) return state.controlUrl;
  if (state.controlLoadPromise) return state.controlLoadPromise;

  state.controlLoadPromise = (async () => {
    const result = await api.openControlPanel({ port: desiredPort });
    if (!result?.ok) throw new Error(result?.message || "壁纸工作台启动失败");
    const url = trustedControlUrl(result.url);
    const shouldReload = forceReload || state.controlUrl !== url || state.controlPort !== desiredPort;
    state.controlUrl = url;
    state.controlPort = desiredPort;
    if (shouldReload || !state.controlReady) loadControlFrame(url, shouldReload);
    return url;
  })();

  try {
    return await state.controlLoadPromise;
  } catch (error) {
    state.controlReady = false;
    showPlaceholder("壁纸工作台载入失败", error.message, "error");
    throw error;
  } finally {
    state.controlLoadPromise = null;
  }
}

async function waitForControlReady() {
  const deadline = Date.now() + CONTROL_READY_TIMEOUT_MS;
  while (!state.controlReady && Date.now() < deadline) await delay(50);
  if (!state.controlReady) throw new Error("壁纸工作台尚未就绪，请稍后重试");
}

async function flushControlSettings() {
  if (!state.controlUrl) await ensureControlPanel();
  await waitForControlReady();
  const requestId = `flush-${Date.now()}-${++state.requestSequence}`;
  const result = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.flushRequests.delete(requestId);
      reject(new Error("等待壁纸设置保存超时"));
    }, CONTROL_FLUSH_TIMEOUT_MS);
    state.flushRequests.set(requestId, { resolve, reject, timer });
  });
  postToControl({ action: "flush-config", requestId });
  return result;
}

function selectedHostLabel(installationId = state.selectedId) {
  const entry = state.installations.find((item) => item.id === installationId);
  if (entry?.hostType === "antigravity" || /(?:^|[\\/])antigravity\.exe$/i.test(String(entry?.path || ""))) {
    return "Antigravity";
  }
  return entry ? "Codex" : "目标应用";
}

async function applyCodex(payload = {}) {
  const selectedId = payload.installationId || state.selectedId;
  const selectedPort = normalizePort(payload.port ?? state.port);
  const adaptive = payload.adaptive !== false;
  if (!selectedId) throw new Error("请选择目标应用");
  state.selectedId = selectedId;
  state.port = selectedPort;
  state.adaptive = adaptive;
  const hostName = selectedHostLabel(selectedId);

  setFeedback("正在保存壁纸设置…", "busy");
  await flushControlSettings();
  setFeedback(`正在应用到 ${hostName}…`, "busy");
  const result = await api.applyCodex({ installationId: selectedId, port: selectedPort, adaptive });
  if (result?.canceled) setFeedback(result.message || `已取消，${hostName} 未被关闭`, "idle");
  else if (result?.ok) setFeedback(result.message || `已应用到 ${hostName}`, "success");
  else setFeedback(result?.message || "应用失败，详情已写入本地日志", "error");

  if (selectedPort !== state.controlPort) {
    await ensureControlPanel({ port: selectedPort, forceReload: true });
  }
  return result;
}

async function restoreOfficialAppearance(payload = {}) {
  const selectedPort = normalizePort(payload.port ?? state.port);
  setFeedback("正在恢复官方外观…", "busy");
  const result = await api.restore({ installationId: payload.installationId || state.selectedId, port: selectedPort });
  if (result?.ok) setFeedback("已恢复官方外观", "success");
  else setFeedback(result?.message || "恢复失败，详情已写入本地日志", "error");
  return result;
}

async function executeDesktopAction(action, payload = {}) {
  if (state.busy) return { ok: false, message: "当前操作尚未完成，请稍候" };
  state.busy = true;
  sendDesktopState();
  try {
    if (action === "apply") {
      state.selectedId = payload.installationId || state.selectedId;
      state.port = normalizePort(payload.port ?? state.port);
      state.adaptive = payload.adaptive !== false;
    }
    if (action === "refresh-installations") {
      const result = await api.refreshInstallations();
      updateDesktopState(result);
      setFeedback(`已发现 ${result.installations?.length || 0} 个可用目标`, "success");
      return { ok: true, ...result };
    }
    if (action === "choose-executable") {
      const result = await api.chooseExecutable();
      updateDesktopState(result);
      setFeedback("本地 EXE 列表已更新", "success");
      return { ok: true, ...result };
    }
    if (action === "apply") return await applyCodex(payload);
    if (action === "restore") return await restoreOfficialAppearance(payload);
    throw new Error(`不支持的桌面操作：${action}`);
  } catch (error) {
    setFeedback(error.message || "操作失败，详情已写入本地日志", "error");
    return { ok: false, message: error.message || String(error) };
  } finally {
    state.busy = false;
    sendDesktopState();
  }
}

async function handleDesktopRequest(message) {
  const result = await executeDesktopAction(message.action, message.payload);
  postToControl({ type: "desktop-response", requestId: message.requestId, result });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== elements.controlFrame.contentWindow || message?.channel !== CONTROL_CHANNEL) return;
  if (state.controlUrl && event.origin !== new URL(state.controlUrl).origin) return;

  if (message.type === "workbench-theme" && state.controlUrl) {
    if (message.theme !== "light" && message.theme !== "dark") return;
    applyWorkbenchTheme(message.theme);
    // A UI preference must not redraw/reset unsaved Codex target or port controls.
    return;
  }

  if (message.type === "ready") {
    state.controlReady = true;
    setTitlebarConnection("connected");
    elements.controlPlaceholder.hidden = true;
    sendDesktopState();
    return;
  }
  if (message.type === "desktop-request" && typeof message.requestId === "string") {
    void handleDesktopRequest(message);
    return;
  }
  if (message.type !== "flush-complete" || typeof message.requestId !== "string") return;
  const pending = state.flushRequests.get(message.requestId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  state.flushRequests.delete(message.requestId);
  if (message.ok) pending.resolve(message);
  else pending.reject(new Error(message.message || "壁纸设置保存失败"));
});

api.onTrayAction((action) => {
  if (action === "control-disconnected") {
    state.controlReady = false;
    showPlaceholder("壁纸工作台连接已断开", "正在尝试重新连接…", "disconnected");
    void ensureControlPanel({ port: state.port, forceReload: true }).catch(() => {});
    return;
  }
  if (action === "apply") void executeDesktopAction("apply", {
    installationId: state.selectedId,
    port: state.port,
    adaptive: state.adaptive,
  });
  if (action === "restore") void executeDesktopAction("restore", { port: state.port });
});

window.addEventListener("unhandledrejection", (event) => {
  setFeedback(event.reason?.message || String(event.reason), "error");
});

async function initialize() {
  try {
    updateDesktopState(await api.getState());
    await ensureControlPanel({ port: state.port });
  } catch (error) {
    showPlaceholder("壁纸工作台启动失败", error.message, "error");
  }
}

void initialize();
