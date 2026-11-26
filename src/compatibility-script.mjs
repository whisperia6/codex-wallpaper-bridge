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
  [role="listbox"], [role="tooltip"], [popover], [data-radix-popper-content-wrapper],
  [data-base-ui-portal], #gemini-neko-pet-root
`;

const antigravityPreservedSurfaceSelector = `
  .surface-composer,
  .surface-composer-card,
  .agy-user-bubble,
  [data-testid="user-message-bubble"]
`;

const antigravityShellSelector = `
  html,
  body,
  body.theme-standalone,
  body > #root,
  main,
  aside,
  header,
  nav,
  .agy-shell,
  .agy-inset-shell,
  .agy-sheet,
  .browser-hole-opaque,
  [data-sheet-inset],
  [data-main-content-header],
  [data-main-content-body],
  [data-side-panel-strip],
  [data-side-panel-body],
  [data-split-root],
  [data-split-panes],
  [data-tiling-pane],
  [data-testid="bottom-terminal-panel"],
  [data-testid="title-menu-bar"],
  [data-testid="pane-titlebar-toolbar"],
  [data-sidebar-section-drop-id],
  .bg-background,
  .bg-sidebar,
  .bg-sidebar-muted,
  [class~="!bg-background"],
  [class*="bg-[var(--shell-canvas)]"],
  [role="main"],
  [role="navigation"],
  [class*="AppShell" i],
  [class*="app-shell" i],
  [class*="Sidebar" i],
  [class*="LeftPanel" i],
  [class*="TitleBar" i],
  [class*="MainSurface" i],
  [class*="MainContent" i],
  [class*="ChatCanvas" i],
  [class*="Conversation" i],
  [class*="ThreadView" i],
  [data-testid*="sidebar" i],
  [data-testid*="titlebar" i],
  [data-testid*="conversation" i],
  [data-testid*="chat" i]
`;

const antigravityControlExclusions = `
  button, a, input, textarea, select, option, pre, code, [contenteditable="true"],
  [role="navigation"][aria-label="Sidebar"], .agy-sidebar-row, [data-selected="true"], [aria-current="page"],
  [role="button"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="option"]
`;

function adaptiveRuntimeSource({ hostType = "codex" } = {}) {
  const isAntigravity = hostType === "antigravity";
  const blockedSelector = isAntigravity
    ? "button, a, input, textarea, select, option, pre, code, [contenteditable=true], [data-composer-body], [role=navigation][aria-label=Sidebar], .surface-composer, .surface-composer-card, .agy-user-bubble, .agy-sidebar-row, [data-selected=true], [aria-current=page], [data-testid=user-message-bubble], [role=button], [role=textbox], [role=searchbox], [role=combobox], [role=menu], [role=menuitem], [role=listbox], [role=option], [role=dialog], [role=alertdialog], [role=tooltip], [popover], [data-base-ui-portal], #gemini-neko-pet-root"
    : "button, input, textarea, select, option, [contenteditable=true], [data-composer-body], aside.app-shell-left-panel, aside[data-app-shell-left-panel-appearance], aside[data-ds-part=sidebar], [role=button], [role=menu], [role=menuitem], [role=dialog], [role=alertdialog]";
  const skipClosestSelector = isAntigravity
    ? "#codex-wallpaper-bridge-root, #gemini-neko-pet-root, .surface-composer, .agy-user-bubble, [data-testid=user-message-bubble], [data-base-ui-portal], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=tooltip], [popover], [data-radix-popper-content-wrapper], pre, code"
    : "#codex-wallpaper-bridge-root";
  const geometryCheck = isAntigravity
    ? `
        const isTallSidebar = rect.width >= 160 && rect.height >= innerHeight * .55 && (rect.left <= 6 || rect.right >= innerWidth - 6);
        const isEdgeBar = rect.width >= innerWidth * .45 && rect.height >= 32 && rect.height <= 128 && (rect.top <= 6 || rect.bottom >= innerHeight - 6);
        const isScrollFade = element.classList.contains("pointer-events-none") && rect.width >= innerWidth * .28 && rect.height >= 16 && rect.height <= 120;
        if (!isTallSidebar && !isEdgeBar && !isScrollFade && (rect.width < innerWidth * .32 || rect.height < 48)) continue;
      `
    : `
        if (rect.width < innerWidth * .32 || rect.height < 48) continue;
      `;
  const matchCheck = isAntigravity
    ? `!hintPattern.test(signature) && !(areaRatio >= .18 && touchesViewportEdge) && areaRatio < .35 && !isInsetBackground && !isTallSidebar && !isEdgeBar && !isScrollFade`
    : `!hintPattern.test(signature) && !(areaRatio >= .18 && touchesViewportEdge) && !isInsetBackground`;
  return `
    const autoState = new Map();
    const blockedSelector = ${JSON.stringify(blockedSelector)};
    const hintPattern = /shell|surface|panel|sidebar|header|titlebar|maincontent|thread|conversation|composer|fade|chrome|canvas|workspace|layout|backdrop|agy-sheet|inset-shell|tiling-pane|split-panes|bg-background|bg-sidebar/i;

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
        if (++visited > 3000 || element.matches(blockedSelector) || element.closest(${JSON.stringify(skipClosestSelector)})) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.right <= 0) continue;
        ${geometryCheck}
        const areaRatio = rect.width * rect.height / viewportArea;
        const touchesViewportEdge = rect.left <= 6 || rect.top <= 6 || rect.right >= innerWidth - 6 || rect.bottom >= innerHeight - 6;
        const signature = [element.id, element.className, ...element.getAttributeNames()].join(" ");
        const isInsetBackground = element.classList.contains("absolute") && element.classList.contains("inset-0") && /bg-/i.test(signature);
        if (${matchCheck}) continue;
        const style = getComputedStyle(element);
        if (hasVisibleBackground(style) || hasVisibleBackdropFilter(style)) clearSurface(element);
      }
    };
  `;
}

function buildCompatibilityCss(hostType) {
  if (hostType === "antigravity") {
    return `
      html[${ROOT_ATTRIBUTE}="active"],
      html[${ROOT_ATTRIBUTE}="active"] body,
      html[${ROOT_ATTRIBUTE}="active"] body.theme-standalone,
      html[${ROOT_ATTRIBUTE}="active"] body.theme-light,
      html[${ROOT_ATTRIBUTE}="active"] body.dark,
      html[${ROOT_ATTRIBUTE}="active"] .agy-shell,
      html[${ROOT_ATTRIBUTE}="active"] .agy-inset-shell,
      html[${ROOT_ATTRIBUTE}="active"] .agy-sheet {
        color-scheme: dark !important;
        --background: transparent !important;
        --color-background: transparent !important;
        --body-background: transparent !important;
        --content: transparent !important;
        --sidebar: transparent !important;
        --color-sidebar: transparent !important;
        --shell: transparent !important;
        --shell-canvas: transparent !important;
        --home-glow: transparent !important;
        --card-edge: transparent !important;
        --card-gap: 0px !important;
        --card-gap-left: 0px !important;
        --card-gap-right: 0px !important;
        --card-radius: 0px !important;
        --foreground: #f4f4f6 !important;
        --secondary-foreground: rgba(244, 244, 246, 0.78) !important;
        --muted-foreground: rgba(244, 244, 246, 0.56) !important;
        --placeholder: rgba(244, 244, 246, 0.46) !important;
        --secondary: rgba(255, 255, 255, 0.08) !important;
        --muted: rgba(255, 255, 255, 0.05) !important;
        --sidebar-secondary: rgba(255, 255, 255, 0.08) !important;
        --sidebar-muted: rgba(255, 255, 255, 0.05) !important;
        --color-sidebar-muted: rgba(255, 255, 255, 0.05) !important;
        --card: rgba(24, 27, 36, 0.62) !important;
        --color-card: rgba(24, 27, 36, 0.62) !important;
        --card-border: rgba(255, 255, 255, 0.09) !important;
        --border: rgba(255, 255, 255, 0.07) !important;
        --glass: rgba(24, 27, 36, 0.66) !important;
        --glass-border: rgba(255, 255, 255, 0.10) !important;
        --glass-highlight: rgba(255, 255, 255, 0.10) !important;
        --onyx-frame: transparent !important;
        --onyx-well: rgba(255, 255, 255, 0.06) !important;
        --onyx-raised: rgba(24, 27, 36, 0.66) !important;
        --onyx-selected: rgba(255, 255, 255, 0.10) !important;
        --onyx-key: rgba(255, 255, 255, 0.14) !important;
        --editor-code-block-background: rgba(14, 16, 22, 0.54) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] body.theme-light {
        --syntax-comment: #8b949e !important;
        --syntax-punctuation: #c9d1d9 !important;
        --syntax-property: #79c0ff !important;
        --syntax-deleted: #ffa198 !important;
        --syntax-inserted: #7ee787 !important;
        --syntax-tag: #7ee787 !important;
        --syntax-constant: #79c0ff !important;
        --syntax-number: #79c0ff !important;
        --syntax-string: #a5d6ff !important;
        --syntax-attr-name: #79c0ff !important;
        --syntax-builtin: #ffa657 !important;
        --syntax-operator: #ff7b72 !important;
        --syntax-variable: #ffa657 !important;
        --syntax-attr-value: #a5d6ff !important;
        --syntax-keyword: #ff7b72 !important;
        --syntax-function: #d2a8ff !important;
        --syntax-class-name: #ffa657 !important;
        --syntax-regex: #a5d6ff !important;
        --syntax-default-fg: #f4f4f6 !important;
      }
      /* Keep popovers, menus and dialogs readable with solid surface tokens. */
      html[${ROOT_ATTRIBUTE}="active"] :is(${protectedSurfaceSelector}):not(#gemini-neko-pet-root) {
        --background: #141418 !important;
        --color-background: #141418 !important;
        --body-background: #141418 !important;
        --content: #141418 !important;
        --sidebar: #19191f !important;
        --color-sidebar: #19191f !important;
        --shell: #19191f !important;
        --shell-canvas: #19191f !important;
        --card: #1f1f27 !important;
        --color-card: #1f1f27 !important;
        --glass: #1f1f27 !important;
        --onyx-frame: #141418 !important;
        --onyx-raised: #1f1f27 !important;
        --border: rgba(255, 255, 255, 0.09) !important;
        --card-border: rgba(255, 255, 255, 0.10) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] body > #root {
        position: relative !important;
        z-index: 1 !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(${antigravityShellSelector}):not(
        ${antigravityControlExclusions}
      ):not(:is(${antigravityPreservedSurfaceSelector})):not(:is(${antigravityPreservedSurfaceSelector}) *):not(
        :is(${protectedSurfaceSelector})
      ):not(:is(${protectedSurfaceSelector}) *) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        border-color: transparent !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      /* Dissolve inset card margins, rounded frames and pseudo-element rims around panes. */
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-main-content-body],
        [data-side-panel-body]
      ):not(:is(${protectedSurfaceSelector}) *) {
        margin: 0px !important;
        border-radius: 0px !important;
        clip-path: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-main-content-body],
        [data-side-panel-body],
        [data-tiling-pane],
        [data-testid="bottom-terminal-panel"],
        [data-side-panel-strip],
        [data-testid="tiling-splitter"],
        [data-splitter-band]
      )::before,
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [data-main-content-body],
        [data-side-panel-body],
        [data-tiling-pane],
        [data-testid="bottom-terminal-panel"],
        [data-side-panel-strip],
        [data-testid="tiling-splitter"],
        [data-splitter-band]
      )::after,
      html[${ROOT_ATTRIBUTE}="active"] [data-hoisted-slot-rim] {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
      /* Subtle frosted-glass vibrancy on the outer left sidebar container to distinguish navigation from the clear canvas. */
      html[${ROOT_ATTRIBUTE}="active"]:not([data-cwb-sidebar-blur="off"]) [role="navigation"][aria-label="Sidebar"]:not(:is(${protectedSurfaceSelector}) *) {
        background: rgba(12, 16, 24, 0.22) !important;
        background-color: rgba(12, 16, 24, 0.22) !important;
        background-image: linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.03) 0%,
          rgba(12, 16, 24, 0.04) 100%
        ) !important;
        backdrop-filter: blur(var(--cwb-sidebar-blur, 16px)) saturate(118%) !important;
        -webkit-backdrop-filter: blur(var(--cwb-sidebar-blur, 16px)) saturate(118%) !important;
        border-top: 1px solid rgba(255, 255, 255, 0.04) !important;
        border-right: 1px solid rgba(255, 255, 255, 0.07) !important;
        border-bottom-color: transparent !important;
        border-left-color: transparent !important;
        box-shadow: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"][data-cwb-sidebar-blur="off"] [role="navigation"][aria-label="Sidebar"]:not(:is(${protectedSurfaceSelector}) *) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
      /* Keep sidebar, menu bar and header controls borderless at rest with gentle hover/active pills. */
      html[${ROOT_ATTRIBUTE}="active"] [data-testid="title-menu-bar"] :is(button, [role="button"]):not(:hover):not([aria-expanded="true"]):not([data-state="open"]),
      html[${ROOT_ATTRIBUTE}="active"] [data-main-content-header] :is(button, a, [role="button"]):not(:hover):not([aria-expanded="true"]):not([data-state="open"]),
      html[${ROOT_ATTRIBUTE}="active"] [role="navigation"][aria-label="Sidebar"] :is(
        a[data-testid="new-conversation-button"],
        [data-testid="automations-button"],
        [data-testid="settings-button"],
        button[data-project-card="true"],
        [data-testid="project-header"]
      ):not(:hover),
      html[${ROOT_ATTRIBUTE}="active"] .agy-sidebar-row:not([data-selected="true"]):not(:hover) {
        background: transparent !important;
        background-color: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        --row-bg: transparent !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .agy-sidebar-row .agy-row-actions::before,
      html[${ROOT_ATTRIBUTE}="active"] .agy-sidebar-row .agy-row-shortcut-badge::before {
        background: transparent !important;
        background-image: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] [role="navigation"][aria-label="Sidebar"] .h-px {
        background-color: rgba(255, 255, 255, 0.05) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] [data-testid="title-menu-bar"] :is(button, [role="button"]):hover,
      html[${ROOT_ATTRIBUTE}="active"] [data-main-content-header] :is(button, a, [role="button"]):hover,
      html[${ROOT_ATTRIBUTE}="active"] [role="navigation"][aria-label="Sidebar"] :is(
        a[data-testid="new-conversation-button"],
        [data-testid="automations-button"],
        [data-testid="settings-button"],
        button[data-project-card="true"],
        [data-testid="project-header"]
      ):hover,
      html[${ROOT_ATTRIBUTE}="active"] .agy-sidebar-row:not([data-selected="true"]):hover {
        background: rgba(255, 255, 255, 0.07) !important;
        background-color: rgba(255, 255, 255, 0.07) !important;
        border-color: transparent !important;
        box-shadow: none !important;
        --row-bg: transparent !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .agy-sidebar-row[data-selected="true"] {
        background: rgba(255, 255, 255, 0.10) !important;
        background-color: rgba(255, 255, 255, 0.10) !important;
        border-color: transparent !important;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
        --row-bg: transparent !important;
      }
      /* Cohesive frosted-glass composer capsule and user message bubbles (Codex parity). */
      html[${ROOT_ATTRIBUTE}="active"] .surface-composer {
        background: transparent !important;
        background-color: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .surface-composer > .surface-composer-card {
        background: rgba(24, 27, 36, 0.68) !important;
        background-color: rgba(24, 27, 36, 0.68) !important;
        backdrop-filter: blur(20px) saturate(135%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(135%) !important;
        box-shadow:
          0 10px 30px -8px rgba(0, 0, 0, 0.36),
          inset 0 1px 0 rgba(255, 255, 255, 0.12),
          0 0 0 1px rgba(255, 255, 255, 0.09) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .surface-composer:focus-within > .surface-composer-card {
        background: rgba(26, 29, 39, 0.74) !important;
        background-color: rgba(26, 29, 39, 0.74) !important;
        box-shadow:
          0 12px 34px -8px rgba(0, 0, 0, 0.42),
          inset 0 1px 0 rgba(255, 255, 255, 0.16),
          0 0 0 1px rgba(255, 255, 255, 0.15) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .surface-composer-card button:not(.agy-send-button):not(:hover):not([aria-expanded="true"]) {
        background: transparent !important;
        background-color: transparent !important;
        box-shadow: none !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] .surface-composer-card button:not(.agy-send-button):hover {
        background-color: rgba(255, 255, 255, 0.08) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] :is(.agy-user-bubble, [data-testid="user-message-bubble"]) {
        background: rgba(28, 31, 42, 0.56) !important;
        background-color: rgba(28, 31, 42, 0.56) !important;
        backdrop-filter: blur(16px) saturate(130%) !important;
        -webkit-backdrop-filter: blur(16px) saturate(130%) !important;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.10),
          0 0 0 1px rgba(255, 255, 255, 0.08),
          0 6px 18px -6px rgba(0, 0, 0, 0.24) !important;
      }
      html[${ROOT_ATTRIBUTE}="active"] button[aria-label="Scroll to Bottom"] {
        background: rgba(24, 27, 36, 0.68) !important;
        background-color: rgba(24, 27, 36, 0.68) !important;
        backdrop-filter: blur(14px) !important;
        -webkit-backdrop-filter: blur(14px) !important;
        border-color: rgba(255, 255, 255, 0.10) !important;
      }
      /* Clear top and bottom scroll gradient fades above the composer. */
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [class*="gradient" i][class*="pointer-events-none"],
        [data-main-content-body] .pointer-events-none.bottom-0,
        [data-main-content-body] .pointer-events-none.top-0,
        [data-side-panel-body] .pointer-events-none.bottom-0,
        [data-side-panel-body] .pointer-events-none.top-0,
        .agy-sheet .pointer-events-none.absolute.bottom-0,
        .agy-sheet .pointer-events-none.absolute.top-0,
        [class*="_BottomFade_"],
        [class*="_TopFade_"]
      ):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *),
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [class*="_BottomFade_"],
        [class*="_TopFade_"]
      ):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *)::before,
      html[${ROOT_ATTRIBUTE}="active"] :is(
        [class*="_BottomFade_"],
        [class*="_TopFade_"]
      ):not(:is(${protectedSurfaceSelector})):not(:is(${protectedSurfaceSelector}) *)::after {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
      }
    `;
  }
  return `
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
    `;
}

export function buildCompatibilityScript({ adaptive = true, hostType = "codex" } = {}) {
  const normalizedHostType = hostType === "antigravity" ? "antigravity" : "codex";
  const isAntigravity = normalizedHostType === "antigravity";
  const adaptiveSource = adaptive ? adaptiveRuntimeSource({ hostType: normalizedHostType }) : "";
  const titleBarOverlaySetup = isAntigravity
    ? `
      const syncTitleBarOverlay = () => {
        try {
          window.electronNative?.setTitleBarOverlay?.({ color: "#00000000", symbolColor: "#f4f4f6" });
        } catch {}
      };
      const restoreTitleBarOverlay = () => {
        try {
          if (!window.electronNative?.setTitleBarOverlay) return;
          const isLight = Boolean(document.body?.classList?.contains("theme-light"));
          const cs = getComputedStyle(document.documentElement);
          const color = cs.getPropertyValue("--sidebar").trim() || (isLight ? "#FFFFFF" : "#131313");
          const symbolColor = cs.getPropertyValue("--secondary-foreground").trim() || (isLight ? "#000000" : "#FAFAFA");
          window.electronNative.setTitleBarOverlay({ color, symbolColor });
        } catch {}
      };
      syncTitleBarOverlay();
    `
    : "";
  const titleBarObserverSync = isAntigravity
    ? `
      if (mutations.some((m) => m.type === "attributes" && (m.target === document.body || m.target === document.documentElement))) {
        syncTitleBarOverlay();
      }
    `
    : "";
  const observerCallback = adaptive
    ? `
        for (const mutation of mutations) {
          for (const node of mutation.removedNodes) restoreAutoSubtree(node);
        }
        ${titleBarObserverSync}
        scheduleScan();
      `
    : `
        if (!document.getElementById(STYLE_ID)) (document.head || document.documentElement).append(style);
        ${titleBarObserverSync}
      `;
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
    style.textContent = \`${buildCompatibilityCss(normalizedHostType)}\`;
    (document.head || document.documentElement).append(style);

    ${titleBarOverlaySetup}
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
      ${isAntigravity ? "restoreTitleBarOverlay();" : ""}
      if (window[runtimeKey]?.restore === restore) delete window[runtimeKey];
      return true;
    };
    window[runtimeKey] = { restore, adaptive: ${adaptive ? "true" : "false"}, hostType: ${JSON.stringify(normalizedHostType)}, version: "0.2.1" };
    return { ok: true, adaptive: ${adaptive ? "true" : "false"}, hostType: ${JSON.stringify(normalizedHostType)} };
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
