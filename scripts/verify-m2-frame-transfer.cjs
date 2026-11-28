/* Alternate M2-03 carrier, invoked only after the existing independent-host gate. */
const { app, BrowserWindow, nativeImage, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = async (promise, timeout = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('bounded pixel carrier timeout')), timeout);
  })]); } finally { clearTimeout(timer); }
};
function difference(a, b) {
  assert.equal(a.length, b.length);
  let changed = 0, nonblack = 0, channelError = 0;
  for (let i = 0; i < a.length; i += 4) {
    const error = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (error > 9) changed++;
    channelError += error;
    if (a[i] + a[i + 1] + a[i + 2] > 30) nonblack++;
  }
  return { changedRatio: changed / (a.length / 4), nonblackRatio: nonblack / (a.length / 4), meanAbsoluteChannelError: channelError / (a.length / 4 * 3) };
}
function decode(png) {
  const image = nativeImage.createFromBuffer(png);
  assert.ok(!image.isEmpty()); assert.deepEqual(image.getSize(), { width: 800, height: 450 });
  return image.toBitmap();
}
exports.run = async function run({ connection, guard, step, report, workspace, root, projectRoot, nonce }) {
  const { createSceneServer } = await import(pathToFileURL(path.join(workspace, 'dist/bridge-runtime/src/scene-server.mjs')).href);
  const { installFrameReceiver, normalizeSceneCapture, carrierPerformanceGate } = await import(pathToFileURL(path.join(workspace, 'scripts/m2-frame-transfer.mjs')).href);
  const scenes = [], contexts = [];
  let source, wrapper, wrapperOrigin, currentScene, receiverId, rendererContext;
  let sequence = 0, lastSourcePng, sourceEnding = false, sourceFailureNotification;
  let forbiddenRequests = 0;
  const transfer = report.pixelCarrier = { resolution: [800, 450], targetFps: 10, maxFrameBytes: 2097152,
    queueBound: 0, maximumInFlight: 1, transport: 'trusted-CDP-PNG-to-data-image-to-canvas',
    authorCodeInHost: false, cspBypass: false, capturePixelSource: 'decoded-saved-png', productionReady: false };
  const evaluate = (expression) => bounded(source.webContents.executeJavaScript(expression));
  const callReceiver = async (method, args = []) => {
    assert.ok(receiverId);
    const result = await connection.call('Runtime.callFunctionOn', { objectId: receiverId,
      functionDeclaration: `function(...args){return this.${method}(...args)}`,
      arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, 'owned pixel receiver operation'); return result.result?.value;
  };
  const install = async () => {
    const identity = randomBytes(16).toString('hex');
    const result = await connection.call('Runtime.evaluate', {
      expression: `(${installFrameReceiver.toString()})(${JSON.stringify({ nonce: identity, carrier: 'data' })})`,
      returnByValue: false, awaitPromise: false, objectGroup: 'm2-owned-pixel-carrier' });
    assert.ok(!result.exceptionDetails && result.result?.objectId, 'pixel-only receiver installation');
    receiverId = result.result.objectId;
  };
  const releaseReceiver = async () => {
    if (!receiverId) return;
    await guard(); await callReceiver('release');
    const state = await callReceiver('stats');
    assert.equal(state.removed, true); assert.equal(state.liveBlobs, 0);
    await connection.call('Runtime.releaseObject', { objectId: receiverId }); receiverId = null;
  };
  const wait = async (expression, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < deadline);
    throw Error('bounded independent renderer condition failed');
  };
  const inScene = async (expression) => {
    assert.ok(rendererContext);
    const result = await bounded(source.webContents.debugger.sendCommand('Runtime.evaluate', {
      contextId: rendererContext.id, expression, returnByValue: true, awaitPromise: true }));
    assert.ok(!result.exceptionDetails); return result.result.value;
  };
  const captureHost = async (name) => {
    const clip = await callReceiver('rect');
    assert.deepEqual(clip, { x: 0, y: 0, width: 800, height: 450, scale: 1 });
    const result = await connection.call('Page.captureScreenshot', { format: 'png', clip, fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(result.data, 'base64');
    await fs.writeFile(path.join(root, name + '.png'), png, { flag: 'wx' });
    const physical = nativeImage.createFromBuffer(png); assert.ok(!physical.isEmpty());
    const physicalSize = physical.getSize();
    const dpr = await connection.evaluate('devicePixelRatio');
    assert.ok(dpr > 0 && dpr <= 4 && Math.abs(physicalSize.width / dpr - 800) < 2 && Math.abs(physicalSize.height / dpr - 450) < 2);
    transfer.hostCapture = { cssSize: [800, 450], physicalSize, devicePixelRatio: dpr, comparisonSize: [800, 450] };
    const normalized = normalizeSceneCapture(physical);
    await fs.writeFile(path.join(root, name + '-normalized.png'), normalized, { flag: 'wx' });
    return decode(normalized);
  };
  const sendFrame = async (name) => {
    const started = performance.now();
    const captured = await bounded(source.webContents.capturePage({ x: 0, y: 0, width: 800, height: 450 }), 5000);
    transfer.lastFrameOperation = 'normalize-trusted-native-capture';
    const png = normalizeSceneCapture(captured);
    const sampledBitmap = decode(png), sampledPixels = difference(sampledBitmap, sampledBitmap);
    if (sampledPixels.nonblackRatio <= .05) {
      // Fail, record and retain the previous surface; never skip a black frame
      // until a favourable one appears or publish it as a new ready surface.
      await fs.writeFile(path.join(root, 'rejected-black-capture-' + (sequence + 1) + '.png'), png, { flag: 'wx' });
      transfer.rejectedBlackCapture = { sequence: sequence + 1, nonblackRatio: sampledPixels.nonblackRatio };
      await callReceiver('fail', ['scene-failed']);
      throw Error('actual scene capture was black');
    }
    transfer.lastFrameOperation = 'host-image-decode-and-draw';
    const ack = await callReceiver('accept', [{ sequence: ++sequence, png: png.toString('base64') }]);
    assert.equal(ack.ok, true, 'trusted captured PNG accepted'); assert.equal(ack.sequence, sequence);
    const elapsedMs = performance.now() - started;
    if (transfer.firstCaptureToAckMs === undefined) transfer.firstCaptureToAckMs = elapsedMs;
    lastSourcePng = png;
    if (name) {
      const physical = captured.toPNG();
      transfer.sourceCapture = { physicalWidth: physical.readUInt32BE(16), physicalHeight: physical.readUInt32BE(20), comparisonSize: [800, 450] };
      await fs.writeFile(path.join(root, name + '-source-physical.png'), physical, { flag: 'wx' });
      await fs.writeFile(path.join(root, name + '-source.png'), png, { flag: 'wx' });
      const bitmap = await captureHost(name + '-host');
      const comparison = difference(decode(png), bitmap);
      assert.ok(comparison.nonblackRatio > .05, 'actual source is nonblack');
      // Windows compositing resamples the 800-pixel surface to device pixels.
      // Compare decoded, saved PNGs at a common size with a fixed RGB error bound.
      assert.ok(comparison.meanAbsoluteChannelError < 5, 'host pixels match actual trusted capture after DPI compositing');
      return { elapsedMs, bytes: png.length, decodeMs: ack.decodeMs, bitmap, comparison };
    }
    return { elapsedMs, bytes: png.length, decodeMs: ack.decodeMs };
  };
  const processMetrics = async () => {
    const metrics = (await connection.call('Performance.getMetrics')).metrics;
    return { helperAndSourceProcesses: app.getAppMetrics().slice(0, 16).map((metric) => ({
      pid: metric.pid, type: metric.type, cpu: metric.cpu, memory: metric.memory })),
      hostRenderer: Object.fromEntries(metrics.filter((metric) => ['TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize'].includes(metric.name))
        .map((metric) => [metric.name, metric.value])) };
  };
  const attachSource = async () => {
    contexts.length = 0;
    await bounded(source.loadURL(wrapperOrigin + '/' + nonce), 30000);
    if (!source.webContents.debugger.isAttached()) source.webContents.debugger.attach('1.3');
    await bounded(source.webContents.debugger.sendCommand('Runtime.enable'));
  };
  const ready = async () => {
    await wait(`window.state?.phase==='ready' && window.state.draws>0`, 45000);
    rendererContext = contexts.find((context) => context.origin === currentScene.origin && context.auxData?.isDefault);
    assert.ok(rendererContext);
    // Engine draw submission is not a compositor latch. Synchronize capture to
    // two actual parent paint opportunities without requiring scene FPS > 0.
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
    transfer.captureCompositorBarrier = 'two actual parent requestAnimationFrame callbacks, followed by nonblack capture validation';
  };
  const createSource = () => {
    const sourceSession = session.fromPartition('m2-source-' + nonce);
    sourceSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    sourceSession.setPermissionCheckHandler(() => false);
    source = new BrowserWindow({ width: 800, height: 450, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
      webPreferences: { session: sourceSession, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    source.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    source.webContents.on('will-attach-webview', (event) => event.preventDefault());
    source.webContents.on('will-navigate', (event, url) => { if (url !== wrapperOrigin + '/' + nonce) event.preventDefault(); });
    source.webContents.debugger.on('message', (_, method, params) => {
      if (method === 'Runtime.executionContextCreated') { contexts.push(params.context); if (contexts.length > 128) contexts.shift(); }
    });
    const sourceEnded = () => {
      if (!sourceEnding && receiverId && !sourceFailureNotification) sourceFailureNotification = callReceiver('fail', ['source-ended'])
        .catch(() => { transfer.sourceFailureNotificationFailed = true; });
    };
    source.on('closed', sourceEnded); source.webContents.on('render-process-gone', sourceEnded);
  };
  try {
    await step('visible independent host and pixel-only CDP object handle, no loopback iframe', async () => {
      await connection.call('Page.bringToFront');
      const deadline = Date.now() + 10000;
      while (await connection.evaluate('document.hidden')) { assert.ok(Date.now() < deadline); await delay(150); }
      await install(); await connection.call('Performance.enable');
      transfer.receiverInstalled = true; report.documentVisibleDuringProbe = true;
    });
    await step('independent built scene renderer draws actual package without author code in host', async () => {
      const sceneStarted = performance.now();
      const pkg = await fs.readFile(path.join(projectRoot, 'scene.pkg'));
      report.sample = { folder: path.basename(projectRoot), bytes: pkg.length, sha256: createHash('sha256').update(pkg).digest('hex') };
      wrapper = createServer((req, res) => {
        if (req.headers.host !== new URL(wrapperOrigin).host || req.method !== 'GET' || req.url !== '/' + nonce
          || (req.headers.origin && req.headers.origin !== wrapperOrigin)) {
          forbiddenRequests++; res.writeHead(403); res.end('forbidden'); return;
        }
        const origin = JSON.stringify(currentScene.origin), channel = JSON.stringify(currentScene.channel);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src ${currentScene.origin}; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        res.end(`<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><iframe id="scene" sandbox="allow-scripts allow-same-origin"></iframe><script nonce="${nonce}">
          const frame=document.querySelector('#scene');window.states=[];window.dropped=0;
          addEventListener('message',e=>{if(e.origin!==${origin}||e.source!==frame.contentWindow||e.data?.channel!==${channel}||e.data?.source!=='cwb-scene'){window.dropped++;return;}window.state=e.data;if(window.states.length<128)window.states.push(e.data.phase);});
          window.sceneControl=(op)=>frame.contentWindow.postMessage({source:'cwb-scene-control',channel:${channel},op},${origin});frame.src=${JSON.stringify(currentScene.rendererUrl)};
        </script></body></html>`);
      });
      wrapper.maxConnections = 8; wrapper.requestTimeout = 10000; wrapper.headersTimeout = 10000;
      await new Promise((resolve) => wrapper.listen(0, '127.0.0.1', resolve));
      wrapperOrigin = `http://127.0.0.1:${wrapper.address().port}`;
      currentScene = createSceneServer({ project: { id: 'pixel-poc', type: 'scene', rootPath: projectRoot }, parentOrigin: wrapperOrigin });
      scenes.push(currentScene); await currentScene.start();
      createSource();
      await attachSource(); await ready();
      transfer.firstSceneReadyMs = performance.now() - sceneStarted;
      const info = await inScene(`({type:window.__cwbScene?.source==='cwb-scene'?'scene':null,layers:window.__sceneLayers?.length,canvas:!!document.querySelector('canvas'),fallback:!!document.querySelector('iframe')})`);
      assert.equal(info.type, 'scene'); assert.ok(info.layers > 0 && info.canvas && !info.fallback);
      transfer.scene = info;
      transfer.rendererGpu = await inScene(`(()=>{const c=document.querySelector('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');if(!g)return null;const d=g.getExtension('WEBGL_debug_renderer_info');return {renderer:g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER),version:g.getParameter(g.VERSION)}})()`);
      assert.ok(currentScene.diagnostics().requests.includes('scene.pkg'));
      assert.ok(!currentScene.diagnostics().requests.some((name) => /^preview\./.test(name)));
    });
    await step('constructor escape stays in independent origin without Node, host DOM or control API', async () => {
      const security = await inScene(`(async()=>{const g=({}).constructor.constructor('return globalThis')();let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}
        const network=await fetch(${JSON.stringify(wrapperOrigin + '/forbidden')}).then(()=>false,()=>true);
        return {parentBlocked,networkBlocked:network,require:typeof g.require,node:typeof g.process,control:await fetch('/api/config').then(r=>r.status)};})()`);
      assert.equal(security.parentBlocked, true); assert.equal(security.networkBlocked, true);
      assert.equal(security.require, 'undefined'); assert.equal(security.node, 'undefined'); assert.equal(security.control, 404);
      assert.equal(forbiddenRequests, 0); transfer.security = security;
    });
    let lastPixels;
    await step('six-second single-flight frame stream and three actual host compositor samples', async () => {
      transfer.beforeMetrics = await processMetrics();
      const samples = [], elapsed = [], decodeTimes = []; let bytes = 0;
      const started = performance.now(); let nextSample = 0;
      while (performance.now() - started < 6000) {
        const tick = performance.now();
        const sample = samples.length < 3 && tick - started >= nextSample;
        const frame = await sendFrame(sample ? 'stream-' + samples.length : null);
        elapsed.push(frame.elapsedMs); decodeTimes.push(frame.decodeMs); bytes += frame.bytes;
        if (sample) { samples.push(frame); nextSample += 2000; }
        await delay(Math.max(0, 100 - (performance.now() - tick)));
      }
      transfer.afterMetrics = await processMetrics();
      const durationMs = performance.now() - started;
      const summary = (values) => { const sorted = [...values].sort((a, b) => a - b); return {
        p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) }; };
      transfer.stream = { durationMs, frames: elapsed.length, deliveredFps: elapsed.length * 1000 / durationMs,
        pngBytes: bytes, bytesPerSecond: bytes * 1000 / durationMs, captureToAckMs: summary(elapsed), decodeMs: summary(decodeTimes),
        timingScope: 'capture + PNG serialization + CDP + image decode + canvas draw acknowledgement; not physical display latency',
        compositorSampleCount: samples.length, provenanceComparisons: samples.map((sample) => sample.comparison) };
      assert.equal(samples.length, 3); transfer.dynamic = [difference(samples[0].bitmap, samples[1].bitmap), difference(samples[1].bitmap, samples[2].bitmap)];
      for (const result of transfer.dynamic) { assert.ok(result.nonblackRatio > .05); assert.ok(result.changedRatio > .001); }
      transfer.performanceGate = carrierPerformanceGate(transfer.stream);
      lastPixels = samples.at(-1).bitmap; report.nativeVisiblePlayback = true;
      report.nativeVisiblePlaybackScope = 'owned PoC 800 x 450 CSS pixel area only, not daily wallpaper or full UI gate';
    });
    await step('invalid, script and stale frames cannot change committed host pixels', async () => {
      const before = await callReceiver('stats');
      for (const packet of [{ sequence: sequence + 1, png: 'https://example.com/scene.html' },
        { sequence: sequence + 1, png: Buffer.from('<script>window.pwned=true</script>').toString('base64') },
        { sequence, png: lastSourcePng.toString('base64') }]) assert.equal((await callReceiver('accept', [packet])).ok, false);
      await connection.evaluate(`window.postMessage({source:'cwb-scene',phase:'failed',channel:'forged'},location.origin)`);
      const after = await callReceiver('stats'); assert.equal(after.sequence, before.sequence); assert.equal(after.phase, 'ready');
      assert.equal(after.accepted, before.accepted); assert.equal(after.rejected - before.rejected, 3);
      transfer.rejectedFrames = 3;
    });
    await step('real renderer pause freezes host pixels and resume restarts animation', async () => {
      await evaluate(`sceneControl('pause')`); await wait('window.state.paused && !window.state.running'); await delay(600);
      const a = await sendFrame('pause-a'); await delay(700); const b = await sendFrame('pause-b');
      transfer.pausedPixels = difference(a.bitmap, b.bitmap); assert.ok(transfer.pausedPixels.changedRatio < .0001);
      await evaluate(`sceneControl('resume')`); await wait('!window.state.paused && window.state.running'); await delay(600);
      const resumed = await sendFrame('resume'); transfer.resumedPixels = difference(b.bitmap, resumed.bitmap);
      assert.ok(transfer.resumedPixels.changedRatio > .001); lastPixels = resumed.bitmap;
    });
    await step('source release clears the actual scene without erasing the last host frame', async () => {
      await evaluate(`sceneControl('release')`); await wait(`window.state.phase==='released'`);
      assert.equal(await inScene(`document.querySelectorAll('canvas').length`), 0);
      assert.equal(await inScene(`Boolean(window.__scene)`), false);
      const pixels = await captureHost('released-source-host'); assert.equal(difference(lastPixels, pixels).changedRatio, 0);
      transfer.sourceRelease = true;
      await attachSource(); await ready();
      const frame = await sendFrame('restarted-source'); lastPixels = frame.bitmap;
    });
    await step('actual source window termination automatically labels and preserves last real pixels', async () => {
      source.destroy(); assert.equal(source.isDestroyed(), true);
      assert.ok(sourceFailureNotification); await sourceFailureNotification;
      const state = await callReceiver('stats');
      assert.equal(state.phase, 'failed'); assert.equal(state.fallbackKind, 'last-real-frame'); assert.equal(state.failureLabelVisible, true);
      const fallback = await captureHost('source-ended-host');
      assert.equal(difference(lastPixels, fallback).changedRatio, 0);
      transfer.sourceTermination = { actualWindowDestroyed: true, automaticallyNotified: true, ...state, pixelsUnchanged: true };
    });
    await step('corrupt candidate reports failure and preserves previously captured real frame', async () => {
      await releaseReceiver(); await install();
      assert.equal((await callReceiver('accept', [{ sequence: ++sequence, png: lastSourcePng.toString('base64') }])).ok, true);
      const corruptRoot = path.join(root, 'corrupt-pixel-scene'); await fs.mkdir(corruptRoot);
      await fs.writeFile(path.join(corruptRoot, 'project.json'), JSON.stringify({ type: 'scene', file: 'scene.pkg' }));
      await fs.writeFile(path.join(corruptRoot, 'scene.pkg'), 'BROKEN scene fixture - no magic');
      currentScene = createSceneServer({ project: { id: 'corrupt-pixel', type: 'scene', rootPath: corruptRoot }, parentOrigin: wrapperOrigin });
      scenes.push(currentScene); await currentScene.start();
      sourceEnding = true;
      createSource();
      await attachSource(); await wait(`window.state?.phase==='failed'`, 22000);
      assert.ok(await evaluate(`window.states.every(phase=>phase!=='ready')`));
      await callReceiver('fail', ['scene-failed']);
      const state = await callReceiver('stats'); assert.equal(state.fallbackKind, 'last-real-frame'); assert.equal(state.failureLabelVisible, true);
      assert.equal((await callReceiver('accept', [{ sequence: ++sequence, png: lastSourcePng.toString('base64') }])).reason, 'closed');
      const pixels = await captureHost('corrupt-scene-host'); assert.equal(difference(lastPixels, pixels).changedRatio, 0);
      transfer.corruptCandidate = { realMalformedPackage: true, neverReady: true, pixelsUnchanged: true, ...state,
        scope: 'new PoC receiver seeded with the last genuine source capture; not M1 switching' };
    });
    await step('release removes only owned host DOM and revokes all temporary image URLs', async () => {
      await releaseReceiver(); transfer.hostSurfaceReleased = true;
    });
    // Do not hide functional evidence behind a performance miss; the overall
    // run still fails against the original thresholds, after lifecycle checks.
    await step('original performance gate: at least 4 FPS and p95 capture-to-ack below 750 ms', async () => {
      assert.equal(transfer.performanceGate.passed, true);
    });
  } finally {
    sourceEnding = true;
    try { await releaseReceiver(); transfer.overlayRemoved = true; } catch { transfer.overlayRemoved = false; }
    if (source && !source.isDestroyed()) source.destroy();
    transfer.sourceWindowDestroyed = !source || source.isDestroyed();
    transfer.resources = scenes.map((scene) => scene.diagnostics());
    const origins = scenes.map((scene) => scene.origin); if (wrapperOrigin) origins.push(wrapperOrigin);
    for (const scene of scenes) await scene.close();
    if (wrapper) { wrapper.closeAllConnections(); await new Promise((resolve) => wrapper.close(resolve)); }
    transfer.listenersClosed = (await Promise.all(origins.map((origin) => fetch(origin + '/', { signal: AbortSignal.timeout(3000) }).then(() => false, () => true)))).every(Boolean);
    assert.equal(transfer.overlayRemoved, true); assert.equal(transfer.sourceWindowDestroyed, true); assert.equal(transfer.listenersClosed, true);
  }
};
