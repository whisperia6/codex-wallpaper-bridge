import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { buildApplyScript, buildBootstrapScript, buildRestoreScript } from "../bridge-overrides/src/injected-renderer.mjs";

const borderSides = ["top", "right", "bottom", "left"].map((side) => `border-${side}-color`);
const marginSides = ["top", "right", "bottom", "left"].map((side) => `margin-${side}`);
const shorthands = new Map([["border-color", borderSides], ["margin", marginSides]]);
const bridgeRootId = "codex-wallpaper-bridge-root";

function createRenderer({ sendMessageFromView } = {}) {
  const observers = [];
  const timers = new Map();
  let nextTimer = 0;
  const writeLog = [];
  let deliveries = 0;
  let runaway = false;

  function emit(record) {
    for (const observer of observers) {
      const { target, options } = observer;
      if (target !== record.target && !(options?.subtree && target?.contains(record.target))) continue;
      const watched = record.type === "childList"
        ? options.childList
        : options.attributes && options.attributeFilter.includes(record.attributeName);
      if (!watched || runaway) continue;
      observer.records.push(record);
      if (observer.queued) continue;
      observer.queued = true;
      queueMicrotask(() => {
        observer.queued = false;
        const records = observer.takeRecords();
        if (records.length === 0 || runaway) return;
        // Let a broken runtime fail the assertion instead of hanging node --test.
        if (++deliveries > 60) {
          runaway = true;
          return;
        }
        observer.callback(records);
      });
    }
  }

  class MutationObserver {
    records = [];
    queued = false;
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    takeRecords() {
      return this.records.splice(0);
    }
    disconnect() {
      this.target = null;
      this.takeRecords();
    }
  }

  class Style {
    declarations = new Map();
    constructor(element) {
      this.element = element;
    }
    key(property) {
      return property === "-webkit-backdrop-filter" ? "backdrop-filter" : property;
    }
    *[Symbol.iterator]() {
      yield* this.declarations.keys();
    }
    get cssText() {
      const serialized = [];
      const emitted = new Set();
      for (const [property, { value, priority, pending }] of this.declarations) {
        const suffix = priority ? " !important" : "";
        if (pending) {
          const [shorthand] = [...shorthands].find(([, sides]) => sides.includes(property));
          if (!emitted.has(shorthand) && this.getPropertyValue(shorthand) === pending) {
            serialized.push(`${shorthand}: ${pending}${suffix};`);
            emitted.add(shorthand);
          }
        } else {
          serialized.push(`${property}: ${value}${suffix};`);
        }
      }
      return serialized.join(" ");
    }
    set cssText(value) {
      this.reset(value);
    }
    reset(cssText) {
      this.declarations.clear();
      for (const declaration of cssText.split(";").map((part) => part.trim()).filter(Boolean)) {
        const [property, value] = declaration.split(":").map((part) => part.trim());
        const priority = value.endsWith(" !important") ? "important" : "";
        this.setProperty(property, priority ? value.slice(0, -" !important".length) : value, priority);
      }
    }
    getPropertyValue(property) {
      const sides = shorthands.get(property);
      if (sides) {
        const pending = sides.map((side) => this.declarations.get(side)?.pending);
        if (pending[0] && pending.every((value) => value === pending[0])) return pending[0];
        const values = sides.map((side) => this.getPropertyValue(side));
        if (values.includes("") || new Set(sides.map((side) => this.getPropertyPriority(side))).size > 1) return "";
        return new Set(values).size === 1 ? values[0] : values.join(" ");
      }
      return this.declarations.get(this.key(property))?.value ?? "";
    }
    getPropertyPriority(property) {
      return this.declarations.get(this.key(property))?.priority ?? "";
    }
    setProperty(property, value, priority = "") {
      const normalized = value.replace(/,\s+/g, ",");
      const sides = shorthands.get(property);
      const pending = sides && normalized.startsWith("var(");
      for (const key of sides || [this.key(property)]) {
        const declaration = pending ? { value: "", priority, pending: normalized } : { value: normalized, priority };
        this.declarations.set(key, declaration);
      }
      writeLog.push({ element: this.element, property });
      this.element.changed("style");
    }
    removeProperty(property) {
      for (const key of shorthands.get(property) || [this.key(property)]) {
        if (this.declarations.delete(key)) this.element.changed("style");
      }
    }
  }

  class Element {
    nodeType = 1;
    children = [];
    dataset = {};
    attributes = new Map();
    style = new Style(this);
    classes = new Set();
    classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled) => {
        if (enabled === this.classes.has(name)) return;
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        this.changed("class");
      }
    };
    changed(attributeName) {
      emit({ type: "attributes", target: this, attributeName });
    }
    hasAttribute(name) {
      return this.attributes.has(name);
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
      if (name === "style") this.style.reset(value);
      this.changed(name);
    }
    removeAttribute(name) {
      if (this.attributes.delete(name)) this.changed(name);
    }
    insertBefore(element, sibling) {
      element.parentNode = this;
      this.children.splice(sibling ? this.children.indexOf(sibling) : this.children.length, 0, element);
      emit({ type: "childList", target: this, addedNodes: [element], removedNodes: [] });
    }
    appendChild(element) {
      this.insertBefore(element, null);
    }
    get firstChild() {
      return this.children[0];
    }
    remove() {
      const target = this.parentNode;
      target.children.splice(target.children.indexOf(this), 1);
      this.parentNode = null;
      emit({ type: "childList", target, addedNodes: [], removedNodes: [this] });
    }
    contains(element) {
      return this === element || this.children.some((child) => child.contains(element));
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null;
    }
    matches(selector) {
      return selector.split(", ").some((part) =>
        (part.startsWith("#") && part.slice(1) === this.id) ||
        (part.startsWith("aside:is(") && this.getAttribute("data-ds-part") === "sidebar") ||
        (part.startsWith("header:is(") && this.getAttribute("data-ds-part") === "header")
      );
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const html = new Element();
  const body = new Element();
  const head = new Element();
  html.appendChild(head);
  html.appendChild(body);
  const document = {
    documentElement: html, body, head,
    createElement: () => new Element(),
    getElementById: (id) => html.querySelector(`#${id}`),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    addEventListener() {},
    removeEventListener() {}
  };
  const storage = new Map();
  const listeners = new Map();
  const ctx = createContext({
    document, MutationObserver, AbortController, queueMicrotask, performance,
    electronBridge: sendMessageFromView && {
      sendMessageFromView(message) {
        return sendMessageFromView(message, (body) => {
          for (const listener of listeners.get("message") || []) {
            listener({ data: { type: "fetch-response", requestId: message.requestId, body } });
          }
        });
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    setTimeout(callback) {
      const timer = ++nextTimer;
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    }
  });
  return {
    html, body, document, MutationObserver, writeLog, timers,
    get activeObservers() { return observers.filter((observer) => observer.target).length; },
    get deliveries() { return deliveries; },
    get runaway() { return runaway; },
    async runNextTimer() {
      assert.equal(timers.size, 1);
      const [timer, callback] = timers.entries().next().value;
      await delay(0);
      timers.delete(timer);
      callback();
      await delay(0);
    },
    run: (script) => runInContext(script, ctx)
  };
}

test("frosted shell repairs host style changes once and restores original inline declarations", async () => {
  const renderer = createRenderer();
  const { body, document, writeLog } = renderer;
  const cssProbe = document.createElement("aside").style;
  cssProbe.setProperty("border-color", "transparent", "important");
  cssProbe.setProperty("border-right-color", "rgba(255, 255, 255, 0.07)", "important");
  assert.equal(cssProbe.getPropertyValue("border-color"), "transparent rgba(255,255,255,0.07) transparent transparent");

  const sidebar = document.createElement("aside");
  sidebar.setAttribute("data-ds-part", "sidebar");
  sidebar.style.setProperty("border-color", "red");
  sidebar.style.setProperty("border-right-color", "blue", "important");
  sidebar.style.setProperty("background-color", "white", "important");
  sidebar.style.setProperty("-webkit-backdrop-filter", "blur(4px)");
  const original = new Map(sidebar.style.declarations);
  body.appendChild(sidebar);
  await renderer.run(buildBootstrapScript());
  const firstApplyWrite = writeLog.length;
  await renderer.run(buildApplyScript());
  assert.equal(sidebar.style.getPropertyValue("border-top-color"), "transparent");
  assert.equal(sidebar.style.getPropertyValue("border-right-color"), "transparent");
  assert.equal(sidebar.style.getPropertyValue("background-color"), "var(--cwb-sidebar-fill)");
  assert.equal(sidebar.style.getPropertyValue("box-shadow"), "var(--cwb-sidebar-shadow)");
  assert.deepEqual(writeLog.slice(firstApplyWrite).filter(({ element, property }) => element === sidebar && property === "border-color"), []);

  sidebar.style.setProperty("padding", "4px");
  sidebar.style.setProperty("border-right-color", "green");
  sidebar.style.setProperty("border-right-color", "yellow");
  sidebar.setAttribute("class", "updated");
  const firstRepairWrite = writeLog.length;
  await delay(0);
  assert.equal(sidebar.style.getPropertyValue("border-right-color"), "yellow");
  const beforeRepair = renderer.deliveries;
  await renderer.runNextTimer();
  assert.deepEqual(writeLog.slice(firstRepairWrite).filter(({ element }) => element === sidebar).map(({ property }) => property), ["border-right-color"]);
  assert.equal(renderer.deliveries, beforeRepair);
  assert.equal(sidebar.style.getPropertyValue("border-right-color"), "transparent");
  assert.equal(renderer.runaway, false);

  // Removing the bridge root schedules a remount without observing the remount itself.
  document.getElementById(bridgeRootId).remove();
  await delay(0);
  const beforeRemount = renderer.deliveries;
  await renderer.runNextTimer();
  assert.ok(document.getElementById(bridgeRootId));
  assert.equal(renderer.deliveries, beforeRemount);

  sidebar.style.setProperty("border-right-color", "lime");
  await delay(0);
  assert.equal(renderer.timers.size, 1);
  assert.equal((await renderer.run(buildRestoreScript())).ok, true);
  original.set("padding", { value: "4px", priority: "" });
  assert.deepEqual(sidebar.style.declarations, original);
  assert.equal(renderer.timers.size, 0);
});

test("restore preserves a var() shorthand whose original longhands were not serializable", async () => {
  const renderer = createRenderer();
  const sidebar = renderer.document.createElement("aside");
  sidebar.setAttribute("data-ds-part", "sidebar");
  sidebar.setAttribute("style", "border-color: var(--host-border); padding: 4px; margin: 2px");
  assert.equal(sidebar.style.getPropertyValue("border-right-color"), "");
  renderer.body.appendChild(sidebar);

  await renderer.run(buildBootstrapScript());
  await renderer.run(buildApplyScript());
  assert.equal(sidebar.style.getPropertyValue("border-top-color"), "transparent");
  sidebar.style.setProperty("padding", "6px");
  sidebar.style.removeProperty("margin");
  await renderer.run(buildRestoreScript());
  assert.equal(sidebar.style.getPropertyValue("border-color"), "var(--host-border)");
  assert.equal(sidebar.style.getPropertyValue("padding"), "6px");
  assert.equal(sidebar.style.getPropertyValue("margin"), "");
});

test("restore preserves a host var() shorthand added while wallpaper is active", async () => {
  const renderer = createRenderer();
  const sidebar = renderer.document.createElement("aside");
  sidebar.setAttribute("data-ds-part", "sidebar");
  sidebar.setAttribute("style", "border-color: var(--edge)");
  renderer.body.appendChild(sidebar);

  await renderer.run(buildBootstrapScript());
  await renderer.run(buildApplyScript());
  sidebar.style.setProperty("margin", "var(--gap)", "important");
  assert.equal(sidebar.style.getPropertyValue("margin-top"), "");

  await renderer.run(buildRestoreScript());
  assert.equal(sidebar.style.getPropertyValue("border-color"), "var(--edge)");
  assert.equal(sidebar.style.getPropertyValue("margin"), "var(--gap)");
  for (const side of marginSides) assert.equal(sidebar.style.getPropertyPriority(side), "important");
});

test("apply racing with theme restoration cannot restart the disposed runtime", async () => {
  let finishRestore;
  const renderer = createRenderer({ sendMessageFromView(message, respond) {
    if (message.url.endsWith("/get-setting")) {
      respond({ value: "light" });
      return;
    }
    const { value } = JSON.parse(message.body);
    if (value === "dark") {
      renderer.html.setAttribute("data-theme", value);
      respond(null);
      return;
    }
    finishRestore = () => {
      renderer.html.setAttribute("data-theme", value);
      respond(null);
    };
  } });
  renderer.html.setAttribute("data-theme", "light");
  await renderer.run(buildBootstrapScript());
  await renderer.run(buildApplyScript());

  const restoration = renderer.run(buildRestoreScript());
  await delay(0);
  assert.equal(typeof finishRestore, "function");
  const overlappingApply = renderer.run("globalThis.__codexWallpaperBridgeRuntime.apply({})");
  const replacement = renderer.run(buildBootstrapScript());
  finishRestore();
  await delay(0);
  await renderer.runNextTimer();
  assert.equal((await restoration).ok, true);
  const applyResult = await overlappingApply;
  assert.equal(renderer.document.getElementById(bridgeRootId), null);
  assert.equal(renderer.timers.size, 0);
  assert.equal(renderer.activeObservers, 0);
  assert.equal(applyResult.ok, false);

  assert.equal((await replacement).ready, true);
  await renderer.run(buildApplyScript());
  assert.ok(renderer.document.getElementById(bridgeRootId));
});

test("a late host settings failure after preserveTheme cannot restart theme observation", async () => {
  const darkSetting = Promise.withResolvers();
  let switching = false;
  const renderer = createRenderer({ sendMessageFromView(message, respond) {
    if (message.url.endsWith("/get-setting")) {
      respond({ value: "light" });
      return;
    }
    switching = true;
    return darkSetting.promise;
  } });
  renderer.html.setAttribute("data-theme", "light");
  await renderer.run(buildBootstrapScript());
  const preparation = renderer.run("globalThis.__codexWallpaperBridgeRuntime.prepareTheme()");
  await delay(0);
  assert.equal(switching, true);
  await renderer.run("globalThis.__codexWallpaperBridgeRuntime.restore({ preserveTheme: true })");
  assert.equal(renderer.timers.size, 0);
  darkSetting.reject(new Error("Host rejected dark mode"));
  await preparation;
  assert.equal(renderer.html.getAttribute("data-theme"), "light");
  assert.equal(renderer.activeObservers, 0);

  renderer.html.setAttribute("class", "updated");
  await delay(0);
  assert.equal(renderer.timers.size, 0);
});

test("a failed host theme read only changes the DOM and preserves the system preference", async () => {
  let hostTheme = "system";
  const hostWrites = [];
  const renderer = createRenderer({ sendMessageFromView(message, respond) {
    if (message.url.endsWith("/get-setting")) {
      return Promise.reject(new Error("Host settings are not ready"));
    }
    const { value } = JSON.parse(message.body);
    hostWrites.push(value);
    hostTheme = value;
    renderer.html.setAttribute("data-theme", value);
    respond(null);
  } });
  renderer.html.setAttribute("data-theme", "light");
  await renderer.run(buildBootstrapScript());

  const theme = await renderer.run("globalThis.__codexWallpaperBridgeRuntime.prepareTheme()");
  assert.equal(theme.state, "dark-fallback");
  assert.equal(theme.originalTheme, null);
  assert.equal(renderer.html.getAttribute("data-theme"), "dark");
  assert.equal(renderer.run('localStorage.getItem("__codexWallpaperBridgeOriginalThemeV1")'), null);

  const restoration = await renderer.run(buildRestoreScript());
  assert.equal(restoration.ok, true);
  assert.equal(renderer.html.getAttribute("data-theme"), "light");
  assert.equal(hostTheme, "system");
  assert.deepEqual(hostWrites, []);
});

test("fallback theme coalesces corrections and yields to a competing host observer", async () => {
  const renderer = createRenderer();
  const { html } = renderer;
  const setLight = () => {
    html.setAttribute("data-theme", "light");
    html.classList.toggle("electron-dark", false);
    html.classList.toggle("electron-light", true);
  };
  setLight();
  html.style.setProperty("color-scheme", "light", "important");
  await renderer.run(buildBootstrapScript());
  const applied = await renderer.run(buildApplyScript());
  assert.equal(applied.theme.state, "dark-fallback");
  assert.equal(html.getAttribute("data-theme"), "dark");

  setLight();
  html.setAttribute("class", "updated");
  await delay(0);
  assert.equal(html.getAttribute("data-theme"), "light");
  const beforeCorrection = renderer.deliveries;
  await renderer.runNextTimer();
  assert.equal(html.getAttribute("data-theme"), "dark");
  assert.equal(renderer.deliveries, beforeCorrection);
  await renderer.runNextTimer();

  let hostCorrections = 0;
  const host = new renderer.MutationObserver(() => {
    if (html.getAttribute("data-theme") !== "dark") return;
    hostCorrections += 1;
    setLight();
  });
  host.observe(html, { attributes: true, attributeFilter: ["data-theme", "class"] });
  setLight();
  await delay(0);
  await renderer.runNextTimer();
  await renderer.runNextTimer();
  assert.equal(hostCorrections, 1);
  assert.equal(html.getAttribute("data-theme"), "light");
  assert.equal(renderer.timers.size, 0);
  assert.equal(renderer.runaway, false);
  host.disconnect();
  assert.equal((await renderer.run(buildRestoreScript())).ok, true);
  assert.equal(html.getAttribute("data-theme"), "light");
  assert.equal(html.classList.contains("electron-light"), true);
  assert.equal(html.classList.contains("electron-dark"), false);
  assert.equal(html.style.getPropertyValue("color-scheme"), "light");
  assert.equal(html.style.getPropertyPriority("color-scheme"), "important");
});
