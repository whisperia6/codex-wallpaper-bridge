(() => {
  if (window.parent === window) return;

  const CHANNEL = "cwb-control";
  const CONFIG_QUIET_MS = 360;
  const FLUSH_TIMEOUT_MS = 5_000;
  const DESKTOP_REQUEST_TIMEOUT_MS = 190_000;
  const pendingWrites = new Set();
  const desktopRequests = new Map();
  let lastMutationAt = 0;
  let requestSequence = 0;
  let latestDesktopState = null;

  function notify(type, detail = {}) {
    window.parent.postMessage({ channel: CHANNEL, type, ...detail }, "*");
  }

  function isConfigWrite(input, init = {}) {
    const rawUrl = typeof input === "string" ? input : input?.url;
    const method = String(init.method || input?.method || "GET").toUpperCase();
    if (method !== "POST" || !rawUrl) return false;
    try {
      return new URL(rawUrl, window.location.href).pathname.endsWith("/api/config");
    } catch {
      return false;
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const request = originalFetch(input, init);
    if (!isConfigWrite(input, init)) return request;

    pendingWrites.add(request);
    notify("saving", { pending: pendingWrites.size });
    const settle = () => {
      pendingWrites.delete(request);
      if (pendingWrites.size === 0) notify("saved", { pending: 0 });
    };
    request.then(settle, settle);
    return request;
  };

  function markMutation(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(
      ".wallpaper-card,#brightnessRange,#darknessRange,#blurRange,#saturationRange,#fitSelect,#playbackToggle,#resetEffectsButton",
    )) return;
    lastMutationAt = Date.now();
    notify("dirty");
  }

  async function waitForConfigQuiet() {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - lastMutationAt;
      if (pendingWrites.size === 0 && quietFor >= CONFIG_QUIET_MS) {
        const saveIndicator = document.querySelector("#saveIndicator");
        if (saveIndicator?.classList.contains("is-error")) {
          throw new Error("壁纸设置保存失败，请重试后再应用");
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    throw new Error("壁纸设置保存超时，请确认控制页没有显示“保存失败”");
  }

  function requestDesktop(action, payload = {}) {
    const requestId = `desktop-${Date.now()}-${++requestSequence}`;
    const response = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        desktopRequests.delete(requestId);
        reject(new Error("桌面操作等待超时，详情请查看本地日志"));
      }, DESKTOP_REQUEST_TIMEOUT_MS);
      desktopRequests.set(requestId, { resolve, reject, timer });
    });
    notify("desktop-request", { requestId, action, payload });
    return response;
  }

  function controls() {
    return {
      bar: document.querySelector("#desktopTargetBar"),
      status: document.querySelector("#desktopApplyStatus"),
      installation: document.querySelector("#desktopInstallationSelect"),
      refresh: document.querySelector("#desktopRefreshButton"),
      choose: document.querySelector("#desktopChooseButton"),
      port: document.querySelector("#desktopPortInput"),
      adaptive: document.querySelector("#desktopAdaptiveInput"),
      restore: document.querySelector("#desktopRestoreButton"),
      apply: document.querySelector("#desktopApplyButton"),
    };
  }

  function setStatus(message, tone = "idle") {
    const element = controls().status;
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function installationLabel(installation) {
    const running = installation.isRunning ? " · 正在运行" : "";
    return `${installation.label} · ${installation.version}${running}`;
  }

  function renderDesktopState(state) {
    latestDesktopState = state;
    const elements = controls();
    if (!elements.bar) return;
    elements.bar.hidden = false;

    const currentValue = state.selectedId || "";
    elements.installation.replaceChildren();
    if (!state.installations?.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未检测到 Codex，请选择本地 EXE";
      elements.installation.append(option);
    } else {
      for (const installation of state.installations) {
        const option = document.createElement("option");
        option.value = installation.id;
        option.textContent = installationLabel(installation);
        option.title = installation.path;
        elements.installation.append(option);
      }
      elements.installation.value = currentValue;
    }
    elements.port.value = String(state.port || 9335);
    elements.adaptive.checked = state.adaptive !== false;
    setStatus(state.feedback || "选择壁纸后应用到 Codex", state.feedbackTone || "idle");

    const disabled = Boolean(state.busy);
    elements.installation.disabled = disabled;
    elements.refresh.disabled = disabled;
    elements.choose.disabled = disabled;
    elements.port.disabled = disabled;
    elements.adaptive.disabled = disabled;
    elements.restore.disabled = disabled;
    elements.apply.disabled = disabled || !currentValue;
    elements.apply.classList.toggle("is-busy", disabled);
    elements.apply.querySelector("span").textContent = disabled ? "正在处理" : "应用到 Codex";
  }

  function currentPayload() {
    const elements = controls();
    return {
      installationId: elements.installation.value || latestDesktopState?.selectedId || null,
      port: Number(elements.port.value),
      adaptive: elements.adaptive.checked,
    };
  }

  async function runControlAction(action, payload) {
    try {
      const result = await requestDesktop(action, payload);
      if (!result?.ok && !result?.canceled) setStatus(result?.message || "操作失败", "error");
      return result;
    } catch (error) {
      setStatus(error.message, "error");
      return { ok: false, message: error.message };
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || message?.channel !== CHANNEL) return;

    if (message.type === "desktop-state" && message.state) {
      renderDesktopState(message.state);
      return;
    }
    if (message.type === "desktop-response" && typeof message.requestId === "string") {
      const pending = desktopRequests.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      desktopRequests.delete(message.requestId);
      pending.resolve(message.result);
      return;
    }
    if (message.action !== "flush-config" || typeof message.requestId !== "string") return;
    waitForConfigQuiet().then(
      () => notify("flush-complete", { requestId: message.requestId, ok: true }),
      (error) => notify("flush-complete", {
        requestId: message.requestId,
        ok: false,
        message: error.message,
      }),
    );
  });

  document.addEventListener("input", markMutation, true);
  document.addEventListener("change", markMutation, true);
  document.addEventListener("click", markMutation, true);
  document.documentElement.dataset.cwbDesktopEmbedded = "true";

  const style = document.createElement("style");
  style.textContent = "#injectButton,#restoreButton{display:none!important}";
  document.head.append(style);

  window.addEventListener("DOMContentLoaded", () => {
    const elements = controls();
    elements.bar.hidden = false;
    elements.refresh.addEventListener("click", () => void runControlAction("refresh-installations"));
    elements.choose.addEventListener("click", () => void runControlAction("choose-executable"));
    elements.apply.addEventListener("click", () => void runControlAction("apply", currentPayload()));
    elements.restore.addEventListener("click", () => void runControlAction("restore", currentPayload()));

    const saveIndicator = document.querySelector("#saveIndicator");
    if (saveIndicator) {
      const observer = new MutationObserver(() => {
        if (saveIndicator.classList.contains("is-error")) notify("save-error");
      });
      observer.observe(saveIndicator, { attributes: true, childList: true, subtree: true });
    }
    notify("ready");
  }, { once: true });
})();
