/* Isolated static UI verification. Never discovers Codex, starts a bridge or reads daily config. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

const workspace = path.resolve(__dirname, '..');
const root = path.join(workspace, 'out', 'settings-ui', `${Date.now()}-${randomUUID().slice(0, 8)}`);
require('node:fs').mkdirSync(path.join(root, 'profile'), { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
app.setAppLogsPath(path.join(root, 'logs'));
app.on('window-all-closed', () => {});
const report = { scope: 'isolated-static-settings-ui', hostAcceptance: false, steps: [], errors: [] };
const desktopOnly = process.argv.includes('--desktop-only');
report.mode = desktopOnly ? 'desktop-theme-persistence' : 'complete';
let win;
const servers = [];

async function evaluate(code) { return win.webContents.executeJavaScript(code); }
async function settle() { await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); }
async function step(name, work) {
  if (desktopOnly && !name.startsWith('real desktop adapter')) return;
  await work(); report.steps.push(name);
}
async function capture(name) {
  await settle();
  const rect = await evaluate(`(() => { const r = document.querySelector('.settings').getBoundingClientRect();
    return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()`);
  await fs.writeFile(path.join(root, `${name}.png`), (await win.webContents.capturePage(rect)).toPNG());
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  await settle();
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
    if (!e.contains(hit)) throw Error('Hit target blocked: ' + ${JSON.stringify(selector)}); return {x, y}; })()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await settle();
}

async function main() {
  await app.whenReady();
  // Keep the real markup/styles, but remove all production scripts so no API or host actions run.
  const source = await fs.readFile(path.join(workspace, 'bridge-runtime/public/index.html'), 'utf8');
  const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
    script => script.includes('src="workbench-theme.js"') ? script.replace('src="workbench-theme.js"',
      `src="${pathToFileURL(path.join(workspace, 'bridge-runtime/public/workbench-theme.js')).href}"`) : '')
    .replace('href="styles.css"', `href="${pathToFileURL(path.join(workspace, 'bridge-runtime/public/styles.css')).href}"`);
  const fixturePath = path.join(root, 'preview.html');
  await fs.writeFile(fixturePath, fixture, { flag: 'wx' });
  win = new BrowserWindow({ width: 1360, height: 1220, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      partition: `settings-ui-${randomUUID()}` } });
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const allowed = /^(?:file:|data:|about:)/.test(details.url);
    if (!allowed) report.errors.push(`Unexpected request blocked: ${new URL(details.url).origin}`);
    done({ cancel: !allowed });
  });
  await win.loadFile(fixturePath);
  win.webContents.debugger.attach('1.3');
  // Focus only this hidden document in Chromium; never foreground or focus a native window.
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  report.focus = 'isolated-document-emulation';
  report.electron = process.versions.electron;
  report.chromium = process.versions.chrome;
  await evaluate(`(() => {
    const defaults = {positionX:50,positionY:50,zoom:100,playbackRate:1,contrast:100,opacity:100,volume:50,transitionDurationMs:600};
    document.querySelectorAll('[data-effect]').forEach(input => {
      if (Object.hasOwn(defaults, input.dataset.effect)) input.value = defaults[input.dataset.effect];
    });
    document.querySelectorAll('.range').forEach(input => input.style.setProperty('--range-progress',
      ((Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))*100)+'%'));
    document.querySelector('#systemMediaStatus').textContent = '频谱：off；媒体：off';
    document.querySelector('#backgroundPlaceholder').classList.add('is-visible');
  })()`);
  await step('native accordion and shared form styles', async () => {
    assert.equal(await evaluate(`document.querySelector('#transitionTools').open`), true);
    await click('#transitionTools > summary');
    assert.equal(await evaluate(`document.querySelector('#transitionTools').open`), false);
    await click('#transitionTools > summary');
    assert.equal(await evaluate(`document.querySelector('#transitionTools').open`), true);
    const styles = await evaluate(`['#transitionSelect','#transitionDurationNumber','#videoEncoder','#videoFpsCap'].map(selector => {
      const s = getComputedStyle(document.querySelector(selector)); return [s.borderRadius,s.backgroundColor,s.fontSize,s.minHeight]; })`);
    assert.ok(styles.every(style => style[0] === '8px' && style[1] === styles[0][1] && style[3] === '32px'));
    assert.equal(await evaluate(`document.querySelector('#systemLyricsInput').labels.length`), 1);
  });
  await step('checkbox mouse, keyboard, disabled and visible focus behavior', async () => {
    await click('#systemMediaPanel > summary');
    await click('[data-media="captureAudio"]');
    assert.equal(await evaluate(`document.querySelector('[data-media="captureAudio"]').checked`), true);
    await evaluate(`document.querySelector('[data-media="captureAudio"]').focus()`);
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Space' });
    await settle();
    assert.equal(await evaluate(`document.querySelector('[data-media="captureAudio"]').checked`), false);
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Tab' });
    await settle();
    assert.equal(await evaluate(`document.activeElement.matches('[data-media="nowPlaying"]:focus-visible')`), true);
    assert.equal(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'solid');
    await evaluate(`document.querySelector('[data-media="captureAudio"]').disabled = true`);
    await click('[data-media="captureAudio"]');
    assert.equal(await evaluate(`document.querySelector('[data-media="captureAudio"]').checked`), false);
    await evaluate(`document.querySelector('[data-media="captureAudio"]').disabled = false; document.activeElement.blur()`);
  });
  await step('desktop screenshots and transition/music layout', async () => {
    await evaluate(`document.querySelector('.settings').scrollTop = 0`);
    await capture('settings-overview');
    await evaluate(`document.querySelector('#transitionTools').scrollIntoView({block:'start'})`);
    await capture('settings-transition-music');
    const rows = await evaluate(`[...document.querySelectorAll('.media-transport button')].map(e => {
      const r=e.getBoundingClientRect();return {y:r.y,width:r.width}; })`);
    assert.ok(rows.every(row => row.y === rows[0].y && row.width > 20));
  });
  await step('video/cache panel shares actions, fields and progress style', async () => {
    await click('#videoOptimizationPanel > summary');
    await evaluate(`document.querySelector('#videoOptimizationPanel').scrollIntoView({block:'start'})`);
    await capture('settings-video-cache');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#videoJobProgress')).height`), '5px');
  });
  await step('dynamic author controls reuse the settings palette', async () => {
    await evaluate(await fs.readFile(path.join(workspace, 'bridge-runtime/public/author-properties-panel.js'), 'utf8'));
    await evaluate(`(async () => {
      const sample = { id:'ui-fixture', revision:1, values:{enabled:true,speed:3,text:'示例属性',picture:''},
        schema:{enabled:{type:'bool',label:'启用粒子'},speed:{type:'slider',label:'运动速度',min:0,max:10,integer:true},
          text:{type:'textinput',label:'显示文字'},picture:{type:'file',label:'自定义图片',extensions:['.png']}},
        live:{phase:'unavailable',method:'none',values:{}} };
      const panel=cwbAuthorProperties.createAuthorPropertiesPanel({root:document.querySelector('#authorPropertiesPanel'),
        fetchState:async()=>sample,saveState:async()=>sample});
      await panel.select({id:'ui-fixture',type:'scene'});
      document.querySelector('#authorPropertiesPanel').scrollIntoView({block:'start'});
    })()`);
    await capture('settings-author-properties');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.author-property-row input[type="number"]')).borderRadius`), '8px');
  });
  await step('no sidebar overflow at desktop, compact and mobile widths', async () => {
    for (const width of [1360, 1000, 800, 390, 320]) {
      win.setContentSize(width, 1220);
      await settle();
      const bounds = await evaluate(`(() => {
        const panel=document.querySelector('.settings'), r=panel.getBoundingClientRect();
        return {width:innerWidth,left:r.left,right:r.right,scroll:panel.scrollWidth,client:panel.clientWidth,
          overflow:[...panel.querySelectorAll('input,select,button,summary,progress')].filter(e=>e.getClientRects().length)
            .filter(e=>{const b=e.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1;}).map(e=>e.id||e.className)}; })()`);
      assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
      assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
      assert.deepEqual(bounds.overflow, [], JSON.stringify(bounds));
    }
    win.setContentSize(800, 1220);
    await settle();
    await evaluate(`document.querySelector('#transitionTools').scrollIntoView({block:'start'})`);
    await capture('settings-compact');
  });
  await step('light/dark switch is immediate, accessible and never changes wallpaper effects', async () => {
    win.setContentSize(1360, 1000);
    await settle();
    const snapshot = () => evaluate(`({ effects:[...document.querySelectorAll('[data-effect]')].map(e=>[e.dataset.effect,e.value,e.checked]),
      media:[...document.querySelectorAll('.wallpaper__media')].map(e=>e.getAttribute('src')),
      variables:['--brightness','--dim','--saturation','--blur'].map(key=>getComputedStyle(document.documentElement).getPropertyValue(key)) })`);
    const before = await snapshot();
    await click('[data-theme-choice="light"]');
    assert.equal(await evaluate(`document.documentElement.dataset.workbenchTheme`), 'light');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).colorScheme`), 'light');
    assert.equal(await evaluate(`document.querySelector('[data-theme-choice="light"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await evaluate(`localStorage.getItem('cwb.workbench.theme')`), 'light');
    assert.deepEqual(await snapshot(), before);
    // Show controls in the fixture only; no engine or production API is started.
    await evaluate(`document.querySelector('#engineFallbackControl').hidden=false;document.querySelector('#engineRetryButton').hidden=false;
      document.querySelector('#statusTitle').textContent='界面预览';document.querySelector('#statusDetail').textContent='未启动桥接服务';
      document.querySelector('#emptyState').hidden=false;document.querySelector('#wallpaperList').hidden=true;
      document.querySelector('.settings').scrollTop=0;document.activeElement.blur()`);
    // Theme-aware controls retain 150-160 ms hover/color transitions; capture their settled state.
    await new Promise(resolve=>setTimeout(resolve,220));
    await settle();
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#engineFallbackSelect')).appearance`),'none');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.switch')).backgroundColor`),'rgb(24, 26, 31)');
    await fs.writeFile(path.join(root,'workbench-light.png'),(await win.webContents.capturePage()).toPNG());
    await capture('settings-light');
    await evaluate(`document.querySelector('#transitionTools').scrollIntoView({block:'start'})`);
    await capture('settings-light-transition-music');
    for (const width of [1360,1000,800,390,320]) {
      win.setContentSize(width,1000); await settle();
      const outside = await evaluate(`[...document.querySelectorAll('.topbar button,.topbar select,.topbar label')]
        .filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1;}).map(e=>e.id)`);
      assert.deepEqual(outside,[],`topbar at ${width}px: ${outside.join(', ')}`);
    }
    win.setContentSize(1360,1000); await settle();
    const loaded = new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    win.webContents.reloadIgnoringCache(); await loaded; await settle();
    assert.equal(await evaluate(`document.documentElement.dataset.workbenchTheme`),'light','reload must restore the preference before app initialization');
    await click('[data-theme-choice="dark"]');
    assert.equal(await evaluate(`document.documentElement.dataset.workbenchTheme`),'dark');
    await new Promise(resolve=>setTimeout(resolve,220)); await settle();
    await fs.writeFile(path.join(root,'workbench-dark.png'),(await win.webContents.capturePage()).toPNG());
  });
  await step('real desktop adapter remembers theme after a new window and new bridge origin', async () => {
    win.destroy();
    const assets = new Map();
    const desktopFixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
      script => /src="(?:workbench-theme|electron-host)\.js"/.test(script) ? script : '');
    assets.set('', ['text/html; charset=utf-8', desktopFixture]);
    for (const name of ['styles.css','workbench-theme.js','electron-host.js']) assets.set(name,
      [name.endsWith('.css')?'text/css':'text/javascript', await fs.readFile(path.join(workspace,'bridge-runtime/public',name),'utf8')]);
    async function fixtureServer() {
      const server=http.createServer((request,response)=>{
        const asset=assets.get(new URL(request.url,'http://127.0.0.1').pathname.replace(/^\/fixture\//,''));
        response.writeHead(asset?200:404,{'Content-Type':asset?.[0]||'text/plain'});response.end(asset?.[1]||'Not found');
      });
      servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      return `http://127.0.0.1:${server.address().port}/fixture/`;
    }
    const firstUrl=await fixtureServer(),secondUrl=await fixtureServer();
    assert.notEqual(new URL(firstUrl).origin,new URL(secondUrl).origin);
    const shellSource=(await fs.readFile(path.join(workspace,'src/renderer/index.html'),'utf8'))
      .replace('href="styles.css"',`href="${pathToFileURL(path.join(workspace,'src/renderer/styles.css')).href}"`)
      .replace('src="renderer-desktop.mjs"',`src="${pathToFileURL(path.join(workspace,'src/renderer/renderer-desktop.mjs')).href}"`);
    const shellPath=path.join(root,'desktop-preview.html');await fs.writeFile(shellPath,shellSource,{flag:'wx'});
    async function desktop(url) {
      const preload=path.join(root,`preload-${new URL(url).port}.cjs`);
      await fs.writeFile(preload,`const {contextBridge}=require('electron');let privilegedCalls=0;
        contextBridge.exposeInMainWorld('cwbDesktop',{
          getState:async()=>({installations:[{id:'ui-only',label:'隔离界面预览',version:'fixture'}],selectedId:'ui-only',port:9335,adaptive:true}),
          openControlPanel:async()=>({ok:true,url:${JSON.stringify(url)}}),onTrayAction:()=>{},
          applyCodex:()=>{privilegedCalls++;throw Error('No host actions permitted');},restore:()=>{privilegedCalls++;throw Error('No host actions permitted');},
          testPrivilegedCalls:()=>privilegedCalls});`,{flag:'wx'});
      win=new BrowserWindow({width:1360,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,
        preload,partition:'persist:isolated-workbench-theme',backgroundThrottling:false}});
      await win.loadFile(shellPath);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        if(await evaluate(`document.querySelector('#controlPlaceholder').hidden`)) return;
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      throw Error('Isolated desktop/control handshake timed out');
    }
    await desktop(firstUrl);
    let frame=win.webContents.mainFrame.frames[0];
    await frame.executeJavaScript(`document.querySelector('[data-theme-choice="light"]').click()`);
    const deadline=Date.now()+3000;
    while(Date.now()<deadline && await evaluate(`localStorage.getItem('cwb.workbench.theme')`)!=='light') await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(await evaluate(`localStorage.getItem('cwb.workbench.theme')`),'light');
    assert.equal(await evaluate(`window.cwbDesktop.testPrivilegedCalls()`),0);
    // Start style/layout in the hidden child before timing its color transitions.
    await frame.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    // Chromium can leave hidden iframe transitions pending at time zero. Settle only these finite
    // UI transitions for deterministic screenshots, without changing CSS or wallpaper animations.
    await frame.executeJavaScript(`document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())`);
    report.transitionClock='finite-css-transitions-finished-in-hidden-fixture; natural-timing-not-tested';
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await frame.executeJavaScript(`document.documentElement.dataset.workbenchTheme`),'light');
    const switchColor=await frame.executeJavaScript(`getComputedStyle(document.querySelector('.switch')).backgroundColor`);
    if(switchColor!=='rgb(24, 26, 31)') report.themeDiagnostics=await frame.executeJavaScript(`({
      theme:document.documentElement.dataset.workbenchTheme,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent'),
      switchAccent:getComputedStyle(document.querySelector('.switch')).getPropertyValue('--accent'),
      animations:document.getAnimations().map(a=>({state:a.playState,time:a.currentTime,pending:a.pending}))})`);
    assert.equal(switchColor,'rgb(24, 26, 31)');
    await frame.executeJavaScript(`document.querySelector('#engineFallbackControl').hidden=false;document.querySelector('#engineRetryButton').hidden=false;
      document.querySelector('#backgroundPlaceholder').classList.add('is-visible');
      document.querySelector('#statusTitle').textContent='隔离界面预览';document.querySelector('#statusDetail').textContent='未启动生产桥接服务'`);
    assert.equal(await evaluate(`document.documentElement.dataset.workbenchTheme`),'light');
    assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`),'rgb(244, 245, 247)');
    await settle();
    await frame.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await win.webContents.capturePage();
    await new Promise(resolve=>setTimeout(resolve,150));
    await fs.writeFile(path.join(root,'desktop-light.png'),(await win.webContents.capturePage()).toPNG());
    win.webContents.session.flushStorageData();win.destroy();
    await desktop(secondUrl);
    frame=win.webContents.mainFrame.frames[0];
    assert.equal(await frame.executeJavaScript(`document.documentElement.dataset.workbenchTheme`),'light');
    assert.equal(new URL(await evaluate(`document.querySelector('#controlFrame').src`)).searchParams.get('workbenchTheme'),'light');
    assert.equal(await evaluate(`window.cwbDesktop.testPrivilegedCalls()`),0);
    report.desktopThemePersistence='isolated-window-reopen-and-new-loopback-origin';
  });
  assert.deepEqual(report.errors, []);
}

const watchdog = setTimeout(() => { console.error('Settings UI verification timed out'); app.exit(1); }, 90000);
main().then(() => { report.outcome = 'pass'; }, async error => {
  report.outcome = 'fail'; report.error = error.stack;
  if (win && !win.isDestroyed()) { try { await capture('failure'); } catch {} }
}).finally(async () => {
  clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ root, ...report }));
  app.exit(report.outcome === 'pass' ? 0 : 1);
});
