const api = window.cwbDesktop;
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
};

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

function appendLog(entry) {
  const text = String(entry?.text || "");
  if (!text) return;
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

function renderInstallations(payload) {
  state.installations = payload.installations || [];
  state.selectedId = payload.selectedId || state.installations[0]?.id || null;
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
    elements.noticeDetail.textContent = "可直接选择 Store 版；本地 EXE 仍会作为独立目标保留。";
  } else {
    elements.noticeTitle.textContent = "当前电脑未检测到 Store 包";
    elements.noticeDetail.textContent = "本机可验证本地 EXE；请在另一台 Store 电脑运行并导出兼容诊断。";
  }
  setStatus(`已发现 ${state.installations.length} 个安装目标`, "ready");
}

async function refreshInstallations(useInitialState = false) {
  setBusy(true, "正在检测安装");
  try {
    const payload = useInitialState ? await api.getState() : await api.refreshInstallations();
    renderInstallations(payload);
  } catch (error) {
    setStatus("检测失败", "error");
    appendLog({ stream: "stderr", text: `${error.message}\n` });
  } finally {
    setBusy(false);
    elements.launchButton.disabled = !state.selectedId;
  }
}

async function runAction(label, action) {
  if (state.busy) return;
  setBusy(true, label);
  try {
    const result = await action();
    if (result?.ok) {
      setStatus(result.message || `${label}完成`, "ready");
      if (result.diagnosticPath) {
        state.diagnosticPath = result.diagnosticPath;
        elements.diagnosticPathButton.hidden = false;
        elements.diagnosticPathButton.textContent = `诊断文件：${result.diagnosticPath}`;
      }
      if (result.warnings?.length) appendLog({ stream: "system", text: `警告：${result.warnings.join("；")}\n` });
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
elements.launchButton.addEventListener("click", () => runAction("启动并自动注入", () => api.launchCodex({
  installationId: state.selectedId,
  port: port(),
  adaptive: elements.adaptiveInput.checked,
})));
elements.controlPanelButton.addEventListener("click", () => runAction("打开壁纸设置", () => api.openControlPanel({ port: port() })));
elements.injectButton.addEventListener("click", () => runAction("一次性注入", () => api.injectOnce({
  port: port(),
  adaptive: elements.adaptiveInput.checked,
})));
elements.restoreButton.addEventListener("click", () => runAction("恢复官方外观", () => api.restore({ port: port() })));
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
window.addEventListener("unhandledrejection", (event) => {
  appendLog({ stream: "stderr", text: `${event.reason?.message || event.reason}\n` });
});
void refreshInstallations(true);
