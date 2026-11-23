const RUNTIME_KEY = "__codexWallpaperElectronCompat";
const STYLE_ID = "codex-wallpaper-electron-compat-style";
const ROOT_ATTRIBUTE = "data-cwb-electron-compat";
const AUTO_ATTRIBUTE = "data-cwb-electron-auto-clear";

const semanticSelector = `
  body,
  body > #root,
  [data-app-shell-root],
  [data-app-shell-frame],
  [data-app-shell-window],
  [data-app-shell-main-surface],
  [data-app-shell-main-content],
  [data-app-shell-left-panel-appearance],
  [data-app-shell-application-menu-bar],
  [data-app-shell-header-edge-scroll],
  [data-pip-obstacle="app-shell-header"],
  [data-ds-part="sidebar"],
  [data-ds-part="header"],
  [data-ds-part="main"],
  [data-composer-placement="thread"],
  [data-composer-surface-variant],
  [data-above-composer-portal],
  .app-shell,
  .app-shell-left-panel,
  .app-header-tint,
  .composer-surface-chrome,
  [class*="_AppShell_"],
  [class*="_MainContent_"],
  [class*="_MainSurface_"],
  [class*="_LeftPanel_"],
  [class*="_Sidebar_"],
  [class*="_Header_"],
  [class*="_TitleBar_"],
  [class*="_ThreadView_"],
  [class*="_Conversation_"],
  [class*="_ComposerSurface_"],
  [class~="absolute"][class~="inset-0"][class*="bg-primary-soft"],
  [class~="absolute"][class~="inset-0"][class*="bg-background-primary-soft"],
  [data-testid*="sidebar" i],
  [data-testid*="titlebar" i],
  [data-testid*="conversation" i],
  [data-testid*="composer" i]
`;

// These nested surfaces paint independently of the already-transparent shell.
// Keep their borders, focus rings, typography and child controls untouched.
const inlinePageHeaderSelector = `
  [data-app-shell-inline-page-header] [data-sticky][class*="_shell_"]:has(> [class*="_content_"] > [class*="_headerRow_"])
`;
const composerSpacerFadeSelector = `
  .thread-scroll-container [class~="pointer-events-none"][class~="sticky"][class~="bottom-0"] > div[class~="pointer-events-none"][class~="absolute"][class~="bg-gradient-to-t"][class~="from-surface"]
`;
const threadFooterSelector = `.thread-scroll-container > [data-thread-scroll-footer]`;
const threadFooterBackdropSelector = `
  div:has(> [data-thread-scroll-footer]),
  div[class~="pointer-events-none"][class~="bottom-0"]:has([data-pip-obstacle="thread-footer"]),
  div[class~="pointer-events-none"][class~="bottom-0"]:has([data-thread-composer-backdrop])
`;
const nestedSurfaceSelector = `
  [data-app-shell-header-edge-scroll="true"] :is([data-app-shell-header-toolbar], [class*="_Toolbar_"]) > :not([data-app-shell-thread-content-overlap]),
  [data-app-shell-page-header],
  [data-app-shell-overlay-page-header],
  ${inlinePageHeaderSelector},
  :is(${inlinePageHeaderSelector}) > [class*="_content_"] > [class*="_headerRow_"],
  ${composerSpacerFadeSelector},
  ${threadFooterSelector},
  ${threadFooterBackdropSelector},
  :is(${threadFooterSelector}) > div[class~="pointer-events-none"][class~="absolute"][class~="inset-x-0"]:is([class~="bg-surface"], [class~="bg-surface-secondary"])
`;
const protectedSurfaceSelector = `
  dialog, [role="dialog"], [role="alertdialog"], [role="menu"],
  [role="listbox"], [role="tooltip"], [popover], [data-radix-popper-content-wrapper]
`;

function adaptiveRuntimeSource() {
  return `
    const autoState = new Map();
    const blockedSelector = "button, input, textarea, select, option, [contenteditable=true], [data-composer-body], [role=button], [role=menu], [role=menuitem], [role=dialog], [role=alertdialog]";
    const hintPattern = /shell|surface|panel|sidebar|header|titlebar|maincontent|thread|conversation|composer|fade|chrome/i;

    const hasVisibleBackground = (style) => {
      if (style.backgroundImage && style.backgroundImage !== "none") return true;
      const match = style.backgroundColor.match(/rgba?\\(([^)]+)\\)/i);
      if (!match) return style.backgroundColor !== "transparent";
      const parts = match[1].split(",").map((part) => part.trim());
      return parts.length < 4 || Number(parts[3]) > 0.03;
    };

    const hasVisibleBackdropFilter = (style) => [
      style.backdropFilter,
      style.webkitBackdropFilter
    ].some((value) => Boolean(value && value !== "none"));

    const saveInline = (element) => {
      if (autoState.has(element)) return;
      const properties = ["background", "background-color", "background-image", "border-color", "box-shadow", "backdrop-filter", "-webkit-backdrop-filter"];
      autoState.set(element, properties.map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      })));
    };

    const restoreAutoElement = (element) => {
      const declarations = autoState.get(element);
      if (!declarations) return;
      for (const { property, value, priority } of declarations) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
      element.removeAttribute("${AUTO_ATTRIBUTE}");
      autoState.delete(element);
    };

    const restoreAutoSubtree = (node) => {
      if (!(node instanceof Element)) return;
      restoreAutoElement(node);
      for (const element of node.querySelectorAll("[${AUTO_ATTRIBUTE}]")) restoreAutoElement(element);
    };

    const clearSurface = (element) => {
      saveInline(element);
      element.setAttribute("${AUTO_ATTRIBUTE}", "true");
      element.style.setProperty("background", "transparent", "important");
      element.style.setProperty("background-color", "transparent", "important");
      element.style.setProperty("background-image", "none", "important");
      element.style.setProperty("border-color", "transparent", "important");
      element.style.setProperty("box-shadow", "none", "important");
      element.style.setProperty("backdrop-filter", "none", "important");
      element.style.setProperty("-webkit-backdrop-filter", "none", "important");
    };

    const scanAdaptive = () => {
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      let visited = 0;
      for (const element of document.querySelectorAll("body *")) {
        if (++visited > 3000 || element.matches(blockedSelector) || element.closest("#codex-wallpaper-bridge-root")) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < innerWidth * .32 || rect.height < 48 || rect.bottom <= 0 || rect.right <= 0) continue;
        const areaRatio = rect.width * rect.height / viewportArea;
        const touchesViewportEdge = rect.left <= 6 || rect.top <= 6 || rect.right >= innerWidth - 6 || rect.bottom >= innerHeight - 6;
        const signature = [element.id, element.className, ...element.getAttributeNames()].join(" ");
        const isInsetBackground = element.classList.contains("absolute") && element.classList.contains("inset-0") && /bg-/i.test(signature);
        if (!hintPattern.test(signature) && !(areaRatio >= .18 && touchesViewportEdge) && !isInsetBackground) continue;
        const style = getComputedStyle(element);
        if (hasVisibleBackground(style) || hasVisibleBackdropFilter(style)) clearSurface(element);
      }
    };
  `;
}

export function buildCompatibilityScript({ adaptive = true } = {}) {
  const adaptiveSource = adaptive ? adaptiveRuntimeSource() : "";
  const observerCallback = adaptive
    ? `
        for (const mutation of mutations) {
          for (const node of mutation.removedNodes) restoreAutoSubtree(node);
        }
        scheduleScan();
      `
    : "if (!document.getElementById(STYLE_ID)) document.head.append(style);";
  const scheduleSource = adaptive
    ? `
      let frame = 0;
      const scheduleScan = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(scanAdaptive);
      };
      scheduleScan();
    `
    : "";
  const restoreAdaptive = adaptive
    ? `
        cancelAnimationFrame(frame);
        for (const element of [...autoState.keys()]) restoreAutoElement(element);
      `
    : "";

  return `(() => {
    const STYLE_ID = "${STYLE_ID}";
    const runtimeKey = "${RUNTIME_KEY}";
    window[runtimeKey]?.restore?.();
    document.getElementById(STYLE_ID)?.remove();

    document.documentElement.setAttribute("${ROOT_ATTRIBUTE}", "active");
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = \`
      html[${ROOT_ATTRIBUTE}="active"] :is(${semanticSelector}) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        border-color: transparent !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(${nestedSurfaceSelector}):not(
        button, input, textarea, select, option, [contenteditable="true"],
        [role="button"], [role="textbox"], [role="searchbox"], [role="menuitem"], [role="option"]
      ):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *) {
        background-color: transparent !important;
        background-image: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(${inlinePageHeaderSelector}):not(
        :is(${protectedSurfaceSelector})
      ):not(:is(${protectedSurfaceSelector}) *)::before {
        background-color: transparent !important;
        background-image: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] [data-app-shell-page-surface] {
        --app-shell-content-fade: none !important;
        --app-shell-content-fade-opacity: 0 !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-app-shell-main-content-top-fade],
        [class*="_MainContentTopFade_"],
        [class*="app-shell-content-fade"],
        [data-above-composer-portal] [class*="gradient" i],
        [class*="_BottomFade_"],
        [class*="_TopFade_"]
      ),
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-app-shell-main-content-top-fade],
        [class*="_MainContentTopFade_"],
        [class*="app-shell-content-fade"],
        [class*="_BottomFade_"],
        [class*="_TopFade_"],
        :is([data-thread-scroll-footer], ${threadFooterBackdropSelector}):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *)
      )::before,
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-app-shell-main-content-top-fade],
        [class*="_MainContentTopFade_"],
        [class*="app-shell-content-fade"],
        [class*="_BottomFade_"],
        [class*="_TopFade_"],
        :is([data-thread-scroll-footer], ${threadFooterBackdropSelector}):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *)
      )::after {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
    \`;
    (document.head || document.documentElement).append(style);

    ${adaptiveSource}
    ${scheduleSource}

    const observer = new MutationObserver((mutations) => {
      ${observerCallback}
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    const restore = () => {
      observer.disconnect();
      ${restoreAdaptive}
      document.getElementById(STYLE_ID)?.remove();
      document.documentElement.removeAttribute("${ROOT_ATTRIBUTE}");
      if (window[runtimeKey]?.restore === restore) delete window[runtimeKey];
      return true;
    };
    window[runtimeKey] = { restore, adaptive: ${adaptive ? "true" : "false"}, version: "0.1.5" };
    return { ok: true, adaptive: ${adaptive ? "true" : "false"} };
  })()`;
}

export function buildCompatibilityRestoreScript() {
  return `(() => {
    const runtime = window.${RUNTIME_KEY};
    if (runtime?.restore) runtime.restore();
    document.getElementById("${STYLE_ID}")?.remove();
    document.documentElement.removeAttribute("${ROOT_ATTRIBUTE}");
    for (const element of document.querySelectorAll("[${AUTO_ATTRIBUTE}]")) {
      element.removeAttribute("${AUTO_ATTRIBUTE}");
    }
    delete window.${RUNTIME_KEY};
    return true;
  })()`;
}
