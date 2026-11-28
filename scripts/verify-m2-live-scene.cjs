/* M2 real-host PoC. Explicit independent target only; no daily state or chat text. */
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workspace = path.resolve(__dirname, '..');
const root = path.resolve(process.argv[2] || '');
const projectRoot = path.resolve(process.argv[3] || '');
const probeOnly = process.argv.slice(4).includes('--probe-only');
const frameTransfer = process.argv.slice(4).includes('--frame-transfer');
const encodedTransfer = process.argv.slice(4).includes('--encoded-transfer');
const directGpu = process.argv.slice(4).includes('--direct-gpu');
if ([probeOnly, frameTransfer, encodedTransfer, directGpu].filter(Boolean).length > 1) throw Error('M2 probe modes are mutually exclusive');
const inside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
if (!inside(path.join(workspace, 'out', 'live-acceptance'), root)) throw Error('explicit independent M2 root required');
// Resolve before app.whenReady()/setPath can create any Electron profile state.
const resolvedAllowed = fsSync.realpathSync(path.join(workspace, 'out', 'live-acceptance'));
const resolvedRoot = fsSync.realpathSync(root);
assert.ok(inside(fsSync.realpathSync(workspace), resolvedAllowed));
assert.ok(inside(resolvedAllowed, resolvedRoot));
assert.ok(fsSync.lstatSync(root).isDirectory() && !fsSync.lstatSync(root).isSymbolicLink());
const helperProfile = path.join(root, 'probe-profile');
if (fsSync.existsSync(helperProfile)) {
  assert.ok(fsSync.lstatSync(helperProfile).isDirectory() && !fsSync.lstatSync(helperProfile).isSymbolicLink());
  assert.ok(inside(resolvedRoot, fsSync.realpathSync(helperProfile)));
}
app.setPath('userData', helperProfile);
if (frameTransfer || encodedTransfer) app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
const report = { startedAt: new Date().toISOString(), scope: 'isolated-real-codex-scene-poc',
  probeOnly, frameTransfer, encodedTransfer, directGpu, completeM0Gate: false, productionSwitchIntegrated: false, nativeTrayExitVerified: false,
  nativeVisiblePlayback: false, artifact: directGpu ? 'source-only-direct-gpu-poc' : 'compiled-dist', steps: [] };
let connection, guard, ownedMarker, targetId, context, lastFrame;
let cspBypassAttempted = false;
const captureWidth = directGpu ? 1280 : 800;
const captureHeight = directGpu ? 720 : 450;
const servers = [];
const contexts = [];
const marker = '__cwbM2ScenePoc';
const nonce = randomBytes(16).toString('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateMetadata = (state) => {
  if (!state) return null;
  const out = {};
  for (const key of ['phase', 'fps', 'running', 'idle', 'draws', 'paused', 'layers', 'width', 'height', 'sequence']) out[key] = state[key];
  return out;
};
async function step(name, operation) {
  report.currentStep = name;
  await fs.writeFile(path.join(root, 'scene-progress.json'), JSON.stringify(report, null, 2));
  const started = Date.now();
  try {
    await guard(); await operation();
    report.steps.push({ name, status: 'pass', elapsedMs: Date.now() - started });
  } catch {
    report.steps.push({ name, status: 'fail', elapsedMs: Date.now() - started });
    throw Error('scene step failed');
  } finally {
    await fs.writeFile(path.join(root, 'scene-progress.json'), JSON.stringify(report, null, 2));
  }
}
async function wait(expression, timeout = 25000) {
  const deadline = Date.now() + timeout;
  do {
    if (await connection.evaluate(expression)) return;
    await delay(150);
  } while (Date.now() < deadline);
  throw Error('bounded scene condition timeout');
}
async function inScene(expression) {
  assert.ok(context);
  const result = await connection.call('Runtime.evaluate', {
    contextId: context.id, expression, returnByValue: true, awaitPromise: true,
  }, context.sessionId);
  assert.ok(!result.exceptionDetails);
  return result.result.value;
}
async function capture(name) {
  // Capture only the PoC's exact frame rectangle, never the surrounding Codex UI.
  const clip = await connection.evaluate(`(()=>{const h=window.${marker};if(h?.nonce!==${JSON.stringify(nonce)})return null;
    const r=h.root.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
  assert.ok(clip && clip.x === 0 && clip.y === 0 && clip.width === captureWidth && clip.height === captureHeight);
  const result = await connection.call('Page.captureScreenshot', { format: 'png', clip, fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, 'base64');
  const image = nativeImage.createFromBuffer(bytes);
  assert.ok(!image.isEmpty());
  await fs.writeFile(path.join(root, name + '.png'), bytes, { flag: 'wx' });
  return { bytes, bitmap: image.toBitmap(), size: image.getSize() };
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
  require('./m2-test-policy.cjs').assertM2TestRoot(projectRoot);
  await app.whenReady();
  const allowed = await fs.realpath(path.join(workspace, 'out', 'live-acceptance'));
  assert.ok(inside(await fs.realpath(workspace), allowed));
  assert.ok(inside(allowed, await fs.realpath(root)));
  const target = JSON.parse((await fs.readFile(path.join(root, 'target.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.ok(inside(await fs.realpath(root), await fs.realpath(target.profile)));
  const { verifyCdpEndpointOwner } = await import(pathToFileURL(path.join(workspace, 'src/cdp-owner.mjs')).href);
  const { CdpConnection, isVerifierRendererTarget } = await import(pathToFileURL(path.join(workspace, 'scripts/verify-live-host.mjs')).href);
  class SceneCdp extends CdpConnection {
    call(method, params = {}, sessionId) {
      if (!sessionId) return super.call(method, params);
      assert.equal(this.socket?.readyState, 1);
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(Error('scene CDP timeout')); }, 15000);
        this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); } });
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
  }
  guard = () => verifyCdpEndpointOwner({ installation: { path: target.exe }, port: target.port,
    expectedProcess: { pid: target.pid, creation: target.creation, profile: target.profile } });
  await guard();
  if (directGpu) {
    report.scope = 'isolated-real-codex-direct-gpu-csp-experiment';
    report.sourceHashes = await sourceHashes();
  }
  report.steps.push({ name: 'exact PID/creation/EXE/profile/port and ancestor gate', status: 'pass' });
  const getJson = async (suffix) => {
    const response = await fetch(`http://127.0.0.1:${target.port}${suffix}`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert.ok(response.ok); return response.json();
  };
  const version = await getJson('/json/version');
  report.browser = version.Browser;
  report.protocol = version['Protocol-Version'];
  let targets = [];
  const deadline = Date.now() + 45000;
  do {
    targets = (await getJson('/json/list')).filter(isVerifierRendererTarget);
    if (targets.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.ok(targets.length, 'no app renderer');
  report.initialApplicationTargets = targets.length;
  // Do not save source URLs, titles, text or authorization values from the CDP inventory.
  const metadata = [];
  for (const targetInfo of targets) {
    await guard();
    const candidate = new SceneCdp(targetInfo.webSocketDebuggerUrl, target.port);
    await candidate.connect();
    const state = await candidate.evaluate(`({origin:location.origin,protocol:location.protocol,host:location.host,
      hidden:document.hidden,readyState:document.readyState,width:innerWidth,height:innerHeight})`);
    metadata.push(state);
    if (!connection && state.origin === 'app://-' && state.readyState !== 'loading' && state.width >= captureWidth && state.height >= captureHeight) {
      connection = candidate; targetId = targetInfo.id;
    }
    else candidate.close();
  }
  report.rendererMetadata = metadata;
  assert.ok(connection, 'no sized application renderer');
  report.steps.push({ name: 'actual app scheme origin and renderer inventory (read-only)', status: 'pass' });
  if (encodedTransfer) {
    report.scope = 'isolated-real-codex-encoded-carrier-poc';
    await require('./verify-m2-vp8-transfer.cjs').run({ connection, guard, step, report, workspace, root, projectRoot, nonce });
  } else if (frameTransfer) {
    report.scope = 'isolated-real-codex-pixel-carrier-poc';
    await require('./verify-m2-frame-transfer.cjs').run({ connection, guard, step, report, workspace, root, projectRoot, nonce });
  } else if (!probeOnly) await sceneProbe();
  report.outcome = 'pass';
}
async function sceneProbe() {
  await step('activate only the independent host document before the compositor test', async () => {
    await connection.call('Page.bringToFront');
    await wait('!document.hidden', 10000);
    report.documentVisibleDuringProbe = true;
  });
  if (directGpu) {
    await guard();
    cspBypassAttempted = true;
    await connection.call('Page.setBypassCSP', { enabled: true });
    await reloadOwnedDocument();
    report.temporaryCspBypass = true;
  }
  const { createSceneServer } = await import(pathToFileURL(path.join(workspace,
    directGpu ? 'bridge-runtime/src/scene-server.mjs' : 'dist/bridge-runtime/src/scene-server.mjs')).href);
  const bytes = await fs.readFile(path.join(projectRoot, 'scene.pkg'));
  report.sample = { folder: path.basename(projectRoot), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const scene = createSceneServer({ project: { id: 'live-poc', type: 'scene', rootPath: projectRoot }, parentOrigin: 'app://-',
    frameRate: directGpu ? 60 : 30, nativeQuality: directGpu });
  servers.push(scene); await scene.start();
  connection.socket.on('message', (raw) => {
    let message; try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.method === 'Runtime.executionContextCreated') contexts.push({ ...message.params.context, sessionId: message.sessionId });
    if (contexts.length > 128) contexts.shift();
  });
  await connection.call('Runtime.enable');
  const requests = new Map();
  report.sceneNetwork = [];
  const record = (entry) => { if (report.sceneNetwork.length < 32) report.sceneNetwork.push(entry); };
  connection.socket.on('message', (raw) => {
    let message; try { message = JSON.parse(raw.toString()); } catch { return; }
    const p = message.params;
    if (message.method === 'Network.requestWillBeSent' && servers.some((server) => p.request.url.startsWith(server.origin + '/'))) {
      if (requests.size < 64) requests.set(p.requestId, p.type);
      record({ phase: 'requested', type: p.type });
    } else if (requests.has(p?.requestId) && message.method === 'Network.responseReceived') {
      record({ phase: 'response', type: requests.get(p.requestId), status: p.response.status });
    } else if (requests.has(p?.requestId) && message.method === 'Network.loadingFailed') {
      record({ phase: 'failed', type: requests.get(p.requestId),
        blockedReason: /^[a-z-]+$/.test(p.blockedReason ?? '') ? p.blockedReason : null,
        errorCode: /^net::ERR_[A-Z_]+$/.test(p.errorText ?? '') ? p.errorText : null });
      requests.delete(p.requestId);
    } else if (message.method === 'Network.loadingFinished') requests.delete(p.requestId);
  });
  await connection.call('Network.enable');
  const host = `window.${marker}`;
  await step('exact-origin sandbox iframe on the initial verified Codex renderer', async () => {
    assert.ok((await connection.call('Target.getTargets')).targetInfos.some((info) => info.targetId === targetId));
    assert.equal(await connection.evaluate(`Boolean(${host})`), false);
    await connection.evaluate(`(()=>{
      const root=document.createElement('div');root.style.cssText='position:fixed;left:0;top:0;width:${captureWidth}px;height:${captureHeight}px;z-index:2147483000;background:black;overflow:hidden';
      const image=document.createElement('img');image.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:none';
      const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0';
      const label=document.createElement('div');label.style.cssText='position:absolute;bottom:0;background:#211b09;color:#ffe08a;font:14px sans-serif;padding:6px;display:none';label.textContent='M2 PoC: scene failed; last real frame';
      root.append(image,frame,label);document.body.append(root);
      const h={root,frame,image,label,nonce:${JSON.stringify(nonce)},state:null,dropped:0,observations:[],policyViolations:[]};
      h.listen=e=>{if(e.origin!==h.origin||e.source!==frame.contentWindow||e.data?.source!=='cwb-scene'||e.data.channel!==h.channel){h.dropped++;return;}h.state=e.data;if(h.observations.length<128)h.observations.push(e.data);};
      addEventListener('message',h.listen);
      h.csp=e=>{if(e.blockedURI.startsWith(h.origin)&&h.policyViolations.length<16)h.policyViolations.push(e.effectiveDirective);};
      addEventListener('securitypolicyviolation',h.csp);
      h.control=(op,channel=h.channel)=>frame.contentWindow.postMessage({source:'cwb-scene-control',op,channel},h.origin);
      h.activate=(url,origin,channel)=>{h.origin=origin;h.channel=channel;h.state=null;h.observations=[];frame.src=url;};
      h.fallback=(data)=>{image.src=data;image.style.display='block';frame.style.display='none';label.style.display='block';h.fallbackKind='last-real-frame';};
      window.${marker}=h;h.activate(${JSON.stringify(scene.rendererUrl)},${JSON.stringify(scene.origin)},${JSON.stringify(scene.channel)});
    })()`);
    ownedMarker = true;
  });
  const selectContext = async (server) => {
    let sessionId;
    const deadline = Date.now() + 10000;
    do {
      context = contexts.find((candidate) => candidate.origin === server.origin && candidate.auxData?.isDefault
        && (!sessionId || candidate.sessionId === sessionId));
      if (context) return;
      const info = (await connection.call('Target.getTargets')).targetInfos.find((candidate) => candidate.type === 'iframe' && candidate.url === server.rendererUrl);
      if (info && !sessionId) {
        ({ sessionId } = await connection.call('Target.attachToTarget', { targetId: info.targetId, flatten: true }));
        await connection.call('Runtime.enable', {}, sessionId);
      }
      await delay(100);
    } while (Date.now() < deadline);
    throw Error('dedicated scene context unavailable');
  };
  await step('real scene.pkg WebGL first frame and heartbeat, not preview/demo', async () => {
    if (directGpu) {
      await selectContext(scene);
      report.sceneExceptions = [];
      connection.socket.on('message', (raw) => {
        let message; try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.sessionId !== context?.sessionId || report.sceneExceptions.length >= 16) return;
        const details = message.params?.exceptionDetails;
        const record = (description) => {
          if (typeof description !== 'string' || !/^(?:Uncaught )?(?:Error|TypeError|ReferenceError|RangeError|SyntaxError|EvalError|WebGL)/.test(description)) return;
          report.sceneExceptions.push(description.split('\n')[0].replace(/(?:https?|app|file|ws):[^\s)]+/g, '<url>').replace(/[a-f0-9]{22,}/gi, '<opaque>').slice(0, 240));
        };
        if (message.method === 'Runtime.exceptionThrown' && details.executionContextId === context.id) record(details.exception?.description ?? details.text);
        if (message.method === 'Runtime.consoleAPICalled' && message.params.executionContextId === context.id) {
          for (const arg of message.params.args || []) if (arg.subtype === 'error') record(arg.description);
        }
        if (context.sessionId && message.method === 'Log.entryAdded') record(message.params?.entry?.text);
      });
      if (context.sessionId) await connection.call('Log.enable', {}, context.sessionId);
      report.sceneCapabilities = await inScene(`(()=>{const canvas=document.createElement('canvas');let gl=null,error=null;
        try{gl=canvas.getContext('webgl2')||canvas.getContext('webgl')}catch(e){error=e.name}
        const out={webglAvailable:!!gl,webglError:error,secureContext:isSecureContext,crossOriginIsolated,
          nodeAvailable:typeof require!=='undefined'||typeof process!=='undefined',canvasCount:document.querySelectorAll('canvas').length};
        if(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');out.renderer=String(gl.getParameter(d?d.UNMASKED_RENDERER_WEBGL:gl.RENDERER)).slice(0,256);gl.getExtension('WEBGL_lose_context')?.loseContext()}
        return out})()`);
      await fs.writeFile(path.join(root, 'scene-progress.json'), JSON.stringify(report, null, 2));
      assert.equal(report.sceneCapabilities.webglAvailable, true, 'isolated Codex child WebGL context unavailable');
    }
    await wait(`${host}?.state?.phase==='ready' && ${host}.state.draws>0`, 45000);
    await selectContext(scene);
    report.firstFrame = stateMetadata(await connection.evaluate(`${host}.state`));
    report.sceneState = await inScene(`({type:window.__cwbScene?.source==='cwb-scene'?'scene':null,scene:!!window.__scene,layers:window.__sceneLayers?.length,
      canvas:!!document.querySelector('canvas'),fallback:!!document.querySelector('iframe')})`);
    assert.equal(report.sceneState.type, 'scene'); assert.equal(report.sceneState.scene, true);
    assert.equal(report.sceneState.canvas, true); assert.equal(report.sceneState.fallback, false);
    assert.ok(scene.diagnostics().requests.includes('scene.pkg'));
    assert.ok(!scene.diagnostics().requests.some((name) => /^preview\./.test(name)));
    report.rendererGpu = await inScene(`(()=>{const c=document.querySelector('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');if(!g)return null;
      const d=g.getExtension('WEBGL_debug_renderer_info');return {renderer:g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER),version:g.getParameter(g.VERSION)}})()`);
    if (directGpu) {
      report.directQuality = await inScene(`({width:document.querySelector('canvas').width,height:document.querySelector('canvas').height,
        dpr:devicePixelRatio,configuredFps:Number(new URLSearchParams(location.search).get('sceneFps'))})`);
      assert.equal(report.directQuality.configuredFps, 60);
      assert.ok(report.directQuality.width >= 1280 && report.directQuality.height >= 720);
    }
  });
  await step('three cropped real-host compositor frames change scene pixels', async () => {
    const a = await capture('frame-a'); await delay(1000);
    const b = await capture('frame-b'); await delay(1000);
    const c = await capture('frame-c'); lastFrame = c;
    report.frameSize = c.size; report.dynamic = [difference(a.bitmap, b.bitmap), difference(b.bitmap, c.bitmap)];
    for (const result of report.dynamic) { assert.ok(result.nonblackRatio > .05); assert.ok(result.changedRatio > .001); }
    report.realHostCompositorCaptured = true;
    if (directGpu) report.nativeVisiblePlayback = true;
  });
  if (directGpu) await step('three continuous direct render-completion measurements include cropped native screenshots', async () => {
    report.performanceSamples = [];
    for (let sample = 0; sample < 3; sample++) {
      const parentStart = await connection.evaluate('({hidden:document.hidden,width:innerWidth,height:innerHeight})');
      const start = await inScene('({time:performance.now(),frames:window.__cwbScene.renderCompletions,hidden:document.hidden,paused:window.__cwbScene.paused,running:window.__cwbScene.running,idle:window.__cwbScene.idle})');
      await capture('direct-performance-' + sample);
      await delay(6000);
      const end = await inScene('({time:performance.now(),frames:window.__cwbScene.renderCompletions,fps:window.__cwbScene.fps,hidden:document.hidden,paused:window.__cwbScene.paused,running:window.__cwbScene.running,idle:window.__cwbScene.idle})');
      const parentEnd = await connection.evaluate('({hidden:document.hidden,width:innerWidth,height:innerHeight})');
      const elapsedMs = end.time - start.time, completedFrames = end.frames - start.frames;
      assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 6000 && Number.isSafeInteger(completedFrames) && completedFrames > 0);
      report.performanceSamples.push({ elapsedMs, completedFrames, rendererCompletedFps: completedFrames * 1000 / elapsedMs,
        reportedEngineFps: end.fps, includesNativeScreenshots: true, physicalScreenFps: null, targetFps: 60,
        parentStart, parentEnd, sceneStart: start, sceneEnd: end });
      await fs.writeFile(path.join(root, 'scene-progress.json'), JSON.stringify(report, null, 2));
    }
    report.directPerformancePassed = report.performanceSamples.every((sample) => sample.rendererCompletedFps >= 50
      && !sample.parentStart.hidden && !sample.parentEnd.hidden && !sample.sceneStart.hidden && !sample.sceneEnd.hidden);
    report.performanceGate = { minimumCompletedFps: 50, requestedFps: 60, usesPhysicalScreenFps: false };
  });
  await step('constructor escape cannot access Codex DOM, Node, parent network or control API', async () => {
    report.security = await inScene(`(async()=>{const g=({}).constructor.constructor('return globalThis')();let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}
      const networkBlocked=await fetch('app://-/cwb-forbidden').then(()=>false,()=>true);
      const control=await fetch('/api/config').then(r=>r.status);return {parentBlocked,networkBlocked,require:typeof g.require,node:typeof g.process,control};})()`);
    assert.equal(report.security.parentBlocked, true); assert.equal(report.security.networkBlocked, true);
    assert.equal(report.security.require, 'undefined'); assert.equal(report.security.node, 'undefined'); assert.equal(report.security.control, 404);
    assert.equal(await connection.evaluate(`(()=>{try{return ${host}.frame.contentWindow.document.body!==null}catch{return 'blocked'}})()`), 'blocked');
  });
  await step('wrong-channel release and same-window forged telemetry are rejected', async () => {
    await connection.evaluate(`${host}.control('release','wrong');window.postMessage({source:'cwb-scene',channel:${host}.channel,phase:'released'},'app://-')`);
    await delay(600);
    const state = await connection.evaluate(`${host}.state`);
    assert.equal(state.phase, 'ready'); assert.equal(state.paused, false);
    assert.ok(await connection.evaluate(`${host}.dropped>0`));
    assert.equal(await inScene('Boolean(window.__scene)&&!!document.querySelector("canvas")'), true);
  });
  await step('trusted pause freezes real pixels and resume restarts scene draws', async () => {
    await connection.evaluate(`${host}.control('pause')`);
    await wait(`${host}.state.paused && !${host}.state.running`);
    await delay(600); const a = await capture('paused-a'); await delay(750); const b = await capture('paused-b');
    report.pausedPixels = difference(a.bitmap, b.bitmap); assert.ok(report.pausedPixels.changedRatio < .0001);
    const before = (await connection.evaluate(`${host}.state`)).draws;
    await connection.evaluate(`${host}.control('resume')`);
    await wait(`!${host}.state.paused && ${host}.state.draws>${before}`);
  });
  await step('trusted release removes canvas and scene globals', async () => {
    await connection.evaluate(`${host}.control('release')`); await wait(`${host}.state.phase==='released'`);
    assert.equal(await inScene('document.querySelectorAll("canvas").length'), 0);
    assert.equal(await inScene('Boolean(window.__scene)'), false);
    report.release = stateMetadata(await connection.evaluate(`${host}.state`));
  });
  await step('malformed package fails without ready and explicitly shows last-real-frame fallback', async () => {
    const corruptRoot = path.join(root, 'corrupt-scene'); await fs.mkdir(corruptRoot);
    await fs.writeFile(path.join(corruptRoot, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.pkg' }));
    await fs.writeFile(path.join(corruptRoot, 'scene.pkg'), 'BROKEN package - no magic');
    const corrupt = createSceneServer({ project: { id: 'corrupt', type: 'scene', rootPath: corruptRoot }, parentOrigin: 'app://-' });
    servers.push(corrupt); await corrupt.start();
    await connection.evaluate(`${host}.activate(${JSON.stringify(corrupt.rendererUrl)},${JSON.stringify(corrupt.origin)},${JSON.stringify(corrupt.channel)})`);
    await wait(`${host}.state?.phase==='failed'`, 22000);
    assert.ok(await connection.evaluate(`${host}.observations.every(state=>state.phase!=='ready')`));
    report.corruptFailure = stateMetadata(await connection.evaluate(`${host}.state`));
    await selectContext(corrupt);
    assert.equal(await inScene('Boolean(window.__scene)||!!document.querySelector("canvas")'), false);
    await connection.evaluate(`${host}.fallback(${JSON.stringify('data:image/png;base64,' + lastFrame.bytes.toString('base64'))})`);
    await wait(`${host}.image.naturalWidth>0 && ${host}.fallbackKind==='last-real-frame'`);
    const fallback = await capture('failure-last-frame');
    report.fallback = { kind: 'last-real-frame', explicitFailureLabel: true, pixelComparison: difference(lastFrame.bitmap, fallback.bitmap) };
    assert.ok(report.fallback.pixelComparison.nonblackRatio > .05);
    assert.ok(report.fallback.pixelComparison.changedRatio < .2);
  });
  if (directGpu) await step('direct render-completion feasibility gate is at least 50 FPS in all three unfiltered samples', async () => {
    assert.equal(report.directPerformancePassed, true);
  });
}
async function sourceHashes() {
  const files = ['scripts/verify-m2-live-scene.cjs', 'scripts/verify-m2-live-scene.ps1', 'scripts/verify-live-host.mjs',
    'scripts/m2-test-policy.cjs', 'src/cdp-owner.mjs', 'src/process-creation.mjs', 'bridge-runtime/src/scene-server.mjs',
    'bridge-runtime/src/scene-render-overlay.mjs', 'bridge-runtime/public/cwb-scene-bridge.js'];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash('sha256').update(await fs.readFile(path.join(workspace, file))).digest('hex')])));
}
async function reloadOwnedDocument({ requireVisible = true } = {}) {
  await guard();
  report.reloadStage = 'set-sentinel';
  await connection.evaluate(`window.__cwbDirectReloadSentinel=${JSON.stringify(nonce)};true`);
  report.reloadStage = 'reload-command';
  await connection.call('Page.reload', { ignoreCache: true });
  report.reloadStage = 'wait-new-document';
  const deadline = Date.now() + 25000;
  do {
    try {
      if (await connection.evaluate(`window.__cwbDirectReloadSentinel!==${JSON.stringify(nonce)}&&location.origin==='app://-'&&document.readyState==='complete'&&(${!requireVisible}||!document.hidden)`)) {
        report.ownedDocumentReloads = (report.ownedDocumentReloads || 0) + 1;
        return;
      }
    } catch { /* A bounded navigation can briefly have no execution context. */ }
    await delay(150);
  } while (Date.now() < deadline);
  throw Error('independent document reload timeout');
}
async function cspRestorationProbe() {
  const scene = servers[0];
  if (!scene) return false;
  return connection.evaluate(`new Promise(resolve=>{
    const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-same-origin';
    frame.style.cssText='position:fixed;width:1px;height:1px;left:0;top:0;border:0';
    let finished=false;const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);
      removeEventListener('securitypolicyviolation',listener);frame.remove();resolve(value)};
    const listener=event=>{if(event.blockedURI.startsWith(${JSON.stringify(scene.origin)})&&event.effectiveDirective === 'frame-src')finish(true)};
    addEventListener('securitypolicyviolation',listener);const timer=setTimeout(()=>finish(false),3000);
    document.body.append(frame);frame.src=${JSON.stringify(scene.rendererUrl)};
  })`);
}
const watchdog = setTimeout(() => {
  report.outcome = 'fail'; report.error = 'bounded helper watchdog'; report.forcedExit = true;
  report.finishedAt = new Date().toISOString();
  fsSync.writeFileSync(path.join(root, 'scene-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  app.exit(2);
}, 210000);
main().catch(() => {
  report.outcome = 'fail'; report.error = 'probe failed; raw host/renderer diagnostics omitted';
}).finally(async () => {
  try {
    if (connection && ownedMarker) {
      try { report.lastState = stateMetadata(await connection.evaluate(`window.${marker}?.state`)); } catch {}
      try { report.parentPolicyViolations = await connection.evaluate(`window.${marker}.policyViolations`); } catch {}
      await guard();
      await connection.evaluate(`(()=>{const h=window.${marker};if(h?.nonce!==${JSON.stringify(nonce)})return;
        h.control('release');removeEventListener('message',h.listen);removeEventListener('securitypolicyviolation',h.csp);h.root.remove();delete window.${marker};})()`);
      report.overlayRemoved = await connection.evaluate(`!window.${marker}`);
      assert.equal(report.overlayRemoved, true);
    }
  } catch { report.outcome = 'fail'; report.cleanupError = 'identity-bound DOM cleanup failed'; }
  // This is separate from DOM cleanup so even a failed probe/restore resets CSP.
  try {
    if (connection && cspBypassAttempted) {
      report.cspResetStage = 'identity-check';
      await guard();
      report.cspResetStage = 'disable-call';
      await connection.call('Page.setBypassCSP', { enabled: false });
      report.cspResetAcknowledged = true;
      report.cspResetStage = 'owned-document-reload';
      await reloadOwnedDocument({ requireVisible: false });
      report.cspRestored = true;
      report.cspResetStage = 'fresh-frame-rejection';
      report.cspRestoreBlockedFreshFrame = await cspRestorationProbe();
      assert.equal(report.cspRestoreBlockedFreshFrame, true);
      report.cspResetStage = 'verified';
    }
  } catch { report.outcome = 'fail'; report.cspRestoreError = 'CSP reset or fresh-frame rejection failed'; }
  try {
    report.resources = servers.map((server) => server.diagnostics());
    const origins = servers.map((server) => server.origin);
    for (const server of servers) await server.close();
    report.listenersClosed = (await Promise.all(origins.map((origin) => fetch(origin + '/', { signal: AbortSignal.timeout(3000) }).then(() => false, () => true)))).every(Boolean);
    assert.equal(report.listenersClosed, true);
    if (directGpu && report.sourceHashes) {
      report.sourceHashesAfter = await sourceHashes();
      report.sourceUnchanged = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter);
      assert.equal(report.sourceUnchanged, true);
    }
  } catch { report.outcome = 'fail'; report.cleanupError = 'identity-bound restore or listener cleanup failed'; }
  connection?.close(); clearTimeout(watchdog);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'scene-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  app.exit(report.outcome === 'pass' ? 0 : 1);
});
