/* Isolated Chromium PoC only. Does not discover, launch, inject, or close Codex. */
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workspace = path.resolve(process.argv[2]);
const projectRoot = path.resolve(process.argv[3]);
require('./m2-test-policy.cjs').assertM2TestRoot(projectRoot);
const root = path.resolve(process.argv[4]);
const compiled = process.argv[5] === '--built';
const relative = path.relative(path.join(workspace, 'out', 'm2-20261010-engine'), root);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('explicit M2 evidence subdirectory required');
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
const report = { startedAt: new Date().toISOString(), scope: 'isolated-scene-poc',
  electron: process.versions.electron, chromium: process.versions.chrome, codexHostsVerified: false,
  nativeVisiblePlayback: false, completeM0Gate: false, productionSwitchIntegrated: false, steps: [] };
report.artifact = compiled ? 'compiled-dist' : 'source';
let win, wrapper, scene, corruptScene, wrapperOrigin, rendererContext;
let forbiddenRequests = 0;
const contexts = [];
const sceneServers = [];
function checkpoint(name) {
  report.currentStep = name;
  fsSync.mkdirSync(root, { recursive: true });
  fsSync.writeFileSync(path.join(root, 'startup.json'), JSON.stringify({ step: name,
    pid: process.pid, at: new Date().toISOString(), argvCount: process.argv.length }));
}
const bounded = async (promise, label, timeout = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label + ' timeout')), timeout);
  })]); } finally { clearTimeout(timer); }
};
const evaluate = (expression) => bounded(win.webContents.executeJavaScript(expression), 'parent evaluate');
async function inScene(expression) {
  const result = await bounded(win.webContents.debugger.sendCommand('Runtime.evaluate', {
    contextId: rendererContext.id, expression, returnByValue: true, awaitPromise: true,
  }), 'scene evaluate');
  if (result.exceptionDetails) throw Error('scene evaluate exception');
  return result.result.value;
}
async function wait(expression, timeout = 25000) {
  const end = Date.now() + timeout;
  do {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw Error('condition timeout: ' + expression);
}
async function step(name, fn) {
  report.currentStep = name;
  await fn();
  report.steps.push({ name, status: 'pass' });
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify(report, null, 2));
}
async function capture(name) {
  const image = await bounded(win.webContents.capturePage(), 'capture');
  const png = image.toPNG();
  await fs.writeFile(path.join(root, name + '.png'), png);
  // capturePage may return a lazy GPU-backed NativeImage. Its toBitmap() can
  // disagree with its PNG; compare a CPU decode of the exact evidence bytes.
  const decoded = nativeImage.createFromBuffer(png);
  assert.ok(!decoded.isEmpty(), 'captured PNG must decode');
  report.capturePixelSource = 'decoded-saved-png';
  return decoded.toBitmap();
}
function difference(a, b) {
  assert.equal(a.length, b.length);
  let changed = 0, nonblack = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 9) changed++;
    if (a[i] + a[i + 1] + a[i + 2] > 30) nonblack++;
  }
  return { changedRatio: changed / (a.length / 4), nonblackRatio: nonblack / (a.length / 4) };
}
async function main() {
  checkpoint('app-ready');
  await fs.mkdir(root, { recursive: true });
  await app.whenReady();
  checkpoint('module-import');
  const { createSceneServer } = await import(pathToFileURL(path.join(workspace,
    compiled ? 'dist/bridge-runtime/src/scene-server.mjs' : 'bridge-runtime/src/scene-server.mjs')).href);
  const pkg = await fs.readFile(path.join(projectRoot, 'scene.pkg'));
  const { createHash } = require('node:crypto');
  report.sample = { folder: path.basename(projectRoot), bytes: pkg.length, sha256: createHash('sha256').update(pkg).digest('hex') };
  checkpoint('wrapper-listen');
  report.gpu = app.getGPUFeatureStatus();
  wrapper = createServer((req, res) => {
    if (req.url !== '/') { forbiddenRequests++; res.writeHead(403); res.end('forbidden'); return; }
    res.setHeader('Content-Type', 'text/html');
    const url = JSON.stringify(scene.rendererUrl), origin = JSON.stringify(scene.origin), channel = JSON.stringify(scene.channel);
    res.end(`<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe id="scene" sandbox="allow-scripts allow-same-origin"></iframe><script>
      const frame=document.querySelector('#scene');window.observations=[];window.dropped=0;
      addEventListener('message', e=>{if(e.origin!==${origin}||e.source!==frame.contentWindow||e.data?.channel!==${channel}||e.data?.source!=='cwb-scene'){window.dropped++;return;}window.state=e.data;if(window.observations.length<128)window.observations.push(e.data);});
      window.sceneControl=(op,channel=${channel})=>frame.contentWindow.postMessage({source:'cwb-scene-control',channel,op},${origin});frame.src=${url};
    </script></body></html>`);
  });
  await new Promise((resolve) => wrapper.listen(0, '127.0.0.1', resolve));
  wrapperOrigin = `http://127.0.0.1:${wrapper.address().port}`;
  scene = createSceneServer({ project: { id: 'poc', type: 'scene', rootPath: projectRoot }, parentOrigin: wrapperOrigin });
  sceneServers.push(scene);
  await scene.start();
  checkpoint('browser-window');
  win = new BrowserWindow({ width: 960, height: 540, useContentSize: true, show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  checkpoint('browser-load');
  await bounded(win.loadURL(wrapperOrigin + '/'), 'wrapper load', 30000);
  checkpoint('debugger-enable');
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_, method, params) => {
    if (method === 'Runtime.executionContextCreated') contexts.push(params.context);
  });
  await bounded(win.webContents.debugger.sendCommand('Runtime.enable'), 'runtime enable');
  await step('cross-origin scene.pkg first frame and heartbeat, not preview/demo/fallback', async () => {
    await wait(`window.state?.phase==='ready' && window.state.draws>0`, 45000);
    rendererContext = contexts.find((context) => context.origin === scene.origin && context.auxData?.isDefault);
    assert.ok(rendererContext, 'renderer execution context');
    const state = await inScene(`({type:window.__cwbScene?.source==='cwb-scene'?'scene':null,scene:!!window.__scene,layers:window.__sceneLayers?.length,canvas:!!document.querySelector('canvas'),fallback:!!document.querySelector('iframe')})`);
    assert.equal(state.type, 'scene'); assert.equal(state.scene, true); assert.equal(state.canvas, true);
    assert.equal(state.fallback, false); assert.ok(state.layers > 0);
    report.firstFrame = await evaluate('window.state'); report.sceneState = state;
    report.gpuAfterRender = app.getGPUFeatureStatus();
    report.rendererGpu = await inScene(`(()=>{const c=document.querySelector('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');if(!g)return null;const d=g.getExtension('WEBGL_debug_renderer_info');return {renderer:g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER),version:g.getParameter(g.VERSION)}})()`);
    assert.ok(scene.diagnostics().requests.includes('scene.pkg'));
    assert.ok(!scene.diagnostics().requests.some((name) => /^preview\./.test(name)));
  });
  await step('three captured nonblack frames have changing scene pixels', async () => {
    const a = await capture('frame-a'); await new Promise((r) => setTimeout(r, 900));
    const b = await capture('frame-b'); await new Promise((r) => setTimeout(r, 900));
    const c = await capture('frame-c');
    report.dynamic = [difference(a, b), difference(b, c)];
    for (const result of report.dynamic) { assert.ok(result.nonblackRatio > .05); assert.ok(result.changedRatio > .001, JSON.stringify(result)); }
  });
  await step('constructor escape cannot access parent DOM, Node, control API or parent network', async () => {
    const security = await inScene(`(async()=>{const g=({}).constructor.constructor('return globalThis')();let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}
      const network=await fetch(${JSON.stringify(wrapperOrigin + '/forbidden')}).then(()=>false,()=>true);
      const control=await fetch('/api/config').then(r=>r.status);return {parentBlocked,networkBlocked:network,require:typeof g.require,node:typeof g.process,control};})()`);
    assert.equal(security.parentBlocked, true); assert.equal(security.networkBlocked, true);
    assert.equal(security.require, 'undefined'); assert.equal(security.node, 'undefined'); assert.equal(security.control, 404);
    assert.equal(forbiddenRequests, 0); report.security = security;
    const direct = await evaluate(`(()=>{try{return document.querySelector('iframe').contentWindow.document.body!==null}catch{return 'blocked'}})()`);
    assert.equal(direct, 'blocked');
  });
  await step('wrong-channel/control and forged same-window telemetry are ignored', async () => {
    await evaluate(`sceneControl('release','wrong-channel');window.postMessage({source:'cwb-scene',channel:${JSON.stringify(scene.channel)},phase:'released'},location.origin)`);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await evaluate('window.state')).phase, 'ready');
    assert.ok(await evaluate('window.dropped>0'));
    assert.equal((await evaluate('window.state')).paused, false);
    assert.equal(await inScene('Boolean(window.__scene)&&!!document.querySelector("canvas")'), true);
  });
  await step('trusted pause freezes pixels; resume restarts scene', async () => {
    await evaluate(`sceneControl('pause')`); await wait('window.state.paused && !window.state.running');
    await new Promise((r) => setTimeout(r, 600)); const a = await capture('paused-a');
    await new Promise((r) => setTimeout(r, 700)); const b = await capture('paused-b');
    report.pausedPixels = difference(a, b); assert.ok(report.pausedPixels.changedRatio < .0001);
    await evaluate(`sceneControl('resume')`); await wait('!window.state.paused && window.state.running && window.state.fps>0');
  });
  await step('trusted release clears canvas and engine globals', async () => {
    await evaluate(`sceneControl('release')`); await wait(`window.state.phase==='released'`);
    assert.equal(await inScene(`document.querySelectorAll('canvas').length`), 0);
    assert.equal(await inScene(`Boolean(window.__scene)`), false);
    report.release = await evaluate('window.state');
  });
  await step('malformed scene.pkg is not ready; first-frame failure releases renderer', async () => {
    const corrupt = path.join(root, 'corrupt-scene'); await fs.mkdir(corrupt);
    await fs.writeFile(path.join(corrupt, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.pkg' }));
    await fs.writeFile(path.join(corrupt, 'scene.pkg'), 'BROKEN scene fixture - no magic');
    corruptScene = createSceneServer({ project: { id: 'corrupt', type: 'scene', rootPath: corrupt }, parentOrigin: wrapperOrigin });
    sceneServers.push(corruptScene); await corruptScene.start();
    scene = corruptScene; contexts.length = 0;
    await bounded(win.reload(), 'corrupt reload');
    await wait(`window.state?.phase==='failed'`, 22000);
    assert.ok(await evaluate(`window.observations.every(s=>s.phase!=='ready')`));
    report.corruptFailure = await evaluate('window.state');
  });
}
const watchdog = setTimeout(() => {
  report.outcome = 'fail'; report.error = 'helper watchdog timeout';
  report.forcedExit = true; report.finishedAt = new Date().toISOString();
  fsSync.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  app.exit(2);
}, 120000);
main().then(() => { report.outcome = 'pass'; }, async (error) => {
  report.outcome = 'fail'; report.error = error.stack;
  try { report.lastState = await evaluate('window.state'); await capture('failure'); } catch {}
  try { report.observations = await evaluate('window.observations'); } catch {}
}).finally(async () => {
  clearTimeout(watchdog);
  report.resources = sceneServers.map((server) => server.diagnostics());
  if (win && !win.isDestroyed()) win.destroy();
  try {
    const ports = sceneServers.map((server) => server.origin);
    for (const server of sceneServers) await bounded(server.close(), 'scene server close');
    if (wrapper) { wrapper.closeAllConnections(); await bounded(new Promise((resolve) => wrapper.close(resolve)), 'wrapper close'); }
    report.sceneServersClosed = true;
    report.listenersClosed = (await Promise.all([...ports, wrapperOrigin].filter(Boolean).map((url) => fetch(url + '/').then(() => false, () => true)))).every(Boolean);
  } catch (error) { report.outcome = 'fail'; report.cleanupError = error.message; }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ root, outcome: report.outcome, steps: report.steps.length, error: report.error }));
  app.exit(report.outcome === 'pass' ? 0 : 1);
});
