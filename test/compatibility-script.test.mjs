import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildCompatibilityRestoreScript,
  buildCompatibilityScript,
} from "../src/compatibility-script.mjs";

test("compatibility script covers current, Store-era, and hashed shell hooks", () => {
  const script = buildCompatibilityScript({ adaptive: true });

  assert.match(script, /data-app-shell-left-panel-appearance/);
  assert.match(script, /data-app-shell-main-content-top-fade/);
  assert.match(script, /data-composer-placement/);
  assert.match(script, /_MainContent_/);
  assert.match(script, /_Sidebar_/);
  assert.match(script, /_TitleBar_/);
  assert.match(script, /bg-primary-soft/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /restoreAutoSubtree/);
  assert.match(script, /attributeFilter:\s*\["class"\]/);
  assert.match(script, /getComputedStyle/);
  assert.match(script, /data-cwb-electron-auto-clear/);
});

test("safe mode omits geometry based surface clearing", () => {
  const script = buildCompatibilityScript({ adaptive: false });

  assert.doesNotMatch(script, /getComputedStyle/);
  assert.match(script, /data-cwb-electron-compat/);
});

test("adaptive mode clears transparent Store surfaces that only blur their backdrop", async () => {
  const script = buildCompatibilityScript({ adaptive: true });
  const cdpClient = await readFile(new URL("../src/cdp-client.mjs", import.meta.url), "utf8");

  assert.match(script, /hasVisibleBackdropFilter/);
  assert.match(script, /style\.backdropFilter/);
  assert.match(script, /style\.webkitBackdropFilter/);
  assert.match(script, /element\.closest\("#codex-wallpaper-bridge-root"\)/);
  assert.match(cdpClient, /backdropFilter:\s*style\.backdropFilter/);
  assert.match(cdpClient, /webkitBackdropFilter:\s*style\.webkitBackdropFilter/);
  assert.match(cdpClient, /wallpaperMedia/);
  assert.match(cdpClient, /sourceKind/);
  assert.match(cdpClient, /videoWidth/);
});

test("adaptive script removes blur from a transparent full-screen Store shell", () => {
  const declarations = new Map();
  const storeShell = {
    id: "store-shell",
    className: "app-shell-surface",
    classList: { contains: () => false },
    style: {
      getPropertyValue: (property) => declarations.get(property)?.value || "",
      getPropertyPriority: (property) => declarations.get(property)?.priority || "",
      setProperty: (property, value, priority) => declarations.set(property, { value, priority }),
      removeProperty: (property) => declarations.delete(property),
    },
    matches: () => false,
    closest: () => null,
    getAttributeNames: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 }),
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelectorAll: () => [],
  };
  const styleElement = { id: "", textContent: "", remove: () => {} };
  const documentElement = { setAttribute: () => {}, removeAttribute: () => {} };
  const window = {};
  const context = {
    window,
    document: {
      documentElement,
      head: { append: () => {} },
      createElement: () => styleElement,
      getElementById: () => null,
      querySelectorAll: (selector) => selector === "body *" ? [storeShell] : [],
    },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    innerWidth: 1920,
    innerHeight: 1080,
    getComputedStyle: () => ({
      backgroundImage: "none",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backdropFilter: "blur(18px)",
      webkitBackdropFilter: "none",
    }),
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  runInNewContext(buildCompatibilityScript({ adaptive: true }), context);

  assert.deepEqual(declarations.get("backdrop-filter"), { value: "none", priority: "important" });
  assert.deepEqual(declarations.get("-webkit-backdrop-filter"), { value: "none", priority: "important" });
});

test("restore script removes style, markers, inline overrides, and runtime", () => {
  const script = buildCompatibilityRestoreScript();

  assert.match(script, /restore\(\)/);
  assert.match(script, /codex-wallpaper-electron-compat-style/);
  assert.match(script, /delete window\.__codexWallpaperElectronCompat/);
});
