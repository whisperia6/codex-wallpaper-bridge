// Synthetic, hidden Chromium fixture. Never connects to a real Codex process.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (path.resolve(input.root) !== path.dirname(path.resolve(process.argv[2]))) {
  throw Error('Fixture output must stay beside its owned input file');
}
app.setPath('userData', path.join(input.root, 'profile'));
app.disableHardwareAcceleration();
let win;

const html = (theme) => `<!doctype html><html data-fixture-theme="${theme}"><meta charset="utf-8">
<style>
  :root { --color-surface: ${theme === 'dark' ? '#181818' : '#ffffff'}; --composer-layout-surface-background: var(--color-surface); color-scheme: ${theme}; }
  body { margin: 20px; background: #526b8a; color: ${theme === 'dark' ? '#eee' : '#222'}; font: 16px sans-serif; }
  /* Same structural selectors as the installed shell and composer CSS. */
  [data-app-shell-header-edge-scroll=true] ._Toolbar_fixture_2 > :not([data-app-shell-thread-content-overlap]) { background-color: var(--color-surface); }
  ._PageSurfaceLayout_fixture_2 [data-app-shell-page-header]:has([data-app-shell-overlay-page-header]) { background-color: var(--color-surface); }
  [data-composer-utility-bar-variant=home] ._ComposerLayoutBody_fixture_2 { background-color: var(--composer-layout-surface-background); }
  /* Shared sticky page header paints its opaque backing in ::before. */
  ._shell_fixture_2[data-sticky] { position: relative; z-index: 0; }
  ._shell_fixture_2[data-sticky]::before { content: ''; position: absolute; inset: 0; z-index: -1; background-color: var(--color-surface); }
  [data-new-slate-layout] ._shell_fixture_2[data-sticky] ._headerRow_fixture_2 { background-color: var(--color-surface); }
  .thread-scroll-container .sticky.bottom-0 > .bg-gradient-to-t.from-surface { height: 32px; background-image: linear-gradient(to top, var(--color-surface), transparent); }
  [data-thread-scroll-footer] { background-color: var(--color-surface); }
  [data-thread-scroll-footer] > .bg-surface { background-color: var(--color-surface); }
  #threadFooter { position: relative; width: 600px; height: 70px; }
  #footerBacking { position: absolute; inset: 0; pointer-events: none; }
  .fixture-surface { width: 220px; min-height: 32px; margin-bottom: 12px; border: 1px solid #778899; box-shadow: 0 0 0 2px #667788; }
  button, input, [contenteditable], #attachment, #overlap, #unrelated { background: var(--color-surface); color: inherit; border: 1px solid #778899; }
  input:focus, [contenteditable]:focus { outline: 2px solid #83b5ff; }
  [data-testid="composer-input"] {
    background-color: var(--color-surface); border: 1px solid #83b5ff; box-shadow: 0 0 0 2px #667788;
  }
  div[data-testid="composer-input"] { width: 500px; min-height: 48px; }
  #attachment { width: 36px; height: 24px; background-image: linear-gradient(45deg, #ac8fb1, #dbb8c2); }
  #codex-wallpaper-bridge-root { position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: linear-gradient(120deg, #627ca2, #b9a4b8 45%, #5a6b94); }
</style>
<div id="codex-wallpaper-bridge-root"></div>
<div data-app-shell-header-edge-scroll="true"><div data-app-shell-header-toolbar>
  <div id="composerPlaintext" contenteditable="plaintext-only" data-testid="composer-input">Plain text</div>
  <div id="composerEmptyEditable" contenteditable data-testid="composer-input">Editable</div>
  <div id="composerReadOnly" contenteditable="false" class="composer-shell fixture-surface">Read only shell</div>
</div></div>
<div hidden>${'<span></span>'.repeat(3200)}</div>
<div data-app-shell-header-edge-scroll="true"><div class="_Toolbar_fixture_2" data-app-shell-header-toolbar>
  <div id="toolbar" class="fixture-surface"><button id="button">Project</button></div>
  <button id="directButton">Toolbar action</button><div id="directRoleButton" role="button">Toolbar control</div>
  <div id="overlap" data-app-shell-thread-content-overlap>Overlapping content</div>
</div></div>
<div data-app-shell-header-edge-scroll="true"><div class="_Toolbar_fixture_2">
  <div id="legacyToolbar" class="fixture-surface">Legacy toolbar</div>
</div></div>
<div class="_PageSurfaceLayout_fixture_2"><div id="spaceHeader" class="fixture-surface" data-app-shell-page-header>
  <div data-app-shell-overlay-page-header><h2>Spaces</h2><input id="search" aria-label="Search" value="fixture"></div>
</div></div>
<div data-app-shell-inline-page-header="true" data-new-slate-layout>
  <div id="stickyHeader" class="_shell_fixture_2 fixture-surface" data-sticky="true">
    <div class="_content_fixture_2"><div id="stickyHeaderRow" class="_headerRow_fixture_2"><h1>Plugins</h1><button id="pluginAction">Add</button></div></div>
  </div>
  <div id="unrelatedSticky" data-sticky="true" class="fixture-surface" style="background-color:var(--color-surface)">Unrelated sticky surface</div>
</div>
<div class="thread-scroll-container"><div class="pointer-events-none sticky bottom-0">
  <div id="composerFade" class="pointer-events-none absolute h-8 bg-gradient-to-t from-surface"></div>
</div></div>
<div class="thread-scroll-container"><div id="threadFooter" data-thread-scroll-footer="true">
  <div id="footerBacking" class="pointer-events-none absolute inset-x-0 bottom-0 bg-surface"></div>
  <div data-pip-obstacle="thread-footer"><button id="footerAction">Send</button></div>
</div></div>
<div data-thread-scroll-footer="true"><div id="unrelatedFooter" class="pointer-events-none absolute inset-x-0 bg-surface">Unrelated footer</div></div>
<div role="dialog"><div class="thread-scroll-container"><div id="dialogFooter" data-thread-scroll-footer="true">
  <div id="dialogFooterBacking" class="pointer-events-none absolute inset-x-0 bg-surface"></div>
</div></div></div>
<div id="contentGradient" class="bg-gradient-to-t from-surface" style="background-image:linear-gradient(to top,#9381b1,transparent)">Content gradient</div>
<div data-composer-surface-variant="default" data-composer-utility-bar-variant="home">
  <div id="composerBody" data-composer-body class="_ComposerLayoutBody_fixture_2 fixture-surface" style="background-color: var(--composer-layout-surface-background)">
    <div id="attachment"></div><div id="editor" contenteditable="true" role="textbox">Fixture text</div>
    <textarea id="composerInput" data-testid="composer-input">Draft</textarea>
  </div>
</div>
<div role="menu" data-composer-surface-variant="default" data-composer-utility-bar-variant="home">
  <div id="menuSurface" data-composer-body class="_ComposerLayoutBody_fixture_2">Menu</div>
</div>
<div role="dialog"><div class="_PageSurfaceLayout_fixture_2"><div id="dialogSurface" data-app-shell-page-header>
  <div data-app-shell-overlay-page-header>Dialog</div>
</div></div></div>
<div role="dialog"><div data-app-shell-inline-page-header="true"><div id="dialogStickyHeader" class="_shell_fixture_2 fixture-surface" data-sticky="true"><div class="_content_fixture_2"><div class="_headerRow_fixture_2">Dialog title</div></div></div></div></div>
<div id="unrelated">Unrelated background</div>
</html>`;

const snapshot = `(() => {
  const ids = ['toolbar','legacyToolbar','spaceHeader','stickyHeader','stickyHeaderRow','pluginAction','unrelatedSticky','composerFade','threadFooter','footerBacking','footerAction','unrelatedFooter','dialogFooter','dialogFooterBacking','contentGradient','dialogStickyHeader','composerBody','button','directButton','directRoleButton','search','editor','composerInput','composerPlaintext','composerEmptyEditable','composerReadOnly','attachment','menuSurface','dialogSurface','overlap','unrelated'];
  return Object.fromEntries(ids.map(id => {
    const e = document.getElementById(id), s = getComputedStyle(e);
    return [id, { background: s.backgroundColor, image: s.backgroundImage, border: s.border,
      outline: s.outline, shadow: s.boxShadow, font: s.font, color: s.color, inlineStyle: e.getAttribute('style'),
      before: { background: getComputedStyle(e, '::before').backgroundColor, image: getComputedStyle(e, '::before').backgroundImage } }];
  }));
})()`;

async function evaluate(source) { return win.webContents.executeJavaScript(source); }
async function frames() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function proveLiquidGlass(host, scripts) {
  const antigravity = host === 'antigravity';
  const sidebar = antigravity ? '<nav id="sidebar" role="navigation" aria-label="Sidebar"></nav>'
    : '<aside id="sidebar" data-app-shell-left-panel-appearance></aside>';
  const card = (id, content = '') => antigravity
    ? `<div id="${id}" class="surface-composer-card">${content}</div>`
    : `<div data-composer-placement="thread"><div id="${id}" data-composer-body data-testid="composer-card">${content}</div></div>`;
  const fixture = `<!doctype html><html data-theme="dark"><style>
    #sidebar, #composer, #bubble, #scroll, #editor, #code, #action,
    #menu, #dialog, #tooltip, #radixCard, #baseCard { background-color: rgb(54, 54, 54); color: white; }
    #editor { outline: 1px solid white; } #code { background-color: #161616; }
    ${antigravity ? `
      :root { --card: #28323c; --glass: #303c48; --background: #202830; }
      #tokenDialog, #tokenMenu { background-color: var(--card); }
      #dialogGlass { background-color: var(--glass); }
      #dialogBackground { background-color: var(--background); }
    ` : ''}
  </style><body><div id="root">
    ${sidebar}
    ${card('composer', '<div id="editor" contenteditable="true">Input</div><button id="action">Send</button>')}
    <div id="bubble" ${antigravity ? 'class="agy-user-bubble"' : 'data-user-message-bubble'}><code id="code">sample</code></div>
    <button id="scroll" aria-label="Scroll to Bottom">Down</button>
    <div id="menu" role="menu" data-testid="composer-menu"></div>
    <div id="dialog" role="dialog" data-testid="composer-dialog"></div>
    <div id="tooltip" role="tooltip" data-testid="composer-tooltip"></div>
    <div data-radix-popper-content-wrapper>${card('radixCard')}</div>
    <div data-base-ui-portal>${card('baseCard')}</div>
    ${antigravity ? `
      <dialog id="tokenDialog" open><div class="agy-sheet">
        <div id="dialogGlass">Glass token</div><div id="dialogBackground">Background token</div>
      </div></dialog>
      <div data-base-ui-portal><div id="tokenMenu" role="menu">Menu token</div></div>
    ` : ''}
  </div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
  await evaluate('document.getElementById("editor").focus()');
  const snapshot = `(() => {
    const { style, dataset } = document.documentElement;
    const attributes = Object.fromEntries(Object.entries(dataset)
      .filter(([name]) => /^cwb(Glass|LiquidGlass|SidebarBlur)/.test(name)));
    const properties = ['--cwb-glass-opacity', '--cwb-glass-blur', '--cwb-glass-border-opacity',
      '--cwb-glass-saturation', '--cwb-sidebar-alpha'].map(name => style.getPropertyValue(name));
    const surfaces = ['sidebar', 'composer', 'bubble', 'scroll', 'editor', 'code', 'action',
      'menu', 'dialog', 'tooltip', 'radixCard', 'baseCard'];
    const result = Object.fromEntries(surfaces.map(id => {
      const element = document.getElementById(id);
      const { backgroundColor, backdropFilter, boxShadow, color, overflow, outline } = getComputedStyle(element);
      return [id, { background: backgroundColor, filter: backdropFilter, shadow: boxShadow, color, overflow, outline }];
    }));
    const token = document.createElement('div');
    token.style.backgroundColor = 'var(--card)';
    document.getElementById('root').append(token);
    const cardToken = getComputedStyle(token).backgroundColor;
    token.remove();
    const protectedTokens = Object.fromEntries(['tokenDialog', 'tokenMenu', 'dialogGlass', 'dialogBackground']
      .map(id => document.getElementById(id)).filter(Boolean)
      .map(element => [element.id, getComputedStyle(element).backgroundColor]));
    return { ...result, root: { attributes, properties }, cardToken, protectedTokens, focus: document.activeElement.id,
      wallpaper: !!document.getElementById('codex-wallpaper-bridge-root') };
  })()`;
  const before = await evaluate(snapshot);
  // Shadow location for the isolated fixture. The production origin guard stays intact.
  const bootstrapSource = `(() => { const location = undefined; return ${scripts.bootstrap}; })()`;
  const bootstrap = await evaluate(bootstrapSource);
  if (!bootstrap.ready) throw Error(`${host} bootstrap was not ready`);
  await evaluate(scripts.updates[0][1]);
  const fallback = await evaluate(snapshot);
  const standalone = {};
  if (antigravity) {
    for (const name of ['zero', 'neutral']) {
      await evaluate(scripts.updates.find(([key]) => key === name)[1]);
      standalone[name] = await evaluate(snapshot);
    }
    await evaluate(scripts.restore);
    standalone.restored = await evaluate(snapshot);
    await evaluate(bootstrapSource);
  }
  await evaluate(scripts.compat);
  const states = {};
  for (const [name, script] of scripts.updates) {
    await evaluate(script);
    await frames();
    states[name] = await evaluate(snapshot);
  }
  await evaluate(input.restore);
  await evaluate(scripts.restore);
  return { before, fallback, standalone, ...states, restored: await evaluate(snapshot) };
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1000, height: 850, show: false, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const proof = {};
  for (const theme of ['dark', 'light']) {
    const errors = [];
    const consoleError = (_event, level, message) => { if (level === 3) errors.push(message); };
    win.webContents.on('console-message', consoleError);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(theme)));
    await evaluate('document.getElementById("composerInput").focus()');
    const before = await evaluate(snapshot);
    if (input.capture === true) {
      writeFileSync(path.join(input.root, theme + '-before.png'), (await win.webContents.capturePage()).toPNG());
    }
    await evaluate(input.safe);
    await frames();
    const safe = await evaluate(snapshot);
    if (input.capture === true) {
      writeFileSync(path.join(input.root, theme + '-after.png'), (await win.webContents.capturePage()).toPNG());
    }
    const safeInputFocused = await evaluate('document.activeElement === document.getElementById("composerInput")');
    const footerScanIndex = await evaluate('[...document.querySelectorAll("body *")].indexOf(document.getElementById("footerBacking"))');
    await evaluate('document.getElementById("footerBacking").replaceWith(document.getElementById("footerBacking").cloneNode(true))');
    const footerReplacement = (await evaluate(snapshot)).footerBacking;
    await evaluate('document.getElementById("composerBody").replaceWith(document.getElementById("composerBody").cloneNode(true))');
    const replacement = (await evaluate(snapshot)).composerBody;
    await evaluate('document.getElementById("composerBody").removeAttribute("data-composer-body")');
    const repurposed = (await evaluate(snapshot)).composerBody;
    await evaluate('document.getElementById("composerBody").setAttribute("data-composer-body", "")');
    await evaluate('document.getElementById("composerInput").focus()');
    await evaluate(input.safe);
    const styleCount = await evaluate('document.querySelectorAll("#codex-wallpaper-electron-compat-style").length');
    await evaluate(input.restore);
    const afterRestore = {
      styles: await evaluate(snapshot),
      ...await evaluate('({styleCount:document.querySelectorAll("#codex-wallpaper-electron-compat-style").length,runtime:!!window.__codexWallpaperElectronCompat,marker:document.documentElement.hasAttribute("data-cwb-electron-compat")})'),
    };
    await evaluate(input.adaptive);
    await frames();
    const adaptive = await evaluate(snapshot);
    const themeUnchanged = await evaluate('document.documentElement.getAttribute("data-fixture-theme") === ' + JSON.stringify(theme));
    await evaluate(input.restore);
    win.webContents.removeListener('console-message', consoleError);
    proof[theme] = { before, safe, safeInputFocused, footerScanIndex, footerReplacement, replacement, repurposed, styleCount, afterRestore, adaptive, themeUnchanged, errors };
  }
  if (input.glass) {
    proof.glass = {};
    for (const [host, scripts] of Object.entries(input.glass)) proof.glass[host] = await proveLiquidGlass(host, scripts);
  }
  writeFileSync(path.join(input.root, 'proof.json'), JSON.stringify(proof));
  process.stdout.write('CWB_COMPAT_SURFACES_OK\n');
  win.destroy();
  app.quit();
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  win?.destroy();
  app.exit(1);
});
