const GLOBAL_KEY = "__codexWallpaperBridgeRuntime";
const TRANSFERRED_ASSETS_KEY = "__codexWallpaperBridgeAssets";
const ASSET_TRANSFER_KEY = "__codexWallpaperBridgeAssetTransfer";

function safePayload(payload) {
  return JSON.stringify(payload ?? {}).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function rendererBootstrap(incoming) {
    const KEY = "__codexWallpaperBridgeRuntime";
    const ASSETS_KEY = "__codexWallpaperBridgeAssets";
    const TRANSFER_KEY = "__codexWallpaperBridgeAssetTransfer";
    const VERSION = "0.2.0";

    const createRuntime = () => {
      const ids = {
        root: "codex-wallpaper-bridge-root",
        media: "codex-wallpaper-bridge-media",
        scrim: "codex-wallpaper-bridge-scrim",
        style: "codex-wallpaper-bridge-style"
      };
      let current = null;
      let observer = null;
      let visibilityHandler = null;
      let activeAssetKey = null;
      const shellInlineState = new Map();

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
        pauseWhenHidden: value.pauseWhenHidden !== false,
        playing: value.playing !== false
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
            #${ids.media} {
              position: absolute;
              inset: -2.5%;
              width: 105%;
              height: 105%;
              max-width: none;
              object-fit: var(--cwb-fit, cover);
              object-position: var(--cwb-position, 50% 50%);
              filter: brightness(var(--cwb-brightness, .82)) saturate(var(--cwb-saturation, 1.05)) blur(var(--cwb-blur, 0px));
              transform: translateZ(0);
              border: 0;
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

      const assetRegistry = () => {
        const existing = globalThis[ASSETS_KEY];
        if (existing instanceof Map) return existing;
        const registry = new Map();
        globalThis[ASSETS_KEY] = registry;
        return registry;
      };

      const releaseAsset = (key) => {
        if (!key) return;
        const registry = assetRegistry();
        const asset = registry.get(key);
        if (asset?.url) URL.revokeObjectURL(asset.url);
        registry.delete(key);
      };

      const releaseMedia = (nextAssetKey = null) => {
        const media = document.getElementById(ids.media);
        if (media) {
          if (media.tagName === "VIDEO") {
            try { media.pause(); } catch {}
            media.removeAttribute("src");
            try { media.load(); } catch {}
          } else if (media.tagName === "IFRAME") {
            media.src = "about:blank";
          }
          media.remove();
        }
        if (activeAssetKey && activeAssetKey !== nextAssetKey) releaseAsset(activeAssetKey);
        activeAssetKey = nextAssetKey || null;
      };

      const mountMedia = (wallpaper) => {
        const root = ensureRoot();
        if (!root) return;
        const assetKey = typeof wallpaper?.mediaAssetKey === "string"
          ? wallpaper.mediaAssetKey
          : null;
        releaseMedia(assetKey);
        if (!wallpaper) return;

        let media;
        const transferredUrl = assetKey ? assetRegistry().get(assetKey)?.url : null;
        const videoUrl = transferredUrl || wallpaper.mediaUrl || wallpaper.url || "";
        if ((wallpaper.playable === "video" || wallpaper.type === "video") && videoUrl) {
          media = document.createElement("video");
          media.muted = true;
          media.loop = true;
          media.autoplay = current?.effects?.playing !== false;
          media.playsInline = true;
          media.preload = "auto";
          media.src = videoUrl;
          if (current?.effects?.playing !== false) {
            media.addEventListener("canplay", () => media.play().catch(() => {}), { once: true });
          }
        } else if (wallpaper.playable === "web" || wallpaper.type === "web") {
          media = document.createElement("iframe");
          media.sandbox = "allow-scripts";
          media.referrerPolicy = "no-referrer";
          media.src = wallpaper.webUrl || wallpaper.mediaUrl || "about:blank";
        } else {
          media = document.createElement("img");
          media.alt = "";
          media.decoding = "async";
          media.src = wallpaper.previewUrl || wallpaper.mediaUrl || wallpaper.url || "";
        }
        media.id = ids.media;
        root.insertBefore(media, document.getElementById(ids.scrim));
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
        if (!document.getElementById(ids.media)) mountMedia(current.wallpaper);
        applyVariables(current.effects);
      };

      const updateVisibilityHandler = () => {
        if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = () => {
          const video = document.getElementById(ids.media);
          if (!video || video.tagName !== "VIDEO") return;
          if (document.hidden && current?.effects?.pauseWhenHidden) video.pause();
          else if (current?.effects?.playing) video.play().catch(() => {});
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
        current = {
          wallpaper: payload?.wallpaper || null,
          effects: normalizeEffects(payload?.config?.effects || payload?.effects || {})
        };
        const run = () => {
          document.documentElement.dataset.codexWallpaperBridge = "active";
          ensureStyle();
          ensureRoot();
          mountMedia(current.wallpaper);
          applyVariables(current.effects);
          applyShellOverrides();
          updateVisibilityHandler();
          startObserver();
        };
        if (document.body) run(); else addEventListener("DOMContentLoaded", run, { once: true });
        return { ok: true, wallpaperId: payload?.wallpaper?.id || null };
      };

      const restore = () => {
        observer?.disconnect();
        observer = null;
        if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
        restoreShellOverrides();
        releaseMedia();
        const registry = assetRegistry();
        for (const asset of registry.values()) {
          if (asset?.url) URL.revokeObjectURL(asset.url);
        }
        registry.clear();
        try { delete globalThis[ASSETS_KEY]; } catch {}
        try { delete globalThis[TRANSFER_KEY]; } catch {}
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
        return { ok: true };
      };

      return { apply, restore, ensureMounted, version: VERSION };
    };

    let runtime = globalThis[KEY];
    if (!runtime || runtime.version !== VERSION) {
      try { runtime?.restore?.(); } catch {}
      runtime = createRuntime();
      globalThis[KEY] = runtime;
    }
    return runtime.apply(incoming);
}

/**
 * Builds the renderer-side script injected through Chrome DevTools Protocol.
 * The script is deliberately self-contained: it must run inside Codex without
 * imports, Node globals, or access to this package's filesystem.
 */
export function buildInjectionScript(payload = {}) {
  return `(${rendererBootstrap.toString()})(${safePayload(payload)})`;
}

export function buildRestoreScript() {
  return `(() => {
    const runtime = globalThis[${JSON.stringify(GLOBAL_KEY)}];
    const result = runtime?.restore?.() || { ok: true, alreadyRestored: true };
    const registry = globalThis[${JSON.stringify(TRANSFERRED_ASSETS_KEY)}];
    if (registry instanceof Map) {
      for (const asset of registry.values()) {
        if (asset?.url) URL.revokeObjectURL(asset.url);
      }
      registry.clear();
    }
    try { delete globalThis[${JSON.stringify(TRANSFERRED_ASSETS_KEY)}]; } catch {}
    try { delete globalThis[${JSON.stringify(ASSET_TRANSFER_KEY)}]; } catch {}
    try { delete globalThis[${JSON.stringify(GLOBAL_KEY)}]; } catch {}
    return result;
  })()`;
}
