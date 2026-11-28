const { app, BrowserWindow, session } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let config = { effects: { fit: 'contain', glassTint: 'neutral', glassBlur: 22 } };
  const writes = [];
  const publicDir = path.resolve(__dirname, '../bridge-runtime/public');
  await session.defaultSession.protocol.handle('http', async request => {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/config' && request.method === 'POST') {
        config = await request.json();
        writes.push(config);
      }
      if (pathname === '/api/media') return Response.json({
        power: {}, occluded: true, sources: {}, commands: [], lyric: {}, inputs: [],
      });
      return Response.json({ config, projects: [], power: {} });
    }
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (path.basename(file) !== file) return new Response(null, { status: 404 });
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(file)];
    if (!type) return new Response(null, { status: 404 });
    const body = await readFile(path.join(publicDir, file)).catch(() => null);
    return new Response(body, { status: body ? 200 : 404, headers: { 'content-type': type + '; charset=utf-8' } });
  });

  const window = new BrowserWindow({ width: 1024, height: 768, show: false, webPreferences: {
    offscreen: true, sandbox: true, backgroundThrottling: false,
  } });
  await window.loadURL('http://lumina-fixture.test/');
  const proof = await window.webContents.executeJavaScript(`(${verifySettings.toString()})()`);
  process.stdout.write('CWB_SETTINGS_UI ' + JSON.stringify({ ...proof, writes }) + '\n');
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

async function verifySettings() {
  const noTransition = document.createElement('style');
  noTransition.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.append(noTransition);
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const activeTab = () => $('[role="tab"][aria-selected="true"]').dataset.settingsTabTrigger;
  const tab = name => $(`[data-settings-tab-trigger="${name}"]`);
  const change = (selector, value, type = 'change') => {
    const input = $(selector);
    input.value = value;
    input.dispatchEvent(new Event(type, { bubbles: true }));
  };
  const picked = id => $(`input[name="${id}"]:checked`)?.value;
  const choose = (id, value) => $(`input[name="${id}"][value="${value}"]`).click();
  const swatch = () => {
    const style = getComputedStyle($('.glass-swatch-pill'));
    return { text: $('#glassSwatchStatus').value, background: style.backgroundColor, border: style.borderColor,
      filter: style.backdropFilter, visibility: style.visibility };
  };
  const waitFor = async selector => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if ($(selector)) return;
      await new Promise(requestAnimationFrame);
    }
    throw Error('Timed out waiting for ' + selector);
  };
  await waitFor('input[name="fitSelect"][value="contain"]:checked');
  const initial = { tab: activeTab(), fit: picked('fitSelect'), framingOpen: $('#framingTools').open };
  choose('fitSelect', 'fill');
  const fitByPill = $('#fitSelect').value;
  change('#fitSelect', 'cover');
  const fitBySelect = picked('fitSelect');

  tab('appearance').focus();
  tab('appearance').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const navigation = { tab: activeTab(), focus: document.activeElement.id,
    panel: $('[role="tabpanel"]:not([hidden])').id, tabbable: $$('[role="tab"]').filter(button => button.tabIndex === 0).length };
  const dark = swatch();
  choose('glassTintSelect', 'frost');
  const tintByPill = $('#glassTintSelect').value;
  change('#glassTintSelect', 'dark', 'input');
  const tintByInput = picked('glassTintSelect');
  change('#glassTintSelect', 'frost');
  const tintBySelect = picked('glassTintSelect');
  change('#glassOpacityRange', '80', 'input');
  change('#glassBlurRange', '31', 'input');
  change('#glassBorderOpacityRange', '45', 'input');
  change('#glassSaturationRange', '175', 'input');
  const edited = swatch();
  $('#sidebarBlurToggle').click();
  $('#liquidGlassToggle').click();
  const disabled = { ...swatch(), fieldset: $('#liquidGlassControls').disabled,
    controls: $$('#liquidGlassControls input, #liquidGlassControls select').every(input => input.matches(':disabled')) };
  $('#liquidGlassToggle').click();
  const restored = { ...swatch(), fieldset: $('#liquidGlassControls').disabled, sidebar: $('#sidebarBlurToggle').checked };

  $('[data-theme-choice="light"]').click();
  const light = { theme: document.documentElement.dataset.workbenchTheme, ...swatch(),
    card: getComputedStyle($('#settings-panel-glass .settings-card')).backgroundColor };
  tab('playback').click();
  await waitFor('#playbackPolicyStatus:not(:empty)');
  const occlusion = { enabled: $('#pauseWhenOccludedInput').checked, status: $('#playbackPolicyStatus').textContent };
  $('#pauseWhenOccludedInput').click();
  const playback = { tab: activeTab(), webOpen: $('#webLoopTools').open, transitionOpen: $('#transitionTools').open };
  tab('appearance').click();
  const framingOpen = $('#framingTools').open;
  await waitFor('#saveIndicator:not(.is-saving, .is-error)');
  return { initial, fitByPill, fitBySelect, navigation, dark, tintByPill, tintByInput, tintBySelect, edited,
    disabled, restored, light, playback, occlusion, framingOpen };
}
