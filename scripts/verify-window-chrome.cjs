// Isolated real Electron shell. No installation discovery, capture or Codex IPC.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const repo = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || '');
const compiled = process.argv[3] ? path.resolve(process.argv[3]) : null;
for (const root of [output, ...(compiled ? [compiled] : [])]) {
  const relative = path.relative(path.join(repo, 'out'), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Fixture paths must stay in out');
}
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'cwb-desktop', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let win, server;
const proof = { scope: 'isolated shell + task-owned temporary config only; no real user app or audio', themes: [], overlays: [], blocked: [] };
const handlers = [];

async function waitFor(expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('fixture_shell_timeout');
}

app.whenReady().then(async () => {
  const { desktopWindowChromeOptions, setWindowChromeTheme } = await import(pathToFileURL(compiled
    ? path.join(compiled, 'window-chrome.mjs') : path.join(repo, 'src/window-chrome.mjs')));
  const { installDesktopRendererProtocol } = await import(pathToFileURL(path.join(repo, 'src/desktop-renderer-protocol.mjs')));
  const { DESKTOP_RENDERER_URL } = await import(pathToFileURL(path.join(repo, 'bridge-runtime/src/desktop-origin.mjs')));
  const { createMediaServer } = await import(pathToFileURL(path.join(repo, 'bridge-runtime/src/media-server.mjs')));
  const { ConfigStore } = await import(pathToFileURL(path.join(repo, 'bridge-runtime/src/config-store.mjs')));
  server = createMediaServer({ configStore: new ConfigStore({ filePath: path.join(output, 'fixture-config.json') }),
    publicDir: compiled ? path.join(compiled, 'bridge-runtime/public') : path.join(repo, 'bridge-runtime/public') });
  await server.start();
  await installDesktopRendererProtocol({ protocol, rendererRoot: compiled ? path.join(compiled, 'renderer') : path.join(repo, 'src/renderer') });
  const register = (name, handler) => { handlers.push(name); ipcMain.handle(name, (event, value) => {
    if (event.senderFrame.url !== DESKTOP_RENDERER_URL) throw Error('foreign_renderer');
    return handler(value);
  }); };
  register('cwb:get-state', () => ({ installations: [{ id: 'fixture', label: '独立测试宿主', kind: 'local', version: 'test', isRunning: false }], selectedId: 'fixture', port: 19335, adaptive: true }));
  register('cwb:open-control-panel', () => ({ ok: true, url: server.baseUrl }));
  register('cwb:set-workbench-theme', theme => {
    const result = setWindowChromeTheme(win, theme); proof.overlays.push({ theme, result }); return result;
  });
  for (const name of ['cwb:apply-codex', 'cwb:restore', 'cwb:choose-executable', 'cwb:refresh-installations']) {
    register(name, () => { proof.blocked.push(name); throw Error('fixture_forbids_real_actions'); });
  }
  win = new BrowserWindow({ show: false, width: 1100, height: 800, minWidth: 1040, minHeight: 700,
    backgroundColor: '#0c0d10', ...desktopWindowChromeOptions(), webPreferences: {
      preload: compiled ? path.join(compiled, 'preload.cjs') : path.join(repo, 'src/preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
  win.removeMenu();
  await win.loadURL(DESKTOP_RENDERER_URL);
  await waitFor("document.querySelector('#controlPlaceholder').hidden && document.documentElement.dataset.titlebarThemeSync==='ready'");
  const snapshot = () => win.webContents.executeJavaScript(`(() => {
    const header=document.getElementById('desktopTitlebar'), status=document.getElementById('desktopConnectionStatus');
    const frame=document.getElementById('controlFrame'), rect=header.getBoundingClientRect(), area=navigator.windowControlsOverlay?.getTitlebarAreaRect();
    const brand=header.querySelector('.desktop-titlebar__brand').getBoundingClientRect();
    return { theme:document.documentElement.dataset.workbenchTheme, sync:document.documentElement.dataset.titlebarThemeSync,
      visible:navigator.windowControlsOverlay?.visible, area:area?{x:area.x,y:area.y,width:area.width,height:area.height}:null,
      width:innerWidth,height:innerHeight,header:{y:rect.y,height:rect.height,bg:getComputedStyle(header).backgroundColor,markColor:getComputedStyle(header.querySelector('.desktop-titlebar__mark')).color,drag:getComputedStyle(header).getPropertyValue('-webkit-app-region'),paddingRight:parseFloat(getComputedStyle(header).paddingRight)},
      brandRight:brand.right,connection:status.dataset.state,frame:{top:frame.getBoundingClientRect().top,height:frame.getBoundingClientRect().height,drag:getComputedStyle(frame.parentElement).getPropertyValue('-webkit-app-region')},
      csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      onlyOneFrame:document.querySelectorAll('#controlFrame').length===1,pageOverflow:document.documentElement.scrollHeight>innerHeight };
  })()`);
  for (const theme of ['dark', 'light', 'dark']) {
    const workbench = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith(server.baseUrl));
    assert.ok(workbench);
    // Use the actual workbench theme button: child preference -> trusted parent
    // message -> fixed native theme IPC. Never invoke wallpaper/Codex actions.
    await workbench.executeJavaScript(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
    await waitFor(`document.documentElement.dataset.workbenchTheme===${JSON.stringify(theme)} && document.documentElement.dataset.titlebarThemeSync==='ready'`);
    const s = await snapshot();
    s.workbenchTheme = await workbench.executeJavaScript('document.documentElement.dataset.workbenchTheme');
    s.workbenchBackground = await workbench.executeJavaScript('getComputedStyle(document.body).backgroundColor');
    assert.equal(s.workbenchTheme, theme);
    assert.equal(s.workbenchBackground, theme === 'dark' ? 'rgb(12, 13, 16)' : 'rgb(244, 245, 247)');
    assert.equal(s.visible, true); assert.equal(s.theme, theme); assert.equal(s.header.drag, 'drag');
    assert.equal(s.frame.drag, 'no-drag'); assert.equal(s.connection, 'connected'); assert.equal(s.onlyOneFrame, true);
    assert.equal(s.pageOverflow, false); assert.ok(s.header.height >= 40 && s.header.height <= 48);
    assert.ok(s.area.width < s.width - 100); assert.ok(s.brandRight < s.area.width);
    assert.equal(Math.round(s.frame.top), Math.round(s.header.height));
    assert.equal(Math.round(s.frame.height + s.header.height), s.height);
    assert.equal(s.header.bg, theme === 'dark' ? 'rgb(12, 13, 16)' : 'rgb(244, 245, 247)');
    assert.equal(s.header.markColor, theme === 'dark' ? 'rgb(243, 244, 246)' : 'rgb(24, 26, 31)');
    proof.themes.push(s);
    if (!await fs.stat(path.join(output, theme + '.png')).catch(() => null)) {
      await workbench.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await fs.writeFile(path.join(output, theme + '.png'), (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG());
    }
  }
  proof.nativeCapabilities = { resizable: win.isResizable(), maximizable: win.isMaximizable(), movable: win.isMovable(), remainedHidden: !win.isVisible() };
  assert.ok(Object.values(proof.nativeCapabilities).every(Boolean));
  if (process.platform === 'win32') {
    const buffer = win.getNativeWindowHandle(), handle = buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
    const native = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CwbCaptionProbe {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static int Hit(IntPtr h,int x,int y) { var p=new POINT{X=x,Y=y}; ClientToScreen(h,ref p); return SendMessage(h,132,IntPtr.Zero,new IntPtr((p.Y<<16)|(p.X&65535))).ToInt32(); }
}
'@
$h=[IntPtr]::new([Int64]${handle}); $null=[CwbCaptionProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$client=New-Object CwbCaptionProbe+RECT; $null=[CwbCaptionProbe]::GetClientRect($h,[ref]$client)
$w=${proof.themes[0].width};$scale=$client.Right/[double]$w;$y=[int](20*$scale)
@{scale=$scale;clientWidth=$client.Right;drag=[CwbCaptionProbe]::Hit($h,[int](120*$scale),$y);content=[CwbCaptionProbe]::Hit($h,[int](120*$scale),[int](100*$scale));minimize=[CwbCaptionProbe]::Hit($h,[int](($w-115)*$scale),$y);maximize=[CwbCaptionProbe]::Hit($h,[int](($w-69)*$scale),$y);close=[CwbCaptionProbe]::Hit($h,[int](($w-23)*$scale),$y)} | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', native], { windowsHide: true, timeout: 15000, maxBuffer: 32768 });
    proof.nativeHitTest = JSON.parse(stdout.trim());
    assert.equal(proof.nativeHitTest.drag, 2);
    assert.equal(proof.nativeHitTest.content, 1);
    assert.equal(proof.nativeHitTest.minimize, 8);
    assert.equal(proof.nativeHitTest.maximize, 9);
    assert.equal(proof.nativeHitTest.close, 20);
  }
  assert.equal(proof.blocked.length, 0);
  proof.ok = true;
}).catch(error => { proof.ok = false; proof.error = error.stack; }).finally(async () => {
  for (const name of handlers) ipcMain.removeHandler(name);
  win?.destroy(); await server?.close();
  await fs.writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: proof.ok, themes: proof.themes.length, nativeHitTest: proof.nativeHitTest, error: proof.error }));
  app.exit(proof.ok ? 0 : 1);
});
