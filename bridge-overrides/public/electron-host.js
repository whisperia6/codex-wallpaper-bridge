(() => {
  const CHANNEL = "cwb-control";
  const CONFIG_QUIET_MS = 360;
  const FLUSH_TIMEOUT_MS = 5_000;
  const pendingWrites = new Set();
  let lastMutationAt = 0;

  function notify(type, detail = {}) {
    if (window.parent === window) return;
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
          throw new Error("右侧壁纸设置保存失败，请重试后再注入");
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    throw new Error("壁纸设置保存超时，请确认控制页没有显示“保存失败”");
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || message?.channel !== CHANNEL) return;
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
