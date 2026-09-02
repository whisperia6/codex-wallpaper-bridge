const api = window.cwbDesktop;
const CONTROL_CHANNEL = "cwb-control";
const CONTROL_READY_TIMEOUT_MS = 10_000;
const CONTROL_FLUSH_TIMEOUT_MS = 7_000;
const elements = {
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  noticeTitle: document.querySelector("#noticeTitle"),
  noticeDetail: document.querySelector("#noticeDetail"),
  installationSelect: document.querySelector("#installationSelect"),
  portInput: document.querySelector("#portInput"),
  adaptiveInput: document.querySelector("#adaptiveInput"),
  refreshButton: document.querySelector("#refreshButton"),
  chooseExecutableButton: document.querySelector("#chooseExecutableButton"),
  launchButton: document.querySelector("#launchButton"),
  controlPanelButton: document.querySelector("#controlPanelButton"),
  injectButton: document.querySelector("#injectButton"),
  restoreButton: document.querySelector("#restoreButton"),
  diagnoseButton: document.querySelector("#diagnoseButton"),
  diagnosticPathButton: document.querySelector("#diagnosticPathButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  logOutput: document.querySelector("#logOutput"),
  controlState: document.querySelector("#controlState"),
  controlPlaceholder: document.querySelector("#controlPlaceholder"),
  controlFrame: document.querySelector("#controlFrame"),
};
const actionButtons = [
  elements.refreshButton,
  elements.chooseExecutableButton,
  elements.launchButton,
  elements.controlPanelButton,
  elements.injectButton,
  elements.restoreButton,
  elements.diagnoseButton,
];
const state = {
  installations: [],
  selectedId: null,
  busy: false,
  logs: [],
  diagnosticPath: null,
  controlUrl: null,
  controlPort: null,
  controlReady: false,
  controlLoadPromise: null,
  controlRequestSequence: 0,
  flushRequests: new Map(),
  progressLogBuffer: "",
};

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function port() {
  const value = Number(elements.portInput.value);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("CDP 端口必须在 1024 到 65535 之间");
  }
  return value;
}

function setStatus(text, tone = "idle") {
  elements.statusText.textContent = text;
  elements.statusPill.dataset.tone = tone;
}

function setControlState(text, tone = "loading") {
  elements.controlState.querySelector("span").textContent = text;
  elements.controlState.dataset.tone = tone;
}

function showControlPlaceholder(title, detail) {
  elements.controlPlaceholder.hidden = false;
  elements.controlPlaceholder.querySelector("strong").textContent = title;
  elements.controlPlaceholder.querySelector("p").textContent = detail;
}

function consumeTransferProgress(text) {
  state.progressLogBuffer += text;
  const lines = state.progressLogBuffer.split(/\r?\n/);
  state.progressLogBuffer = lines.pop() || "";
  if (state.progressLogBuffer.length > 2_048) {
    state.progressLogBuffer = state.progressLogBuffer.slice(-2_048);
  }

  for (const line of lines) {
    const match = line.match(
      /\[CDP\] asset-transfer-(start|progress|fallback|complete)(?:[：:]\s*(.+))?$/
    );
    if (!match) continue;
    const [, phase, detail = ""] = match;
    if (phase === "fallback") {
      setStatus(`视频注入 · ${detail || "高速传输失败，正在切换兼容模式"}`, "busy");
    } else if (phase === "complete") {
      setStatus(`视频注入完成 · ${detail}`, "busy");
    } else {
      setStatus(`视频注入 · ${detail}`, "busy");
    }
  }
}

function appendLog(entry) {
  const text = String(entry?.text || "");
  if (!text) return;
  consumeTransferProgress(text);
  state.logs.push({ stream: entry.stream || "system", text });
  if (state.logs.length > 220) state.logs.splice(0, state.logs.length - 220);
  elements.logOutput.textContent = state.logs.map(({ stream, text: line }) => {
    const prefix = stream === "stderr" ? "[ERROR] " : stream === "system" ? "[SYSTEM] " : "";
    return `${prefix}${line}`;
  }).join("");
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function setBusy(isBusy, label = "") {
  state.busy = isBusy;
  for (const button of actionButtons) button.disabled = isBusy;
  elements.installationSelect.disabled = isBusy;
  elements.portInput.disabled = isBusy;
  elements.adaptiveInput.disabled = isBusy;
  if (isBusy) setStatus(label || "正在执行", "busy");
}

function installationLabel(installation) {
  const running = installation.isRunning ? " · 正在运行" : "";
  return `${installation.label} · ${installation.version}${running}`;
}

function renderInstallations(payload, { applyPreferences = false } = {}) {
  state.installations = payload.installations || [];
  state.selectedId = payload.selectedId || state.installations[0]?.id || null;
  if (applyPreferences) {
    if (Number.isInteger(payload.port)) elements.portInput.value = String(payload.port);
    elements.adaptiveInput.checked = payload.adaptive !== false;
  }
  elements.installationSelect.replaceChildren();
  if (state.installations.length === 0) {
    const option = document.createElement("option");
    option.textContent = "未检测到 Codex，请选择本地 EXE";
    option.value = "";
    elements.installationSelect.append(option);
  } else {
    for (const installation of state.installations) {
      const option = document.createElement("option");
      option.value = installation.id;
      option.textContent = installationLabel(installation);
      option.title = installation.path;
      elements.installationSelect.append(option);
    }
    elements.installationSelect.value = state.selectedId;
  }
  elements.launchButton.disabled = state.busy || !state.selectedId;
  if (payload.hasStoreInstall) {
    elements.noticeTitle.textContent = "已检测到 Microsoft Store 版";
    elements.noticeDetail.textContent = "Store 与本地 EXE 共用同一壁纸设置、保存握手和注入流程。";
  } else {
    elements.noticeTitle.textContent = "当前电脑未检测到 Store 包";
    elements.noticeDetail.textContent = "本机可验证本地 EXE；关闭窗口后应用会驻留右下角托盘。";
  }
  setStatus(`已发现 ${state.installations.length} 个安装目标`, "ready");
}

async function refreshInstallations(useInitialState = false) {
  setBusy(true, "正在检测安装");
  try {
    const payload = useInitialState ? await api.getState() : await api.refreshInstallations();
    renderInstallations(payload, { applyPreferences: useInitialState });
  } catch (error) {
    setStatus("检测失败", "error");
    appendLog({ stream: "stderr", text: `${error.message}\n` });
  } finally {
    setBusy(false);
    elements.launchButton.disabled = !state.selectedId;
  }
}

function trustedControlUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("壁纸面板地址不是受信任的本机回环地址");
  }
  return parsed.href;
}

function loadControlFrame(url, forceReload) {
  state.controlReady = false;
  setControlState("正在连接", "loading");
  showControlPlaceholder("正在连接壁纸面板", "配置保存完成后，左侧注入按钮才会继续。 ");
  if (forceReload && elements.controlFrame.src === url) {
    elements.controlFrame.src = "about:blank";
    window.setTimeout(() => {
      elements.controlFrame.src = url;
    }, 0);
  } else {
    elements.controlFrame.src = url;
  }
}

async function ensureControlPanel({ forceReload = false } = {}) {
  const desiredPort = port();
  if (!forceReload && state.controlReady && state.controlPort === desiredPort) return state.controlUrl;
  if (state.controlLoadPromise) return state.controlLoadPromise;

  setControlState("正在启动", "loading");
  showControlPlaceholder("正在启动本地壁纸面板", "首次扫描 Wallpaper Engine 项目可能需要几秒。 ");
  state.controlLoadPromise = (async () => {
    const result = await api.openControlPanel({ port: desiredPort });
    if (!result?.ok) throw new Error(result?.message || "壁纸面板启动失败");
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
    setControlState("载入失败", "error");
    showControlPlaceholder("壁纸面板载入失败", error.message);
    throw error;
  } finally {
    state.controlLoadPromise = null;
  }
}

async function waitForControlReady() {
  const deadline = Date.now() + CONTROL_READY_TIMEOUT_MS;
  while (!state.controlReady && Date.now() < deadline) await delay(50);
  if (!state.controlReady) throw new Error("壁纸面板未就绪，请点击右上角“重新载入”后再试");
}

async function flushControlSettings() {
  await ensureControlPanel();
  await waitForControlReady();
  const requestId = `flush-${Date.now()}-${++state.controlRequestSequence}`;
  const targetOrigin = new URL(state.controlUrl).origin;
  if (!elements.controlFrame.contentWindow) throw new Error("壁纸面板窗口不可用，请重新载入");
  const result = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.flushRequests.delete(requestId);
      reject(new Error("等待壁纸设置保存超时，请确认右侧没有显示保存失败"));
    }, CONTROL_FLUSH_TIMEOUT_MS);
    state.flushRequests.set(requestId, { resolve, reject, timer });
  });
  elements.controlFrame.contentWindow.postMessage({
    channel: CONTROL_CHANNEL,
    action: "flush-config",
    requestId,
  }, targetOrigin);
  return result;
}

async function prepareInjection() {
  setStatus("正在等待壁纸设置保存", "busy");
  appendLog({ stream: "system", text: "正在确认右侧壁纸设置已写入磁盘…\n" });
  await flushControlSettings();
  appendLog({ stream: "system", text: "壁纸设置已保存，开始注入。\n" });
}

async function runAction(label, action) {
  if (state.busy) return;
  setBusy(true, label);
  try {
    const result = await action();
    if (result?.canceled) {
      setStatus("已取消，Codex 未被关闭", "ready");
    } else if (result?.ok) {
      setStatus(result.message || `${label}完成`, "ready");
      if (result.diagnosticPath) {
        state.diagnosticPath = result.diagnosticPath;
        elements.diagnosticPathButton.hidden = false;
        elements.diagnosticPathButton.textContent = `诊断文件：${result.diagnosticPath}`;
      }
      if (result.warnings?.length) {
        appendLog({ stream: "system", text: `警告：${result.warnings.join("；")}\n` });
      }
    } else {
      setStatus(result?.message || `${label}失败`, "error");
    }
  } catch (error) {
    setStatus(`${label}失败`, "error");
    appendLog({ stream: "stderr", text: `${error.message}\n` });
  } finally {
    setBusy(false);
    elements.launchButton.disabled = !state.selectedId;
  }
}

function launchAndInject() {
  return runAction("启动并自动注入", async () => {
    await prepareInjection();
    return api.launchCodex({
      installationId: state.selectedId,
      port: port(),
      adaptive: elements.adaptiveInput.checked,
    });
  });
}

function injectOnce() {
  return runAction("一次性注入", async () => {
    await prepareInjection();
    return api.injectOnce({
      port: port(),
      adaptive: elements.adaptiveInput.checked,
    });
  });
}

function restoreOfficialAppearance() {
  return runAction("恢复官方外观", () => api.restore({ port: port() }));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== elements.controlFrame.contentWindow || message?.channel !== CONTROL_CHANNEL) return;
  if (state.controlUrl && event.origin !== new URL(state.controlUrl).origin) return;

  if (message.type === "ready") {
    state.controlReady = true;
    elements.controlPlaceholder.hidden = true;
    setControlState("设置已就绪", "ready");
    return;
  }
  if (message.type === "dirty" || message.type === "saving") {
    setControlState("正在保存", "saving");
    return;
  }
  if (message.type === "saved") {
    setControlState("设置已保存", "ready");
    return;
  }
  if (message.type === "save-error") {
    setControlState("保存失败", "error");
    return;
  }
  if (message.type !== "flush-complete" || typeof message.requestId !== "string") return;
  const pending = state.flushRequests.get(message.requestId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  state.flushRequests.delete(message.requestId);
  if (message.ok) {
    setControlState("设置已同步", "ready");
    pending.resolve(message);
  } else {
    setControlState("保存失败", "error");
    pending.reject(new Error(message.message || "壁纸设置保存失败"));
  }
});

elements.controlFrame.addEventListener("load", () => {
  if (!state.controlUrl || elements.controlFrame.src === "about:blank") return;
  if (state.controlReady) return;
  setControlState("正在初始化", "loading");
});
elements.installationSelect.addEventListener("change", () => {
  state.selectedId = elements.installationSelect.value || null;
  elements.launchButton.disabled = !state.selectedId;
});
elements.refreshButton.addEventListener("click", () => refreshInstallations());
elements.chooseExecutableButton.addEventListener("click", () => runAction("选择本地 EXE", async () => {
  const payload = await api.chooseExecutable();
  renderInstallations(payload);
  return { ok: true, message: "已添加本地 EXE" };
}));
elements.launchButton.addEventListener("click", launchAndInject);
elements.controlPanelButton.addEventListener("click", () => runAction("重新载入壁纸面板", async () => {
  await ensureControlPanel({ forceReload: true });
  await waitForControlReady();
  return { ok: true, message: "壁纸面板已重新载入" };
}));
elements.injectButton.addEventListener("click", injectOnce);
elements.restoreButton.addEventListener("click", restoreOfficialAppearance);
elements.diagnoseButton.addEventListener("click", () => runAction("导出兼容诊断", () => api.exportDiagnostics({
  port: port(),
  installationId: state.selectedId,
})));
elements.diagnosticPathButton.addEventListener("click", () => {
  if (state.diagnosticPath) void api.revealDiagnostics(state.diagnosticPath);
});
elements.clearLogButton.addEventListener("click", () => {
  state.logs = [];
  elements.logOutput.textContent = "等待操作…";
});

api.onLog(appendLog);
api.onTrayAction((action) => {
  if (action === "control-disconnected") {
    state.controlReady = false;
    setControlState("连接已断开", "error");
    showControlPlaceholder("壁纸面板连接已断开", "点击“重新载入”恢复设置面板。 ");
    return;
  }
  if (action === "control") void ensureControlPanel({ forceReload: true });
  if (action === "launch") void launchAndInject();
  if (action === "inject") void injectOnce();
  if (action === "restore") void restoreOfficialAppearance();
});
window.addEventListener("unhandledrejection", (event) => {
  appendLog({ stream: "stderr", text: `${event.reason?.message || event.reason}\n` });
});

async function initialize() {
  await refreshInstallations(true);
  try {
    await ensureControlPanel();
  } catch (error) {
    appendLog({ stream: "stderr", text: `壁纸面板：${error.message}\n` });
  }
}

void initialize();
