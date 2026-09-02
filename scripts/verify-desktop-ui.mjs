import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const debuggerPort = Number(process.argv[2] || 9450);
const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(here, "..", "out", "desktop-ui-smoke.png");
const targets = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`).then((response) => response.json());
const mainTarget = targets.find(({ type, url }) => type === "page" && url.includes("/src/renderer/index.html"));
const controlTarget = targets.find(({ type, url }) => type === "iframe" && url.startsWith("http://127.0.0.1:"));
if (!mainTarget || !controlTarget) throw new Error("未找到 Electron 主窗口或内嵌壁纸面板 CDP target");

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
    controlState: document.querySelector('#controlState')?.textContent.trim(),
    controlTone: document.querySelector('#controlState')?.dataset.tone,
    placeholderHidden: document.querySelector('#controlPlaceholder')?.hidden,
    launchLabel: document.querySelector('#launchButton')?.textContent.trim()
  }))()`);
  const controlState = await evaluate(control, `(() => ({
    embedded: document.documentElement.dataset.cwbDesktopEmbedded,
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

  const screenshot = await main.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ mainState, controlState, handshake, screenshot: outputPath }, null, 2));
} finally {
  main.close();
  control.close();
}
