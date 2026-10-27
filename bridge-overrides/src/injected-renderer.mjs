import { createMediaSwitcher, runMediaTransition } from "../../bridge-runtime/src/media-switch.mjs";
import { createEngineMediaTransport } from "../../bridge-runtime/src/engine-media-transport.mjs";
import { createDirectSceneTransport } from "../../bridge-runtime/src/direct-scene-transport.mjs";
import { createScenePreviewSlot } from "../../bridge-runtime/src/workbench-scene-preview.mjs";
import { readAuthorProperties, validateAuthorPropertyPatch } from "../../bridge-runtime/src/author-properties.mjs";
import { validateWebWallpaperInput } from "../../bridge-runtime/src/web-wallpaper-input.mjs";
import { resolvePlayback } from "../../bridge-runtime/src/playback-policy.mjs";

const GLOBAL_KEY = "__codexWallpaperBridgeRuntime";

function safePayload(payload) {
  return JSON.stringify(payload ?? {}).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function rendererBootstrap(createMediaSwitcher, runMediaTransition, createEngineMediaTransport,
  createDirectSceneTransport, createScenePreviewSlot, readAuthorProperties, validateAuthorPropertyPatch, validateWebWallpaperInput,
  resolvePlayback, nativeEnabled = false, directSceneEnabled = false) {
    // Page.addScriptToEvaluateOnNewDocument also runs in child frames. Author
    // origins must never receive the Codex bootstrap or its host capabilities.
    if (typeof location !== "undefined" && (location.origin !== "app://-" || globalThis.parent !== globalThis)) {
      return { ok: false, ready: false, version: null };
    }
    const KEY = "__codexWallpaperBridgeRuntime";
    const VERSION = "0.6.0-m3-media-policy-v4";
    let nativeController = null;
    let sceneController = null;

    const createRuntime = () => {
      const ids = {
        root: "codex-wallpaper-bridge-root",
        media: "codex-wallpaper-bridge-media",
        scrim: "codex-wallpaper-bridge-scrim",
        style: "codex-wallpaper-bridge-style"
      };
      let current = null;
      const nativeMedia = nativeEnabled && !directSceneEnabled ? createEngineMediaTransport(resolvePlayback) : null;
      const sceneMedia = directSceneEnabled ? createDirectSceneTransport(createScenePreviewSlot, readAuthorProperties, validateAuthorPropertyPatch, validateWebWallpaperInput, resolvePlayback) : null;
      if (nativeMedia) nativeController = { accept: nativeMedia.accept, fail: nativeMedia.fail, state: nativeMedia.state, retry: nativeMedia.retry, close: nativeMedia.close };
      let observer = null;
      let visibilityHandler = null;
      let currentMediaIdentity = null;
      let scenePreload = null;
      let lastMediaOperation = Promise.resolve({ ok: true });
      let mediaState = { state: "idle", at: performance.now() };
      const shellInlineState = new Map();
      const themeStorageKey = "__codexWallpaperBridgeOriginalThemeV1";
      const allowedThemes = new Set(["system", "light", "dark"]);
      let themeActivationPromise = null;
      let themeState = "idle";
      let fallbackThemeClasses = null;

      const createChunkAssembler = () => {
        const unset = Symbol("unset");
        let root = unset;
        let stringChunks = null;
        let stringTarget = null;
        const stack = [];

        const setKey = (key) => {
          const target = stack.at(-1);
          if (target?.type !== "object" || target.key !== null) {
            throw new Error("Invalid chunked message key");
          }
          target.key = key;
        };
        const saveValue = (value) => {
          const target = stack.at(-1);
          if (!target) {
            if (root !== unset) throw new Error("Chunked message has multiple roots");
            root = value;
            return;
          }
          if (target.type === "array") {
            target.value.push(value);
            return;
          }
          if (target.key === null) throw new Error("Chunked message object value has no key");
          Object.defineProperty(target.value, target.key, {
            configurable: true,
            enumerable: true,
            value,
            writable: true
          });
          target.key = null;
        };

        return {
          consume(tokens) {
            for (const token of tokens) {
              switch (token?.type) {
                case "array-start": {
                  const value = [];
                  saveValue(value);
                  stack.push({ type: "array", value });
                  break;
                }
                case "object-start": {
                  const value = {};
                  saveValue(value);
                  stack.push({ type: "object", value, key: null });
                  break;
                }
                case "container-end":
                  if (!stack.pop()) throw new Error("Unmatched chunked message container end");
                  break;
                case "key":
                  setKey(token.value);
                  break;
                case "value":
                  saveValue(token.value);
                  break;
                case "string-start":
                  if (stringChunks !== null) throw new Error("Nested chunked message string");
                  stringChunks = [];
                  stringTarget = token.target;
                  break;
                case "string-chunk":
                  if (stringChunks === null) throw new Error("Chunked string has no start");
                  stringChunks.push(token.value);
                  break;
                case "string-end": {
                  if (stringChunks === null || stringTarget === null) {
                    throw new Error("Chunked string has no start");
                  }
                  const value = stringChunks.join("");
                  const target = stringTarget;
                  stringChunks = null;
                  stringTarget = null;
                  if (target === "key") setKey(value);
                  else saveValue(value);
                  break;
                }
              }
            }
          },
          finish() {
            if (root === unset || stack.length || stringChunks !== null) {
              throw new Error("Incomplete chunked message");
            }
            return root;
          }
        };
      };

      const receiveChunk = (transfers, message) => {
        if (message?.marker !== "codex-host-chunked-message-v1") return message;
        const bridge = globalThis.electronBridge;
        try { bridge?.acknowledgeChunkedMessage?.(message.transferId, message.sequence); } catch {}
        if (message.kind === "start") {
          transfers.clear();
          transfers.set(message.transferId, {
            assembler: createChunkAssembler(),
            nextSequence: message.sequence + 1
          });
          return null;
        }
        const transfer = transfers.get(message.transferId);
        if (!transfer || message.sequence !== transfer.nextSequence) {
          transfers.delete(message.transferId);
          return null;
        }
        transfer.nextSequence += 1;
        if (message.kind === "chunk") {
          transfer.assembler.consume(message.tokens || []);
          return null;
        }
        transfers.delete(message.transferId);
        return transfer.assembler.finish();
      };

      const requestHostSetting = (operation, params, timeoutMs = 4_000) => {
        const bridge = globalThis.electronBridge;
        if (typeof bridge?.sendMessageFromView !== "function") {
          return Promise.reject(new Error("Codex host bridge is unavailable"));
        }
        const requestId = globalThis.crypto?.randomUUID?.() ||
          `cwb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const transfers = new Map();
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeEventListener("message", onMessage);
            callback(value);
          };
          const onMessage = (event) => {
            let message;
            try { message = receiveChunk(transfers, event.data); }
            catch (error) { finish(reject, error); return; }
            if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
            if (message.responseType === "error") {
              finish(reject, new Error(message.error || `Codex setting request failed (${message.status})`));
              return;
            }
            try {
              const body = Object.hasOwn(message, "body")
                ? message.body
                : JSON.parse(message.bodyJsonString || "null");
              finish(resolve, body);
            } catch (error) {
              finish(reject, error);
            }
          };
          const timer = setTimeout(
            () => finish(reject, new Error(`Codex ${operation} request timed out`)),
            timeoutMs
          );
          addEventListener("message", onMessage);
          Promise.resolve(bridge.sendMessageFromView({
            type: "fetch",
            requestId,
            method: "POST",
            url: `vscode://codex/${operation}`,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params)
          })).catch((error) => finish(reject, error));
        });
      };

      const effectiveTheme = () => document.documentElement.classList.contains("electron-dark")
        ? "dark"
        : "light";

      const readSavedTheme = () => {
        try {
          const saved = JSON.parse(localStorage.getItem(themeStorageKey) || "null");
          return saved && allowedThemes.has(saved.originalTheme) ? saved : null;
        } catch {
          return null;
        }
      };

      const saveOriginalTheme = (record) => {
        try { localStorage.setItem(themeStorageKey, JSON.stringify(record)); } catch {}
      };

      const removeSavedTheme = () => {
        try { localStorage.removeItem(themeStorageKey); } catch {}
      };

      const applyFallbackTheme = (theme) => {
        const html = document.documentElement;
        if (!fallbackThemeClasses) {
          fallbackThemeClasses = {
            dark: html.classList.contains("electron-dark"),
            light: html.classList.contains("electron-light")
          };
        }
        html.classList.toggle("electron-dark", theme === "dark");
        html.classList.toggle("electron-light", theme !== "dark");
      };

      const restoreFallbackTheme = () => {
        if (!fallbackThemeClasses) return;
        const html = document.documentElement;
        html.classList.toggle("electron-dark", fallbackThemeClasses.dark);
        html.classList.toggle("electron-light", fallbackThemeClasses.light);
        fallbackThemeClasses = null;
      };

      const waitForThemePaint = () => new Promise((resolve) => setTimeout(resolve, 80));

      const ensureDarkTheme = () => {
        if (themeActivationPromise) return themeActivationPromise;
        themeActivationPromise = (async () => {
          themeState = "reading";
          let saved = readSavedTheme();
          if (!saved) {
            let originalTheme;
            try {
              const result = await requestHostSetting("get-setting", { key: "appearanceTheme" });
              originalTheme = allowedThemes.has(result?.value) ? result.value : effectiveTheme();
            } catch {
              originalTheme = effectiveTheme();
            }
            saved = { originalTheme, effectiveTheme: effectiveTheme() };
            saveOriginalTheme(saved);
          }
          try {
            themeState = "switching";
            await requestHostSetting("set-setting", { key: "appearanceTheme", value: "dark" });
            restoreFallbackTheme();
            await waitForThemePaint();
            if (effectiveTheme() === "dark") themeState = "dark";
            else themeState = "dark-reload-required";
          } catch {
            applyFallbackTheme("dark");
            themeState = "dark-fallback";
          }
          return {
            state: themeState,
            originalTheme: saved.originalTheme,
            reloadRequired: themeState === "dark-reload-required"
          };
        })();
        return themeActivationPromise;
      };

      const restoreOriginalTheme = async () => {
        try { await themeActivationPromise; } catch {}
        const saved = readSavedTheme();
        if (!saved) {
          restoreFallbackTheme();
          themeState = "restored";
          return { state: themeState, originalTheme: null, reloadRequired: false };
        }
        try {
          themeState = "restoring";
          await requestHostSetting("set-setting", {
            key: "appearanceTheme",
            value: saved.originalTheme
          });
          restoreFallbackTheme();
          removeSavedTheme();
          await waitForThemePaint();
          const expectedTheme = saved.originalTheme === "system"
            ? (globalThis.electronBridge?.getSystemThemeVariant?.() || saved.effectiveTheme || "light")
            : saved.originalTheme;
          if (effectiveTheme() === expectedTheme) themeState = "restored";
          else themeState = "restore-reload-required";
        } catch {
          applyFallbackTheme(saved.effectiveTheme === "dark" ? "dark" : "light");
          themeState = "restore-fallback";
        }
        return {
          state: themeState,
          originalTheme: saved.originalTheme,
          reloadRequired: themeState === "restore-reload-required"
        };
      };

      const shellSelectors = {
        sidebar: 'aside:is(.app-shell-left-panel, [data-app-shell-left-panel-appearance], [data-ds-part="sidebar"])',
        header: 'header:is(.app-header-tint, [data-app-shell-application-menu-bar], [data-app-shell-header-edge-scroll], [data-pip-obstacle="app-shell-header"], [data-ds-part="header"], [class*="_Header_"])'
      };

      const shellInlineStyles = {
        sidebar: {
          "background-color": "transparent",
          "background-image": "none",
          "border-color": "transparent",
          "border-right-color": "transparent",
          "backdrop-filter": "none",
          "-webkit-backdrop-filter": "none",
          "box-shadow": "none"
        },
        header: {
          "background-color": "transparent",
          "background-image": "none",
          "border-color": "transparent",
          "border-bottom-color": "transparent",
          "backdrop-filter": "none",
          "-webkit-backdrop-filter": "none",
          "box-shadow": "none"
        }
      };

      let power = { onBattery: false };
      const defaults = {
        fit: "cover",
        position: "50% 50%",
        brightness: 82,
        saturation: 105,
        blur: 0,
        dim: 28,
        glassOpacity: 62,
        glassBlur: 18,
        pauseWhenHidden: true,
        playing: true
      };

      const number = (value, fallback, min, max) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
      };

      const normalizeEffects = (value = {}) => ({
        fit: ["cover", "contain", "fill"].includes(value.fit) ? value.fit : defaults.fit,
        position: typeof value.position === "string" ? value.position : defaults.position,
        brightness: number(value.brightness, defaults.brightness, 10, 160),
        saturation: number(value.saturation, defaults.saturation, 0, 240),
        blur: number(value.blur, defaults.blur, 0, 40),
        dim: number(value.dim, defaults.dim, 0, 90),
        glassOpacity: number(value.glassOpacity, defaults.glassOpacity, 0, 100),
        glassBlur: number(value.glassBlur, defaults.glassBlur, 0, 60),
        webLoopHoldSeconds: number(value.webLoopHoldSeconds, 0, 0, 3600),
        webForceSingleLoop: value.webForceSingleLoop === true,
        pauseWhenHidden: value.pauseWhenHidden !== false,
        pauseOnBattery: value.pauseOnBattery === true,
        onBattery: power.onBattery,
        playing: value.playing !== false,
        zoom: number(value.zoom, 100, 50, 300),
        playbackRate: number(value.playbackRate, 1, .25, 4),
        mirror: value.mirror === true,
        audioEnabled: value.audioEnabled === true,
        volume: number(value.volume, 50, 0, 100),
        contrast: number(value.contrast, 100, 0, 240),
        opacity: number(value.opacity, 100, 0, 100),
        transition: ["cut", "fade", "push", "wipe", "iris", "zoom", "stripes"].includes(value.transition) ? value.transition : "cut",
        transitionDirection: ["left", "right", "up", "down"].includes(value.transitionDirection) ? value.transitionDirection : "left",
        transitionDurationMs: number(value.transitionDurationMs, 600, 100, 3000),
        reduceMotion: value.reduceMotion === true
      });

      const ensureStyle = () => {
        let style = document.getElementById(ids.style);
        if (!style) {
          style = document.createElement("style");
          style.id = ids.style;
          style.dataset.codexWallpaperBridge = "style";
          style.textContent = `
            :root[data-codex-wallpaper-bridge="active"] {
              --cwb-glass-alpha: .62;
              --cwb-glass-blur: 18px;
              --cwb-sidebar-alpha: .34;
              --cwb-header-alpha: .27;
              --cwb-sidebar-blur: 20px;
              --cwb-header-blur: 18px;
              --cwb-shell-rgb: 12, 17, 27;
              --cwb-shell-sheen-rgb: 255, 255, 255;
              --cwb-shell-sheen-top: .10;
              --cwb-shell-sheen-bottom: .025;
              --cwb-shell-line-rgb: 255, 255, 255;
              --cwb-shell-line-alpha: .12;
              --cwb-shell-shadow-alpha: .24;
            }
            html[data-codex-wallpaper-bridge="active"].electron-light:not([data-dream-shell="dark"]),
            html[data-codex-wallpaper-bridge="active"][data-dream-shell="light"] {
              --cwb-shell-rgb: 248, 250, 253;
              --cwb-shell-line-rgb: 55, 65, 81;
              --cwb-shell-line-alpha: .12;
              --cwb-shell-shadow-alpha: .10;
            }
            html[data-codex-wallpaper-bridge="active"],
            html[data-codex-wallpaper-bridge="active"] body {
              background: transparent !important;
            }
            #${ids.root} {
              position: fixed;
              inset: 0;
              z-index: 0;
              overflow: hidden;
              pointer-events: none;
              contain: strict;
              background: #0d1119;
            }
            #${ids.root} > iframe {
              position: absolute;
              inset: -2.5%;
              width: 105%;
              height: 105%;
              max-width: none;
              object-fit: var(--cwb-fit, cover);
              object-position: var(--cwb-position, 50% 50%);
              filter: brightness(var(--cwb-brightness, .82)) saturate(var(--cwb-saturation, 1.05)) contrast(var(--cwb-contrast, 1)) blur(var(--cwb-blur, 0px));
              opacity: var(--cwb-opacity, 1);
              transform: translateZ(0);
              border: 0;
              pointer-events: none;
            }
            #${ids.root} > [data-cwb-native], #${ids.root} > video, #${ids.root} > img {
              filter: brightness(var(--cwb-brightness, .82)) saturate(var(--cwb-saturation, 1.05)) contrast(var(--cwb-contrast, 1)) blur(var(--cwb-blur, 0px));
              opacity: var(--cwb-opacity, 1);
              pointer-events: none;
            }
            #${ids.scrim} {
              position: absolute;
              inset: 0;
              background:
                linear-gradient(180deg, rgba(3, 8, 17, calc(var(--cwb-dim, .28) * .72)), rgba(3, 8, 17, var(--cwb-dim, .28))),
                radial-gradient(circle at 58% 18%, rgba(255,255,255,.06), transparent 42%);
              pointer-events: none;
            }
            html[data-codex-wallpaper-bridge="active"] body > :not(#${ids.root}) {
              z-index: 1;
            }
            html[data-codex-wallpaper-bridge="active"] :is(
              main.main-surface,
              main[data-app-shell-main-surface],
              main[class*="_MainContentSurface_"],
              .thread-scroll-container,
              [role="main"]
            ) {
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] body > #root aside:is(
              .app-shell-left-panel,
              [data-app-shell-left-panel-appearance],
              [data-ds-part="sidebar"]
            ),
            html[data-codex-wallpaper-bridge="active"] aside:is(
              .app-shell-left-panel,
              [data-app-shell-left-panel-appearance],
              [data-ds-part="sidebar"]
            ) {
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              -webkit-backdrop-filter: none !important;
              backdrop-filter: none !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] :is(
              .composer-surface-chrome,
              [class*="_ComposerLayoutRoot_"],
              [data-composer-surface-variant][data-composer-radius-variant]
            ) {
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              -webkit-backdrop-filter: none !important;
              backdrop-filter: none !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] [class*="bg-gradient-to-t"]:has(
              + [data-pip-obstacle="thread-footer"]
            ),
            html[data-codex-wallpaper-bridge="active"] [data-above-composer-portal] [class*="bg-gradient-to-t"][class*="from-surface"],
            html[data-codex-wallpaper-bridge="active"] [data-composer-placement="thread"] :is(
              .composer-surface-chrome,
              [class*="_ComposerLayoutRoot_"],
              [data-composer-surface-variant][data-composer-radius-variant]
            )::before,
            html[data-codex-wallpaper-bridge="active"] [data-composer-placement="thread"] :is(
              .composer-surface-chrome,
              [class*="_ComposerLayoutRoot_"],
              [data-composer-surface-variant][data-composer-radius-variant]
            )::after {
              background: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] :is(
              [data-user-message-bubble],
              [data-app-action-sidebar-thread-selected="true"],
              [class*="bg-surface-elevated-secondary/50"],
              [class*="bg-background-primary-soft/50"]
            ) {
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              -webkit-backdrop-filter: none !important;
              backdrop-filter: none !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] :is(
              [data-app-shell-main-content-top-fade],
              [class*="_MainContentTopFade_"]
            ) {
              background: transparent !important;
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              -webkit-backdrop-filter: none !important;
              backdrop-filter: none !important;
              box-shadow: none !important;
            }
            html[data-codex-wallpaper-bridge="active"] body > #root header:is(
              .app-header-tint,
              [data-app-shell-application-menu-bar],
              [data-app-shell-header-edge-scroll],
              [data-pip-obstacle="app-shell-header"],
              [data-ds-part="header"],
              [class*="_Header_"]
            ),
            html[data-codex-wallpaper-bridge="active"] header:is(
              .app-header-tint,
              [data-app-shell-application-menu-bar],
              [data-app-shell-header-edge-scroll],
              [data-pip-obstacle="app-shell-header"],
              [data-ds-part="header"],
              [class*="_Header_"]
            ) {
              background-color: transparent !important;
              background-image: none !important;
              border-color: transparent !important;
              -webkit-backdrop-filter: none !important;
              backdrop-filter: none !important;
              box-shadow: none !important;
            }
          `;
          (document.head || document.documentElement).appendChild(style);
        }
        return style;
      };

      const restoreShellElement = (element) => {
        const saved = shellInlineState.get(element);
        if (!saved) return;
        for (const [property, previous] of saved) {
          if (previous.value) {
            element.style.setProperty(property, previous.value, previous.priority);
          } else {
            element.style.removeProperty(property);
          }
        }
        shellInlineState.delete(element);
      };

      const applyShellElement = (element, kind) => {
        if (!element?.style) return;
        let saved = shellInlineState.get(element);
        if (!saved) {
          saved = new Map();
          shellInlineState.set(element, saved);
        }
        for (const [property, value] of Object.entries(shellInlineStyles[kind])) {
          if (!saved.has(property)) {
            saved.set(property, {
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property)
            });
          }
          if (
            element.style.getPropertyValue(property) !== value ||
            element.style.getPropertyPriority(property) !== "important"
          ) {
            // Inline !important is intentional: Dream Skin uses an adopted
            // stylesheet whose important longhands outrank an injected <style>.
            element.style.setProperty(property, value, "important");
          }
        }
      };

      const refreshShellElement = (element) => {
        if (!element?.matches) return;
        if (element.matches(shellSelectors.sidebar)) {
          applyShellElement(element, "sidebar");
        } else if (element.matches(shellSelectors.header)) {
          applyShellElement(element, "header");
        } else {
          // A React node may be recycled after its semantic attributes change.
          // Do not leave bridge styles attached to a node with a new purpose.
          restoreShellElement(element);
        }
      };

      const applyShellOverrides = (scope = document) => {
        if (scope?.nodeType === 1) refreshShellElement(scope);
        if (!scope?.querySelectorAll) return;
        const selector = `${shellSelectors.sidebar}, ${shellSelectors.header}`;
        for (const element of scope.querySelectorAll(selector)) refreshShellElement(element);
      };

      const restoreShellOverrides = () => {
        for (const element of [...shellInlineState.keys()]) restoreShellElement(element);
      };

      const ensureRoot = () => {
        if (!document.body) return null;
        let root = document.getElementById(ids.root);
        if (!root) {
          root = document.createElement("div");
          root.id = ids.root;
          root.dataset.codexWallpaperBridge = "background";
          root.setAttribute("aria-hidden", "true");
          const scrim = document.createElement("div");
          scrim.id = ids.scrim;
          root.appendChild(scrim);
          document.body.insertBefore(root, document.body.firstChild);
        }
        return root;
      };

      const updateMediaState = (state, detail = null) => {
        mediaState = { state, detail, at: performance.now() };
      };

      const releaseMedia = () => {
        scenePreload = null;
        mediaSwitcher.clear();
        currentMediaIdentity = null;
        updateMediaState("idle");
      };

      const createMedia = ({ wallpaper, effects }, { revision, initial }) => {
        const root = ensureRoot();
        if (!root) throw new Error("Media root unavailable");
        if (wallpaper.playable === "native") {
          if (!nativeMedia) throw new Error("Native media provider unavailable");
          const slot = nativeMedia.create({ wallpaper, effects });
          slot.node.id = initial ? ids.media : `${ids.media}-pending-${revision}`;
          root.insertBefore(slot.node, document.getElementById(ids.scrim));
          return slot;
        }
        if (wallpaper.playable === "direct-gpu") {
          if (!sceneMedia) throw new Error("GPU Scene provider unavailable");
          const slot = sceneMedia.create({ wallpaper, effects });
          slot.node.id = initial ? ids.media : `${ids.media}-pending-${revision}`;
          root.insertBefore(slot.node, document.getElementById(ids.scrim));
          return slot;
        }
        const kind = (wallpaper.playable === "video" || wallpaper.type === "video")
          ? "video"
          : ((wallpaper.playable === "web" || wallpaper.type === "web") ? "web" : "image");
        const source = kind === "web"
          ? (wallpaper.webUrl || wallpaper.mediaUrl || "")
          : (wallpaper.mediaUrl || wallpaper.previewUrl || wallpaper.url || "");
        // Ordinary media uses DOM elements in owned-engine mode. The injector
        // initializes loopback media access before loading these resources.
        if ((nativeEnabled || directSceneEnabled) && kind !== "web") {
          const media = document.createElement(kind === "video" ? "video" : "img");
          media.id = initial ? ids.media : `${ids.media}-pending-${revision}`; media.style.opacity = "0";
          media.style.cssText += ";position:absolute;inset:0;width:100%;height:100%;border:0";
          let resolveReady, rejectReady, committed = false;
          const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
          const update = ({ effects: value }) => {
            media.style.objectFit = value.fit; media.style.objectPosition = value.position;
            media.style.transform = "scale(" + (value.zoom / 100) + ") scaleX(" + (value.mirror ? -1 : 1) + ")";
            media.style.transformOrigin = value.position;
            if (kind === "video") {
              media.playbackRate = value.playbackRate; media.volume = value.volume / 100;
              media.muted = !committed || !value.audioEnabled;
              if (!resolvePlayback(value, { hidden: document.hidden === true }).playing) {
                media.pause();
                if (media.readyState >= 2 && media.videoWidth > 0) resolveReady();
              }
              else void media.play().catch(() => updateMediaState("play-rejected", "autoplay blocked"));
            }
          };
          media.addEventListener("error", () => rejectReady(new Error("Media decode failed")), { once: true });
          if (kind === "video") {
            media.loop = true; media.muted = true; media.playsInline = true; media.preload = "auto";
            if (wallpaper.previewUrl) media.poster = wallpaper.previewUrl;
            media.addEventListener("loadeddata", () => {
              // A policy-paused video has decoded data but Chromium need not
              // composite it while hidden/on battery. Do not wait for a frame
              // callback that cannot fire; visible playback still requires it.
              if (media.requestVideoFrameCallback && !media.paused && resolvePlayback(effects, { hidden: document.hidden === true }).playing) media.requestVideoFrameCallback(resolveReady);
              else if (media.videoWidth > 0) resolveReady();
            }, { once: true });
          } else media.addEventListener("load", () => media.decode().then(resolveReady, rejectReady), { once: true });
          root.insertBefore(media, document.getElementById(ids.scrim)); media.src = source; update({ effects });
          return { node: media, ready, update,
            activate() { committed = true; media.style.removeProperty("opacity"); update({ effects: current.effects }); },
            retire() { committed = false; if (kind === "video") { media.muted = true; media.pause(); } },
            release() { committed = false; if (kind === "video") media.pause(); media.removeAttribute("src"); media.load?.(); media.remove(); } };
        }
        const framePayload = JSON.stringify({
          kind,
          source,
          poster: wallpaper.previewUrl || "",
          playing: resolvePlayback(effects, { hidden: document.hidden === true }).playing,
          fit: effects.fit,
          position: effects.position,
          effects: { ...effects, audioEnabled: false }
        }).replace(/</g, "\\u003c");
        const media = document.createElement("iframe");
        media.id = initial ? ids.media : `${ids.media}-pending-${revision}`;
        media.style.opacity = "0";
        media.title = "Codex wallpaper media";
        media.referrerPolicy = "no-referrer";
        media.allow = "autoplay";
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        let committed = false;
        const update = (value) => {
          const e = value.effects;
          media.contentWindow?.postMessage({ channel: "cwb-media-control",
            action: resolvePlayback(e, { hidden: document.hidden === true }).playing ? "play" : "pause",
            fit: e.fit, position: e.position, effects: { ...e, audioEnabled: committed && e.audioEnabled } }, "*");
        };
        media.srcdoc = `<!doctype html><meta charset="utf-8"><style>
          html,body,#mount,#cwb-media{margin:0;width:100%;height:100%;overflow:hidden;background:#0d1119}
          #cwb-media{display:block;border:0;object-fit:cover}
        </style><div id="mount"></div><script>(()=>{
          const config=${framePayload};
          const report=(event, detail=null)=>parent.postMessage({channel:"cwb-media-frame",event,detail},"*");
          let media, readyReported=false;
          const firstFrame=()=>{if(!readyReported){readyReported=true;report("ready");}};
          const updateEffects=(effects)=>{
            media.style.transform="scale("+((effects.zoom??100)/100)+") scaleX("+(effects.mirror?-1:1)+")";
            media.style.transformOrigin=effects.position||config.position;
            if(config.kind==="video"){
              media.playbackRate=effects.playbackRate??1;
              media.volume=(effects.volume??50)/100;
              media.muted=effects.audioEnabled!==true;
            }
          };
          if(config.kind==="video"){
            media=document.createElement("video");
            media.muted=true;media.loop=true;media.autoplay=config.playing;media.playsInline=true;media.preload="auto";
            if(config.poster)media.poster=config.poster;
            for(const event of ["loadstart","loadeddata","canplay","playing","pause"]){
              media.addEventListener(event,()=>report(event),{passive:true});
            }
            media.addEventListener("error",()=>report("error",media.error?.message||"media error"),{passive:true});
            media.addEventListener("loadeddata",()=>{
              if(media.requestVideoFrameCallback&&!media.paused)media.requestVideoFrameCallback(firstFrame);
              else if(media.videoWidth>0)firstFrame();
            },{once:true});
          }else if(config.kind==="web"){
            media=document.createElement("iframe");
            media.sandbox="allow-scripts";media.referrerPolicy="no-referrer";
            media.addEventListener("load",firstFrame,{once:true});
          }else{
            media=document.createElement("img");media.alt="";media.decoding="async";
            media.addEventListener("load",()=>media.decode().then(firstFrame,()=>report("error","image decode")),{once:true});
            media.addEventListener("error",()=>report("error","image error"),{once:true});
          }
          media.id="cwb-media";media.style.objectFit=config.fit;media.style.objectPosition=config.position;
          updateEffects(config.effects);
          media.src=config.source;document.getElementById("mount").append(media);
          addEventListener("message",event=>{
            if(event.source!==parent||event.data?.channel!=="cwb-media-control")return;
            if(event.data.fit)media.style.objectFit=event.data.fit;
            if(event.data.position)media.style.objectPosition=event.data.position;
            updateEffects(event.data.effects||config.effects);
            if(event.data.action==="play")media.play?.().catch(error=>report("play-rejected",error.name||"autoplay blocked"));
            if(event.data.action==="pause"){
              media.pause?.();
              if(media.readyState>=2&&media.videoWidth>0)firstFrame();
            }
          });
          if(config.kind==="video"&&config.playing)media.play().catch(error=>report("play-rejected",error.name||"autoplay blocked"));
        })()<\/script>`;
        const handler = (event) => {
          if (event.source !== media.contentWindow || event.data?.channel !== "cwb-media-frame") return;
          if (event.data.event === "ready") readyResolve();
          if (event.data.event === "error") readyReject(new Error("Media decode failed"));
          if (committed) updateMediaState(event.data.event || "unknown", event.data.event === "play-rejected" ? "autoplay blocked" : null);
        };
        addEventListener("message", handler);
        root.insertBefore(media, document.getElementById(ids.scrim));
        return { node: media, ready, wallpaperId: wallpaper.id, update,
          activate() { committed = true; media.style.removeProperty("opacity"); update({ effects: current.effects }); },
          retire() { committed = false; update({ effects: current.effects }); },
          release() { removeEventListener("message", handler); media.srcdoc = ""; media.src = "about:blank"; media.remove(); } };
      };

      const mediaSwitcher = createMediaSwitcher({ create: createMedia,
        commit(slot, before) {
          // An activation failure must not retire or rename the old slot.
          slot.activate();
          if (before) { before.node.id = `${ids.media}-retired`; before.retire(); }
          slot.node.id = ids.media;
          currentMediaIdentity = slot.identity;
          updateMediaState("ready");
        }, dispose: (slot) => slot?.release(), transition: runMediaTransition, timeoutMs: nativeEnabled ? 15000 : 5000 });
      const mediaIdentity = (wallpaper) => wallpaper?.playable === "direct-gpu"
        ? JSON.stringify([wallpaper.id, wallpaper.type || "scene", "direct-gpu"])
        : JSON.stringify([wallpaper?.id, wallpaper?.type, wallpaper?.playable, wallpaper?.mediaUrl, wallpaper?.previewUrl, wallpaper?.webUrl]);
      const cancelScenePreload = (leaseHandle) => {
        if (!scenePreload || (leaseHandle && scenePreload.leaseHandle !== leaseHandle)) return false;
        const pending = scenePreload; scenePreload = null;
        if (mediaSwitcher.status().requestedIdentity === pending.identity) mediaSwitcher.cancel();
        return true;
      };
      const preloadScene = (leaseHandle, key) => {
        if (!sceneMedia || !current || !document.getElementById(ids.root)
          || typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)
          || sceneMedia.key(leaseHandle) !== key || current.wallpaper?.id === key) return { started: false };
        const status = mediaSwitcher.status();
        // Never interrupt an actual user switch or truncate its ongoing fade.
        if (status.transitioning || (status.requestedIdentity && status.requestedIdentity !== scenePreload?.identity)) {
          return { started: false, busy: true };
        }
        if (scenePreload?.key === key) return { started: true, reused: true };
        cancelScenePreload();
        const wallpaper = { id: key, type: "scene", playable: "direct-gpu" };
        const identity = mediaIdentity(wallpaper);
        const handle = mediaSwitcher.prepare({ wallpaper, effects: current.effects }, identity, { loadTimeoutMs: 90000 });
        scenePreload = { key, identity, handle, leaseHandle };
        // This call returns before first-frame readiness. Actual apply can adopt
        // the handle while loading; speculation never holds the CDP work queue.
        handle.ready.then((result) => {
          if (!result.ok && scenePreload?.handle === handle) scenePreload = null;
        }).catch(() => {});
        return { started: true };
      };
      if (sceneMedia) sceneController = {
        register: sceneMedia.register, state: sceneMedia.state, forget: sceneMedia.forget,
        properties: sceneMedia.properties, input: sceneMedia.input, retry: sceneMedia.retry, close: sceneMedia.close,
        configure: sceneMedia.configure, preload: preloadScene, cancelPreload: cancelScenePreload,
        finishTransition() { mediaSwitcher.finishTransition(); return true; }
      };

      const mountMedia = (wallpaper) => {
        if (!wallpaper) { releaseMedia(); return Promise.resolve({ ok: true }); }
        const identity = mediaIdentity(wallpaper);
        if (scenePreload && currentMediaIdentity === identity) {
          // Effect-only updates must not throw away the next preloaded scene.
          mediaSwitcher.update({ wallpaper, effects: current.effects });
          return Promise.resolve({ ok: true, reused: true });
        }
        // A matching pending candidate is adopted by prepare(); a different
        // selection cancels it there. It is no longer speculative once applied.
        scenePreload = null;
        const force = wallpaper.playable === "native" ? nativeMedia?.state(wallpaper.id).retryRequested === true
          : wallpaper.playable === "direct-gpu" && sceneMedia?.retryRequested(wallpaper.id);
        // Reusing a committed slot does not run commit() again. Keep its actual
        // state (including playback errors), rather than leaving it in loading.
        if (mediaSwitcher.status().identity !== identity || force) updateMediaState("loading");
        return mediaSwitcher.switchTo({ wallpaper, effects: current.effects }, identity, { ...current.effects, force,
          loadTimeoutMs: wallpaper.playable === "direct-gpu" ? 90000 : undefined }).then((result) => {
          if (result.error) updateMediaState("error", result.error);
          return result;
        });
      };

      const syncPlayback = () => {
        if (current) mediaSwitcher.update({ effects: current.effects });
        if (current?.effects.reduceMotion) mediaSwitcher.finishTransition();
      };

      const applyVariables = (effects) => {
        const root = document.getElementById(ids.root);
        if (!root) return;
        const glassAlpha = effects.glassOpacity / 100;
        const rounded = (value) => String(Math.round(value * 1_000) / 1_000);
        root.style.setProperty("--cwb-fit", effects.fit);
        root.style.setProperty("--cwb-position", effects.position);
        root.style.setProperty("--cwb-brightness", String(effects.brightness / 100));
        root.style.setProperty("--cwb-saturation", String(effects.saturation / 100));
        root.style.setProperty("--cwb-contrast", String(effects.contrast / 100));
        root.style.setProperty("--cwb-opacity", String(effects.opacity / 100));
        root.style.setProperty("--cwb-blur", effects.blur + "px");
        root.style.setProperty("--cwb-dim", String(effects.dim / 100));
        document.documentElement.style.setProperty("--cwb-glass-alpha", rounded(glassAlpha));
        document.documentElement.style.setProperty("--cwb-glass-blur", effects.glassBlur + "px");
        // Precompute derived values in JavaScript. Typed CSS multiplication inside
        // rgba()/blur() is not supported by every Electron Chromium build and
        // caused the shell to silently fall back to opaque native theme colors.
        document.documentElement.style.setProperty("--cwb-sidebar-alpha", rounded(glassAlpha * .55));
        document.documentElement.style.setProperty("--cwb-header-alpha", rounded(glassAlpha * .44));
        document.documentElement.style.setProperty("--cwb-shell-sheen-top", rounded(glassAlpha * .16));
        document.documentElement.style.setProperty("--cwb-shell-sheen-bottom", rounded(glassAlpha * .04));
        document.documentElement.style.setProperty(
          "--cwb-sidebar-blur",
          (effects.glassBlur === 0 ? 0 : Math.min(60, effects.glassBlur + 2)) + "px"
        );
        document.documentElement.style.setProperty("--cwb-header-blur", effects.glassBlur + "px");
      };

      const ensureMounted = () => {
        ensureStyle();
        const root = ensureRoot();
        if (!root || !current) return;
        if (!document.getElementById(ids.media)) {
          // A detached GPU iframe cannot mint its own resource descriptor.
          // The private lease monitor will rehydrate this document instead.
          if (current.wallpaper?.playable === "direct-gpu") return;
          mediaSwitcher.clear(); void mountMedia(current.wallpaper);
        }
        applyVariables(current.effects);
      };

      const updateVisibilityHandler = () => {
        if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = () => {
          if (document.hidden && current?.wallpaper?.playable === "direct-gpu" && mediaSwitcher.status().requestedIdentity) {
            // Hidden Chromium cannot promise a first paint. Cancel the candidate
            // only; the trusted lease monitor will retry once visible, not cache
            // this as a content failure or replace the last committed wallpaper.
            mediaSwitcher.cancel();
          }
          syncPlayback();
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      };

      const startObserver = () => {
        if (observer || !document.body) return;
        let queued = false;
        let needsEnsure = false;
        const dirtyRoots = new Set();
        const markDirty = (node) => {
          if (node?.nodeType === 1 || node?.nodeType === 9 || node?.nodeType === 11) {
            dirtyRoots.add(node);
          }
        };
        const containsBridgeMedia = (node) => {
          if (node?.nodeType !== 1) return false;
          return node.id === ids.root || node.id === ids.media ||
            Boolean(node.querySelector?.(`#${ids.root}, #${ids.media}`));
        };
        observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === "childList") {
              for (const removed of mutation.removedNodes) {
                if (containsBridgeMedia(removed)) needsEnsure = true;
                if (removed?.nodeType === 1) {
                  for (const element of [...shellInlineState.keys()]) {
                    if (removed === element || removed.contains(element)) restoreShellElement(element);
                  }
                }
              }
              for (const added of mutation.addedNodes) markDirty(added);
            } else if (mutation.type === "attributes") {
              if (
                mutation.attributeName !== "style" ||
                shellInlineState.has(mutation.target) ||
                mutation.target.matches?.(`${shellSelectors.sidebar}, ${shellSelectors.header}`)
              ) {
                markDirty(mutation.target);
              }
            }
          }
          if (queued || (!needsEnsure && dirtyRoots.size === 0)) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            const ensure = needsEnsure;
            needsEnsure = false;
            const roots = [...dirtyRoots];
            dirtyRoots.clear();
            if (ensure) ensureMounted();
            for (const root of roots) applyShellOverrides(root);
          });
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            "class",
            "style",
            "data-app-shell-left-panel-appearance",
            "data-app-shell-application-menu-bar",
            "data-app-shell-header-edge-scroll",
            "data-pip-obstacle",
            "data-ds-part"
          ]
        });
      };

      const apply = (payload) => {
        const requested = {
          wallpaper: payload?.wallpaper || null,
          fallbackReason: ["embedded_video", "custom_static", "preview", "empty"].includes(payload?.fallbackReason) ? payload.fallbackReason : null,
          effects: normalizeEffects(payload?.config?.effects || payload?.effects || {})
        };
        current = requested;
        const themePromise = ensureDarkTheme();
        const run = async () => {
          document.documentElement.dataset.codexWallpaperBridge = "active";
          ensureStyle();
          ensureRoot();
          const root = document.getElementById(ids.root);
          if (requested.fallbackReason) root.dataset.cwbFallback = requested.fallbackReason;
          else delete root.dataset.cwbFallback;
          const mediaOperation = mountMedia(current.wallpaper);
          lastMediaOperation = mediaOperation;
          applyVariables(current.effects);
          syncPlayback();
          applyShellOverrides();
          updateVisibilityHandler();
          startObserver();
          const theme = await themePromise;
          const switchResult = await mediaOperation;
          return {
            ok: switchResult?.ok === true,
            deferred: requested === current && requested.wallpaper?.playable === "direct-gpu"
              && document.hidden && switchResult?.cancelled === true,
            switchResult,
            wallpaperId: payload?.wallpaper?.id || null,
            domReady: Boolean(document.getElementById(ids.root) && document.getElementById(ids.media)),
            mediaState: mediaState.state,
            theme
          };
        };
        if (document.body) return run();
        addEventListener("DOMContentLoaded", () => { void run(); }, { once: true });
        return { ok: true, pendingDom: true, wallpaperId: payload?.wallpaper?.id || null };
      };

      const restore = async (options = {}) => {
        const theme = options.preserveTheme
          ? { state: themeState, preserved: true, reloadRequired: false }
          : await restoreOriginalTheme();
        observer?.disconnect();
        observer = null;
        if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
        restoreShellOverrides();
        releaseMedia();
        nativeMedia?.close();
        sceneMedia?.close();
        document.getElementById(ids.root)?.remove();
        document.getElementById(ids.style)?.remove();
        document.documentElement.removeAttribute("data-codex-wallpaper-bridge");
        document.documentElement.style.removeProperty("--cwb-glass-alpha");
        document.documentElement.style.removeProperty("--cwb-glass-blur");
        document.documentElement.style.removeProperty("--cwb-sidebar-alpha");
        document.documentElement.style.removeProperty("--cwb-header-alpha");
        document.documentElement.style.removeProperty("--cwb-sidebar-blur");
        document.documentElement.style.removeProperty("--cwb-header-blur");
        document.documentElement.style.removeProperty("--cwb-shell-sheen-top");
        document.documentElement.style.removeProperty("--cwb-shell-sheen-bottom");
        current = null;
        themeActivationPromise = null;
        return { ok: true, theme, cspReloadRequired: sceneMedia?.used() === true };
      };

      return {
        apply,
        setPower(value) {
          if (typeof value?.onBattery !== 'boolean') return false;
          power = { onBattery: value.onBattery };
          if (current) { current.effects.onBattery = power.onBattery; syncPlayback(); }
          return true;
        },
        // Theme-only preflight does not mount a wallpaper or await its assets.
        prepareTheme: ensureDarkTheme,
        restore,
        ensureMounted,
        waitForMedia: () => lastMediaOperation,
        status: () => ({ ...mediaState, switch: mediaSwitcher.status(), theme: themeState,
          playback: resolvePlayback(current?.effects || {}, { hidden: document.hidden === true, inactive: !current }) }),
        ready: true,
        version: VERSION
      };
    };

    let runtime = globalThis[KEY];
    if (!runtime || runtime.version !== VERSION || nativeEnabled || directSceneEnabled) {
      // Finish the previous runtime's DOM teardown before installing a new one.
      try { await runtime?.restore?.({ preserveTheme: true }); } catch {}
      runtime = createRuntime();
      globalThis[KEY] = runtime;
    }
    return { ok: true, ready: runtime.ready === true, version: runtime.version, transport: nativeController, sceneTransport: sceneController };
}

/**
 * Builds the renderer-side script injected through Chrome DevTools Protocol.
 * The script is deliberately self-contained: it must run inside Codex without
 * imports, Node globals, or access to this package's filesystem.
 */
export function buildBootstrapScript({ nativeEnabled = false, directSceneEnabled = false } = {}) {
  // Do not ship unused engine/author adapters to ordinary image/video targets.
  const engine = nativeEnabled && !directSceneEnabled ? createEngineMediaTransport.toString() : 'null';
  const gpu = directSceneEnabled ? [createDirectSceneTransport, createScenePreviewSlot, readAuthorProperties, validateAuthorPropertyPatch, validateWebWallpaperInput]
    .map(fn => fn.toString()).join(', ') : 'null, null, null, null, null';
  return `(${rendererBootstrap.toString()})(${createMediaSwitcher.toString()}, ${runMediaTransition.toString()}, ${engine}, ${gpu}, ${resolvePlayback.toString()}, ${nativeEnabled === true}, ${directSceneEnabled === true})`;
}

export function buildApplyScript(payload = {}) {
  return `(async () => {
    const runtime = globalThis[${JSON.stringify(GLOBAL_KEY)}];
    if (!runtime?.ready || typeof runtime.apply !== "function") {
      throw new Error("Codex wallpaper runtime is not ready");
    }
    const result = await runtime.apply(${safePayload(payload)});
    const fallback = ${JSON.stringify(payload.waitForMedia === true)};
    const loaded = fallback ? await runtime.waitForMedia() : null;
    return {
      ...result,
      ...(fallback ? { ok: loaded?.ok === true, degraded: true, fallbackReason: ${JSON.stringify(payload.fallbackReason || null)} } : {}),
      runtimeReady: true,
      runtimeVersion: runtime.version,
      domReady: Boolean(
        document.getElementById("codex-wallpaper-bridge-root") &&
        (document.getElementById("codex-wallpaper-bridge-media") || (fallback && ${JSON.stringify(payload.fallbackReason === 'empty')}))
      ),
      media: runtime.status?.() || null
    };
  })()`;
}

export function buildInjectionScript(payload = {}) {
  return `(async () => { await ${buildBootstrapScript()}; return await ${buildApplyScript(payload)}; })()`;
}

export function buildRestoreScript() {
  return `(async () => {
    const runtime = globalThis[${JSON.stringify(GLOBAL_KEY)}];
    const result = await (runtime?.restore?.() || { ok: true, alreadyRestored: true });
    try { delete globalThis[${JSON.stringify(GLOBAL_KEY)}]; } catch {}
    return result;
  })()`;
}
