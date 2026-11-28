import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, runInNewContext } from "node:vm";

const rendererSource = await readFile(new URL("../src/renderer/renderer-desktop.mjs", import.meta.url), "utf8");
export const controlUrl = "http://127.0.0.1:12345/abcdefghijklmnopqrstuv/";
const turn = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));

export async function desktopRendererHarness(context, { apply, applyResult, restoreResult, storage = new Map(), url = controlUrl, desktopState } = {}) {
  const messages = [];
  const listeners = new Map();
  const timers = new Set();
  const calls = { apply: [], restore: [], open: 0 };
  const frame = {
    src: "",
    contentWindow: { postMessage: (message, origin) => messages.push({ message: copy(message), origin }) },
  };
  const placeholderNodes = { strong: { textContent: "" }, p: { textContent: "" } };
  const placeholder = { hidden: false, querySelector: (selector) => placeholderNodes[selector] };
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    cwbDesktop: {
      getState: async () => desktopState ?? ({ installations: [{ id: "isolated-codex" }], selectedId: "isolated-codex", port: 12345, adaptive: true }),
      getUpdateState: async () => ({ updateAvailable: false }),
      onUpdateState: () => {},
      openControlPanel: async () => { calls.open += 1; return { ok: true, url }; },
      applyCodex: (options) => {
        calls.apply.push(copy(options));
        return apply?.(options) ?? applyResult?.promise ?? Promise.resolve({ ok: true, message: "applied" });
      },
      restore: (options) => {
        calls.restore.push(copy(options));
        return restoreResult?.promise || Promise.resolve({ ok: true });
      },
      onTrayAction: () => {},
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    setTimeout: (callback, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
  };
  context.after(() => { for (const timer of timers) clearTimeout(timer); });
  const sandbox = createContext({
    window, URL,
    document: { querySelector: (selector) => selector === "#controlFrame" ? frame : placeholder },
  });
  runInContext(rendererSource, sandbox, { filename: "renderer-desktop.mjs" });
  await turn();
  const expectedUrl = new URL(url);
  expectedUrl.searchParams.set('workbenchTheme', storage.get('cwb.workbench.theme') || 'dark');
  assert.equal(frame.src, expectedUrl.href, "the actual renderer must seed the workbench theme before loading");

  function emit(message) {
    listeners.get("message")({
      source: frame.contentWindow, origin: new URL(url).origin,
      data: { channel: "cwb-control", ...message },
    });
  }
  emit({ type: "ready" });
  return {
    calls, messages, storage, frame,
    emitFrom: (source, origin, message) => listeners.get('message')({ source, origin, data: { channel:'cwb-control', ...message } }),
    snapshot: () => copy(runInContext("desktopPayload()", sandbox)),
    execute: (action, payload = {}) => {
      sandbox.actionInput = action;
      sandbox.payloadInput = payload;
      return runInContext("executeDesktopAction(actionInput, payloadInput)", sandbox);
    },
    flushes: () => messages.filter(({ message }) => message.action === "flush-config"),
    completeFlush: (ok, message) => {
      const request = messages.findLast(({ message: value }) => value.action === "flush-config");
      assert.ok(request, "the actual renderer must request a save handshake");
      emit({ type: "flush-complete", requestId: request.message.requestId, ok, message });
    },
    emit,
  };
}

export async function embeddedHostHarness({ saving = false, error = false, controls = {} } = {}) {
  const source = await readFile(new URL('../bridge-overrides/public/electron-host.js', import.meta.url), 'utf8');
  const handlers = {};
  const messages = [];
  const fetches = [];
  const requests = [];
  let time = 1000;
  const indicator = { classList: { contains: (name) => name === 'is-saving' ? saving : name === 'is-error' ? error : false } };
  const window = {
    parent: { postMessage: (value, origin) => messages.push({ ...value, _targetOrigin: origin }) }, location: { href: 'http://127.0.0.1:30000/secret/' },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    setTimeout: (callback, duration) => { time += duration; queueMicrotask(callback); }, clearTimeout() {},
    fetch: (...args) => { requests.push(args); return new Promise((resolve) => fetches.push(resolve)); },
  };
  const documentHandlers = {};
  class Element { closest(selector) { this.selector = selector; return true; } }
  const document = { documentElement: { dataset: {} }, head: { append() {} }, createElement: () => ({}),
    addEventListener(name, handler) { documentHandlers[name] = handler; }, querySelector: (selector) => selector === '#saveIndicator' ? indicator : controls[selector] ?? null };
  runInNewContext(source, { window, document, URL, Date: { now: () => time }, Element, MutationObserver: class { observe() {} }, Set, Map });
  async function flush(id) {
    handlers.message({ source: window.parent, origin: 'cwb-desktop://shell', data: { channel: 'cwb-control', action: 'flush-config', requestId: id } });
    for (let count = 0; count < 600; count++) {
      if (messages.some((item) => item.type === 'flush-complete' && item.requestId === id)) break;
      await Promise.resolve();
    }
    return messages.find((item) => item.type === 'flush-complete' && item.requestId === id);
  }
  return { window, messages, fetches, requests, flush, documentHandlers, handlers, Element };
}

export function embeddedTargetControls() {
  function control() {
    const events = {};
    return { events, dataset: {}, classList: { toggle() {} }, addEventListener: (name, fn) => { events[name] = fn; }, replaceChildren() {}, append() {}, querySelector() {} };
  }
  return Object.fromEntries(['#desktopTargetBar', '#desktopInstallationSelect', '#desktopRefreshButton', '#desktopChooseButton',
    '#desktopPortInput', '#desktopAdaptiveInput', '#desktopRestoreButton', '#desktopApplyButton', '#desktopApplyStatus'].map((selector) => [selector, control()]));
}
