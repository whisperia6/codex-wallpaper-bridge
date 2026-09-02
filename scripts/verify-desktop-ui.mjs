import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const debuggerPort = Number(process.argv[2] || 9450);
const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(here, "..", "out", "desktop-ui-smoke.png");
const compactOutputPath = path.resolve(here, "..", "out", "desktop-ui-smoke-compact.png");
const docsOverviewPath = path.resolve(here, "..", "docs", "images", "desktop-overview.png");
const docsCompactPath = path.resolve(here, "..", "docs", "images", "desktop-compact.png");
async function waitForTargets() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`).then((response) => response.json());
    const mainTarget = targets.find(({ type, url }) => type === "page" && url.includes("/renderer/index.html"));
    const controlTarget = targets.find(({ type, url }) => type === "iframe" && url.startsWith("http://127.0.0.1:"));
    if (mainTarget && controlTarget) return { mainTarget, controlTarget };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("未找到 Electron 主窗口或内嵌壁纸面板 CDP target");
}

const { mainTarget, controlTarget } = await waitForTargets();

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression, { awaitPromise = false } = {}) {
  const response = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "页面脚本执行失败");
  return response.result.value;
}

const main = await connect(mainTarget);
const control = await connect(controlTarget);
try {
  const mainState = await evaluate(main, `(() => ({
    title: document.title,
    width: innerWidth,
    height: innerHeight,
    browserWindowsInDom: document.querySelectorAll('#controlFrame').length,
    controlUrl: document.querySelector('#controlFrame')?.src,
    placeholderHidden: document.querySelector('#controlPlaceholder')?.hidden,
    legacyPanels: document.querySelectorAll('.control-column,.action-panel,.log-panel').length
  }))()`);
  const controlState = await evaluate(control, `(() => ({
    embedded: document.documentElement.dataset.cwbDesktopEmbedded,
    desktopBarVisible: !document.querySelector('#desktopTargetBar')?.hidden,
    targetCount: document.querySelector('#desktopInstallationSelect')?.options.length || 0,
    selectedTarget: document.querySelector('#desktopInstallationSelect')?.value || null,
    port: document.querySelector('#desktopPortInput')?.value,
    adaptive: document.querySelector('#desktopAdaptiveInput')?.checked,
    applyLabel: document.querySelector('#desktopApplyButton')?.textContent.trim(),
    applyStatus: document.querySelector('#desktopApplyStatus')?.textContent.trim(),
    saveText: document.querySelector('#saveIndicator')?.textContent.trim(),
    selectedTitle: document.querySelector('.wallpaper-card[aria-selected="true"] .wallpaper-card__title')?.textContent.trim() || null,
    injectDisplay: getComputedStyle(document.querySelector('#injectButton')).display,
    restoreDisplay: getComputedStyle(document.querySelector('#restoreButton')).display,
    video: (() => {
      const element = document.querySelector('#backgroundVideo');
      return {
        src: element?.currentSrc || element?.src || '',
        readyState: element?.readyState ?? null,
        paused: element?.paused ?? null,
        display: element ? getComputedStyle(element).display : null
      };
    })()
  }))()`);

  await evaluate(control, `(() => {
    const input = document.querySelector('#brightnessRange');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  const handshake = await evaluate(main, `(async () => {
    const frame = document.querySelector('#controlFrame');
    const origin = new URL(frame.src).origin;
    const requestId = 'smoke-' + Date.now();
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('save handshake timeout')), 7000);
      const listener = (event) => {
        if (event.source !== frame.contentWindow || event.origin !== origin) return;
        if (event.data?.channel !== 'cwb-control' || event.data?.type !== 'flush-complete') return;
        if (event.data.requestId !== requestId) return;
        clearTimeout(timer);
        removeEventListener('message', listener);
        resolve({ ...event.data, elapsedMs: Math.round(performance.now() - startedAt) });
      };
      addEventListener('message', listener);
      frame.contentWindow.postMessage({ channel: 'cwb-control', action: 'flush-config', requestId }, origin);
    });
  })()`, { awaitPromise: true });

  const invalidPort = await evaluate(control, `(async () => {
    const port = document.querySelector('#desktopPortInput');
    port.value = '1';
    document.querySelector('#desktopApplyButton').click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const status = document.querySelector('#desktopApplyStatus')?.textContent.trim() || '';
      if (status.includes('1024 到 65535')) {
        return {
          status,
          tone: document.querySelector('#desktopApplyStatus')?.dataset.tone,
          applyDisabled: document.querySelector('#desktopApplyButton')?.disabled
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('invalid port response timeout');
  })()`, { awaitPromise: true });

  const desktopRequest = await evaluate(control, `(async () => {
    document.querySelector('#desktopRefreshButton').click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = document.querySelector('#desktopApplyStatus')?.textContent.trim() || '';
      if (status.startsWith('已发现')) {
        return {
          status,
          tone: document.querySelector('#desktopApplyStatus')?.dataset.tone,
          targetCount: document.querySelector('#desktopInstallationSelect')?.options.length || 0
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('desktop request timeout');
  })()`, { awaitPromise: true });

  const screenshot = await main.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  await writeFile(docsOverviewPath, Buffer.from(screenshot.data, "base64"));
  await evaluate(main, "window.resizeTo(1040, 700)");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const compactState = await evaluate(control, `(() => {
    const bar = document.querySelector('#desktopTargetBar');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      bar: { clientWidth: bar?.clientWidth, scrollWidth: bar?.scrollWidth },
      overflowing: Boolean(bar && bar.scrollWidth > bar.clientWidth),
      applyVisible: document.querySelector('#desktopApplyButton')?.getBoundingClientRect().right <= innerWidth
    };
  })()`);
  const compactScreenshot = await main.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(compactOutputPath, Buffer.from(compactScreenshot.data, "base64"));
  await writeFile(docsCompactPath, Buffer.from(compactScreenshot.data, "base64"));
  await evaluate(main, "window.resizeTo(1540, 900)");
  console.log(JSON.stringify({
    mainState,
    controlState,
    handshake,
    invalidPort,
    desktopRequest,
    compactState,
    screenshots: [outputPath, compactOutputPath, docsOverviewPath, docsCompactPath],
  }, null, 2));
} finally {
  main.close();
  control.close();
}
