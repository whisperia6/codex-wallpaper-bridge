import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createReadonlyWallpaperServer } from '../bridge-runtime/src/scene-server.mjs';
import { createEngineHealthGate, EngineFailureMemory, SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS, SCENE_SERVER_START_TIMEOUT_MS } from '../bridge-runtime/src/engine-health.mjs';
import { readAuthorProperties, validateAuthorPropertyPatch } from '../bridge-runtime/src/author-properties.mjs';
import { protectEngineRenderer } from './engine-boundary.mjs';
import { createEngineFrameClock } from './engine-frame-clock.mjs';
import { bindEngineVp8Encoder } from './engine-vp8-encoder.mjs';
export { createEngineFrameClock } from './engine-frame-clock.mjs';
export const engineProjectIdentity = (project) => createHash('sha256').update(project.type + '\0' + project.id + '\0' + project.rootPath).digest('hex');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('engine_operation_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
const literal = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Native renderer resource owner, not another selection/switch state machine.
 * Consumers prepare/commit/cancel using the existing M1 createMediaSwitcher.
 * This module does not attach to a Codex target or expose itself to author JavaScript.
 */
export class EngineRendererOwner {
  #electron;
  #engineIdentity;
  #project;
  #config;
  #properties;
  #scene;
  #wrapper;
  #window;
  #session;
  #boundary;
  #health;
  #source = {};
  #latest;
  #closed = false;
  #closing;
  #started;
  #poll;
  #watch;
  #paused = false;
  #capturing = false;
  #sequence = 0;
  #lastFrame = null;
  #resolve;
  #reject;
  #onFailure;
  #failures;
  #reason = null;
  #pollEpoch = 0;
  #failureNotified = false;
  #propertyQueue = Promise.resolve();
  #controlQueue = Promise.resolve();
  #resourcesClosed = false;
  #suspensionTimeoutMs;
  #scriptPaused = false;
  #animationRate = null;
  #frameSettled = false;
  #resumeExpected = false;
  #debugMessage = null;
  #debugDetach = null;
  #debugger = null;
  #nativeWaiters = new Set();
  #frameClock = null;
  #codecUrl;
  #codecWindow;
  #codecSession;
  #encoder;
  #encodingReady;

  constructor({ electron, project, config = {}, properties = {}, failures = new EngineFailureMemory(),
    firstFrameTimeoutMs = 45000, heartbeatTimeoutMs = 3000, suspensionTimeoutMs = 3000, onFailure = () => {} }) {
    if (!electron?.BrowserWindow || !electron.session || !electron.nativeImage || !['scene', 'web'].includes(project?.type)) throw TypeError('invalid engine owner');
    if (!Number.isFinite(suspensionTimeoutMs) || suspensionTimeoutMs < 50 || suspensionTimeoutMs > 5000) throw TypeError('invalid suspension timeout');
    this.#electron = electron; this.#project = structuredClone(project); this.#config = structuredClone(config);
    this.#properties = structuredClone(properties); this.#onFailure = onFailure;
    this.#failures = failures;
    this.#suspensionTimeoutMs = suspensionTimeoutMs;
    this.#engineIdentity = engineProjectIdentity(project);
    // M1 owns slot.identity and replaces it during prepare. Failure identity is
    // immutable and must not drift when that slot enters the shared switcher.
    this.identity = this.#engineIdentity;
    this.ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; }); this.ready.catch(() => {});
    const cached = failures.get(this.#engineIdentity);
    if (cached) {
      this.#closed = true; this.#reason = cached.reason; this.#resourcesClosed = true; this.#reject(Error(cached.reason)); this.#started = Promise.resolve();
      return;
    }
    this.#started = this.#start({ failures, firstFrameTimeoutMs, heartbeatTimeoutMs }).catch(() => {
      if (!this.#closed) this.#fail('engine_failed');
    });
  }
  async #start({ failures, firstFrameTimeoutMs, heartbeatTimeoutMs }) {
    const nonce = randomBytes(16).toString('hex');
    let wrapperHtml = '';
    let wrapperUrl;
    this.#wrapper = createServer((request, response) => {
      if (!wrapperUrl || !wrapperHtml || request.headers.host !== new URL(wrapperUrl).host || !['GET', 'HEAD'].includes(request.method)
        || !['/' + nonce, '/' + nonce + '/codec'].includes(request.url)) {
        response.writeHead(403); response.end(); return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.url.endsWith('/codec')) {
        response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        response.end(request.method === 'HEAD' ? '' : '<!doctype html><html><head><title>Native pixel encoder</title></head><body></body></html>'); return;
      }
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src ${this.#scene.origin}; base-uri 'none'; form-action 'none'`);
      response.end(request.method === 'HEAD' ? '' : wrapperHtml);
    });
    await new Promise((resolve, reject) => { this.#wrapper.once('error', reject); this.#wrapper.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${this.#wrapper.address().port}`; wrapperUrl = origin + '/' + nonce;
    this.#codecUrl = wrapperUrl + '/codec';
    if (this.#closed) return;
    this.#scene = createReadonlyWallpaperServer({ project: this.#project, config: this.#config, parentOrigin: origin });
    await bounded(this.#scene.start(), SCENE_SERVER_START_TIMEOUT_MS); if (this.#closed) return;
    const messageSource = this.#project.type === 'web' ? 'cwb-web' : 'cwb-scene';
    // The iframe enforces the package-specific deadline and transfer stall checks.
    // Leave time for wrapper startup and trusted capture beyond its hard cap.
    const sceneBudget = this.#project.type === 'scene' ? SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS : null;
    const schema = this.#scene.authorProperties.schema;
    if (!validateAuthorPropertyPatch(schema, this.#properties)) throw Error('invalid_initial_author_properties');
    this.#health = createEngineHealthGate({ identity: this.#engineIdentity, origin: this.#scene.origin, source: this.#source,
      channel: this.#scene.channel, messageSource, failures, firstFrameTimeoutMs: sceneBudget ?? firstFrameTimeoutMs, heartbeatTimeoutMs,
      onRelease: () => {
        const state = this.#health?.status();
        if (state?.phase === 'failed') { this.#reason = state.reason; this.#notifyFailure(state.reason); }
        void this.#close();
      } });
    this.#health.ready.then(() => this.#resolve(this), (error) => this.#reject(error));
    if (this.#closed) return;
    wrapperHtml = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;width:100%;height:100%;background:#000}iframe{width:100%;height:100%;border:0}</style></head><body>
      <iframe id="engine" sandbox="allow-scripts allow-same-origin"></iframe><script nonce="${nonce}">
      const frame=document.getElementById('engine'),origin=${literal(this.#scene.origin)},channel=${literal(this.#scene.channel)},source=${literal(messageSource)};
      let state=null,sequence=0;
      addEventListener('message',event=>{const m=event.data;if(event.source!==frame.contentWindow||event.origin!==origin||m?.source!==source||m.channel!==channel||!Number.isSafeInteger(m.sequence)||m.sequence<=sequence)return;
        sequence=m.sequence;state={source,channel,sequence,phase:m.phase,propertyRevision:m.propertyRevision,properties:m.properties,propertiesSupported:m.propertiesSupported,draws:m.draws,pausedRequested:m.pausedRequested};});
      window.__cwbOwner={state:()=>state,control:(op,extra)=>frame.contentWindow.postMessage({source:source+'-control',channel,op,...extra},origin)};
      frame.src=${literal(this.#scene.rendererUrl)};</script></body></html>`;
    this.#session = this.#electron.session.fromPartition('cwb-engine-' + randomBytes(16).toString('hex'));
    this.#window = new this.#electron.BrowserWindow({ width: 800, height: 450, useContentSize: true, show: false,
      webPreferences: { session: this.#session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    // BrowserWindow.webContents (including its debugger getter) throws after a
    // real native close. Keep the emitter reference while the window is alive.
    this.#debugger = this.#window.webContents.debugger;
    this.#boundary = protectEngineRenderer({ webContents: this.#window.webContents, session: this.#session, wrapperUrl, rendererOrigin: this.#scene.origin });
    this.#frameClock = createEngineFrameClock(this.#window.webContents);
    this.#window.webContents.setAudioMuted(true);
    this.#window.webContents.on('render-process-gone', () => { if (!this.#closed) this.#fail('context_lost'); });
    this.#window.once('closed', () => { if (!this.#closed) this.#fail('context_lost'); });
    await bounded(this.#window.loadURL(wrapperUrl), sceneBudget ?? 15000); if (this.#closed) return;
    this.#watch = setInterval(() => { if (!this.#closed && !this.#paused) this.#health.check(); }, 100);
    let applied = false;
    const pollEpoch = this.#pollEpoch;
    const poll = async () => {
      if (this.#closed || this.#paused || pollEpoch !== this.#pollEpoch) return;
      try {
        const state = await this.#evaluate('window.__cwbOwner.state()');
        if (this.#closed || this.#paused || pollEpoch !== this.#pollEpoch) return;
        if (state) {
          this.#health.receive({ origin: this.#scene.origin, source: this.#source, data: state });
          const readback = readAuthorProperties(schema, state.properties, validateAuthorPropertyPatch);
          this.#latest = { phase: state.phase, propertyRevision: Number.isSafeInteger(state.propertyRevision) ? state.propertyRevision : 0,
            propertiesSupported: state.propertiesSupported === true, ...readback };
          if (['ready', 'renderable'].includes(state.phase) && !applied) {
            applied = true;
            if (Object.keys(this.#properties).length) await this.#send('properties', { values: this.#properties });
            await this.#send('volume', { value: 0 });
            // Do not capture defaults just before the persisted property message is consumed.
            await this.#evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            const confirmed = await this.#evaluate('window.__cwbOwner.state()');
            if (confirmed) this.#latest = { phase: confirmed.phase, propertyRevision: confirmed.propertyRevision,
              propertiesSupported: confirmed.propertiesSupported === true, ...readAuthorProperties(schema, confirmed.properties, validateAuthorPropertyPatch) };
            await this.capture();
          }
        }
      } catch { if (!this.#closed && !this.#paused && pollEpoch === this.#pollEpoch) this.#fail('transport_failed'); }
      if (!this.#closed && !this.#paused && pollEpoch === this.#pollEpoch) this.#poll = setTimeout(poll, 100);
    };
    this.#poll = setTimeout(poll, 0);
  }
  #evaluate(expression) {
    if (this.#closed || !this.#window || this.#window.isDestroyed()) return Promise.reject(Error('engine_closed'));
    return bounded(this.#window.webContents.executeJavaScript(expression));
  }
  #send(op, extra = {}) { return this.#evaluate(`window.__cwbOwner.control(${literal(op)},${literal(extra)})`); }
  #fail(reason) {
    if (this.#closed) return;
    this.#reason = reason; this.#failures.remember(this.#engineIdentity, reason);
    this.#health?.fail(reason); this.#reject(Error(reason));
    this.#notifyFailure(reason);
    void this.#close();
  }
  #notifyFailure(reason) {
    if (this.#failureNotified) return;
    this.#failureNotified = true;
    try { this.#onFailure({ reason, identity: this.#engineIdentity, actualFrameAvailable: Boolean(this.#lastFrame) }); } catch {}
  }
  async capture() {
    if (this.#closed || this.#capturing || !this.#window) throw Error('engine_capture_unavailable');
    this.#capturing = true;
    try {
      const image = await bounded(this.#window.webContents.capturePage());
      // CPU decode the exact PNG, never the measured lazy GPU NativeImage bitmap.
      const native = this.#electron.nativeImage.createFromBuffer(image.toPNG());
      const size = native.getSize();
      if (native.isEmpty() || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw Error('invalid_native_frame');
      const png = native.resize({ width: 800, height: 450, quality: 'good' }).toPNG();
      const decoded = this.#electron.nativeImage.createFromBuffer(png);
      if (png.length > 2 * 1024 ** 2 || decoded.isEmpty() || decoded.toBitmap().length !== 800 * 450 * 4) throw Error('invalid_decoded_frame');
      if (this.#closed) throw Error('engine_closed');
      const frame = { png, width: 800, height: 450, sequence: ++this.#sequence };
      // A darkness percentage cannot distinguish a legitimate dark wallpaper from a missing frame.
      // Readiness requires native decoded pixels plus the heartbeat, not a >5% bright-pixel heuristic.
      this.#health.frame({ ...frame, decoded: true }); this.#lastFrame = frame;
      return { ...frame, png: Buffer.from(png) };
    } finally { this.#capturing = false; }
  }
  #getEncoder() {
    if (this.#encodingReady) return this.#encodingReady;
    this.#encodingReady = (async () => {
      await this.ready; if (this.#closed) throw Error('engine_closed');
      this.#codecSession = this.#electron.session.fromPartition('cwb-engine-codec-' + randomBytes(16).toString('hex'));
      // Unlike the source session, this context cannot load ANY author resource.
      this.#codecSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({ cancel: this.#closed || details.url !== this.#codecUrl || (details.method && !['GET', 'HEAD'].includes(details.method)) });
      });
      this.#codecSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      this.#codecSession.setPermissionCheckHandler(() => false);
      this.#codecSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      this.#codecSession.on('will-download', (_event, item) => item.cancel());
      this.#codecWindow = new this.#electron.BrowserWindow({ width: 1, height: 1, show: false,
        webPreferences: { session: this.#codecSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
          nodeIntegrationInSubFrames: false, backgroundThrottling: false,
          preload: fileURLToPath(new URL('./engine-vp8-preload.cjs', import.meta.url)) } });
      const wc = this.#codecWindow.webContents;
      wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-attach-webview', (event) => event.preventDefault());
      for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) wc.on(name, (event) => {
        if (this.#closed || event.url !== this.#codecUrl) event.preventDefault();
      });
      this.#encoder = bindEngineVp8Encoder({ ipcMain: this.#electron.ipcMain, webContents: wc,
        nativeImage: this.#electron.nativeImage, wrapperUrl: this.#codecUrl });
      const failed = () => { if (!this.#closed) this.#fail('transport_failed'); };
      wc.on('render-process-gone', failed); this.#codecWindow.once('closed', failed);
      await bounded(this.#codecWindow.loadURL(this.#codecUrl)); if (this.#closed) throw Error('engine_closed');
      return this.#encoder;
    })();
    this.#encodingReady.catch(() => { if (!this.#closed) this.#fail('transport_failed'); }); return this.#encodingReady;
  }
  async captureRaw() {
    if (this.#closed || this.#capturing || !this.#window) throw Error('engine_capture_unavailable');
    this.#capturing = true;
    try {
      const image = await bounded(this.#window.webContents.capturePage()), size = image.getSize();
      if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw Error('invalid_native_frame');
      const nativeImage = image.resize({ width: 800, height: 450, quality: 'good' }), bgra = Buffer.from(nativeImage.toBitmap());
      if (bgra.length !== 1440000 || nativeImage.isEmpty() || this.#closed) throw Error('invalid_native_frame');
      const frame = { bgra, width: 800, height: 450, sequence: ++this.#sequence, nativeImage };
      // NativeImage is parent-local diagnostic provenance, never structured-cloned
      // or sent to authors/utility. Encoded RPC strips everything except fixed VP8.
      this.#health.frame({ ...frame, decoded: true }); this.#lastFrame = frame;
      return frame;
    } finally { this.#capturing = false; }
  }
  async captureEncoded() {
    try {
      const encoder = await this.#getEncoder();
      return await encoder.encode(await this.captureRaw());
    } catch (error) {
      if (!this.#closed && this.#encoder?.status().closed) this.#fail('transport_failed');
      throw error;
    }
  }
  properties(values = null) {
    const operation = this.#propertyQueue.catch(() => {}).then(async () => {
      await this.ready;
      if (this.#closed || this.#paused) return { phase: 'unavailable', method: 'none', values: {} };
      if (this.#project.type === 'web' && !this.#latest?.propertiesSupported) return { phase: 'unsupported', method: 'none', values: {} };
      if (values !== null) {
        const valid = validateAuthorPropertyPatch(this.#scene.authorProperties.schema, values);
        if (!valid) throw Error('invalid_author_properties');
        const before = this.#latest?.propertyRevision ?? 0;
        await this.#send('properties', { values: valid });
        const end = Date.now() + 3000;
        while (!this.#closed && !this.#paused && this.#latest?.propertyRevision <= before && Date.now() < end) await delay(25);
        if (this.#closed || this.#paused || this.#latest?.propertyRevision <= before) throw Error('author_readback_timeout');
      }
      return { phase: 'ready', method: this.#project.type === 'web' ? 'author-delivery' : 'engine-readback', values: { ...this.#latest.values } };
    });
    this.#propertyQueue = operation; return operation;
  }
  pointer(value) {
    return this.#queueControl(async () => {
      await this.ready; if (this.#closed || this.#paused) return;
      if (!value || ![value.u, value.v].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
        || ![0, 1].includes(value.buttons) || !Number.isInteger(value.mods) || value.mods < 0 || value.mods > 15) throw Error('invalid_pointer');
      if (this.#project.type === 'scene') await this.#send('pointer', value);
    });
  }
  volume(value) {
    return this.#queueControl(async () => {
      await this.ready; if (this.#closed) return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw Error('invalid_volume');
      if (this.#paused && value > 0) return;
      if (!this.#paused) await this.#send('volume', { value });
      this.#window.webContents.setAudioMuted(value === 0);
    });
  }
  #queueControl(fn) {
    const operation = this.#controlQueue.catch(() => {}).then(fn);
    this.#controlQueue = operation; return operation;
  }
  #inspector() {
    if (this.#closed) throw Error('engine_closed');
    const api = this.#debugger;
    if (!api.isAttached()) api.attach('1.3');
    if (!this.#debugMessage) {
      // This inspector belongs only to the dedicated source window. No global
      // Target discovery, author call frames, stack traces or script bodies are retained.
      this.#debugMessage = (_, method) => {
        if (method === 'Debugger.paused') this.#scriptPaused = true;
        if (method === 'Debugger.resumed') {
          this.#scriptPaused = false;
          if (this.#paused && !this.#resumeExpected && !this.#closed) this.#fail('context_lost');
        }
      };
      this.#debugDetach = () => { if (this.#paused && !this.#closed) this.#fail('context_lost'); };
      api.on('message', this.#debugMessage); api.on('detach', this.#debugDetach);
    }
    return api;
  }
  async #nativeTransition(api, command, expected) {
    let waiter;
    const acknowledged = new Promise((resolve, reject) => {
      waiter = { reject, listener: (_, method) => { if (method === expected) resolve(); } };
      this.#nativeWaiters.add(waiter); api.on('message', waiter.listener);
    });
    try { await bounded(Promise.all([acknowledged, api.sendCommand(command)]), this.#suspensionTimeoutMs); }
    finally { this.#nativeWaiters.delete(waiter); api.removeListener('message', waiter.listener); }
    if (this.#closed) throw Error('engine_closed');
  }
  async #settleSuspendedFrame() {
    // Debugger acknowledgement freezes author JS, but a pre-pause compositor
    // submission can still be pending. Drain through actual native captures;
    // never equate a hidden/cached screenshot with a stopped author renderer.
    const end = Date.now() + this.#suspensionTimeoutMs;
    let previous;
    do {
      while (this.#capturing && !this.#closed && Date.now() < end) await delay(10);
      const frame = await this.capture();
      const hash = createHash('sha256').update(this.#electron.nativeImage.createFromBuffer(frame.png).toBitmap()).digest('hex');
      if (hash === previous) { this.#frameSettled = true; return; }
      previous = hash; await delay(50);
    } while (!this.#closed && Date.now() < end);
    throw Error('engine_operation_timeout');
  }
  pause() {
    return this.#queueControl(async () => {
      await this.ready; if (this.#closed || this.#paused) return;
      await this.#propertyQueue.catch(() => {}); if (this.#closed) return;
      this.#paused = true; this.#pollEpoch++; clearTimeout(this.#poll);
      try {
        await this.#send('pause');
        if (this.#project.type === 'web') {
          const end = Date.now() + this.#suspensionTimeoutMs;
          while (!(await this.#evaluate('window.__cwbOwner.state()'))?.pausedRequested) {
            if (Date.now() >= end) throw Error('engine_operation_timeout'); await delay(25);
          }
          const api = this.#inspector();
          await bounded(api.sendCommand('Animation.enable'));
          const rate = await bounded(api.sendCommand('Animation.getPlaybackRate'));
          if (!Number.isFinite(rate.playbackRate) || rate.playbackRate < 0 || rate.playbackRate > 32) throw Error('invalid_animation_rate');
          this.#animationRate = rate.playbackRate;
          await bounded(api.sendCommand('Animation.setPlaybackRate', { playbackRate: 0 }));
          await bounded(api.sendCommand('Debugger.enable', { maxScriptsCacheSize: 0 }));
          await this.#nativeTransition(api, 'Debugger.pause', 'Debugger.paused');
          await this.#settleSuspendedFrame();
        }
      } catch (error) { if (!this.#closed) this.#fail('transport_failed'); throw error; }
    });
  }
  resume() {
    return this.#queueControl(async () => {
      await this.ready; if (this.#closed || !this.#paused) return;
      try {
        if (this.#project.type === 'web') {
          const api = this.#inspector(); this.#resumeExpected = true;
          await bounded(api.sendCommand('Animation.setPlaybackRate', { playbackRate: this.#animationRate }));
          await this.#nativeTransition(api, 'Debugger.resume', 'Debugger.resumed');
          this.#animationRate = null; this.#frameSettled = false;
        }
        await this.#send('resume');
        // A fresh heartbeat must be observed before re-enabling the health watch.
        const end = Date.now() + 2000, previous = this.#health.status().sequence;
        let confirmed = false;
        do {
          const state = await this.#evaluate('window.__cwbOwner.state()');
          if (state && state.sequence > previous) {
            this.#health.receive({ origin: this.#scene.origin, source: this.#source, data: state }); confirmed = true; break;
          }
          await delay(25);
        } while (Date.now() < end && !this.#closed);
        if (!confirmed || this.#closed) throw Error('engine_operation_timeout');
        // Resume polling through the same owner rather than starting a second renderer.
        this.#paused = false;
        const epoch = ++this.#pollEpoch;
        this.#poll = setTimeout(() => { void this.#resumePoll(epoch); }, 0);
      } catch (error) { if (!this.#closed) this.#fail('transport_failed'); throw error; }
      finally { this.#resumeExpected = false; }
    });
  }
  async #resumePoll(epoch) {
    if (this.#closed || this.#paused || epoch !== this.#pollEpoch) return;
    try {
      const state = await this.#evaluate('window.__cwbOwner.state()');
      if (state && !this.#closed && epoch === this.#pollEpoch) {
        this.#health.receive({ origin: this.#scene.origin, source: this.#source, data: state });
        this.#latest = { ...this.#latest, propertyRevision: state.propertyRevision,
          ...readAuthorProperties(this.#scene.authorProperties.schema, state.properties, validateAuthorPropertyPatch) };
      }
    } catch { if (!this.#closed && !this.#paused && epoch === this.#pollEpoch) this.#fail('transport_failed'); }
    if (!this.#closed && !this.#paused && epoch === this.#pollEpoch) this.#poll = setTimeout(() => { void this.#resumePoll(epoch); }, 100);
  }
  async #close() {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#pollEpoch++; clearTimeout(this.#poll); clearInterval(this.#watch);
    this.#frameClock?.release();
    this.#encoder?.close();
    if (this.#codecWindow && !this.#codecWindow.isDestroyed()) this.#codecWindow.destroy();
    const api = this.#debugger;
    if (api) {
      if (this.#debugMessage) api.removeListener('message', this.#debugMessage);
      if (this.#debugDetach) api.removeListener('detach', this.#debugDetach);
      for (const waiter of this.#nativeWaiters) { api.removeListener('message', waiter.listener); waiter.reject(Error('engine_closed')); }
      this.#nativeWaiters.clear();
    }
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
    this.#boundary?.release();
    this.#closing = (async () => {
      // Startup might still be inside server.start/loadURL. Seal before awaiting it.
      await this.#started;
      await this.#encodingReady?.catch(() => {});
      if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
      if (this.#scene) await this.#scene.close();
      if (this.#wrapper) { this.#wrapper.closeAllConnections(); await new Promise((resolve) => this.#wrapper.close(resolve)); }
      if (this.#session) await Promise.all([this.#session.clearCache(), this.#session.clearStorageData()]);
      if (this.#codecSession) await Promise.all([this.#codecSession.clearCache(), this.#codecSession.clearStorageData()]);
      this.#resourcesClosed = true;
    })();
    return this.#closing;
  }
  release() { this.#health?.release(); this.#reject(Error('engine_cancelled')); this.#lastFrame = null; return this.#close(); }
  get engineIdentity() { return this.#engineIdentity; }
  status() { return { ...(this.#health?.status() ?? { phase: this.#reason ? 'failed' : 'loading', reason: this.#reason }), closed: this.#closed, paused: this.#paused, resourcesClosed: this.#resourcesClosed,
    capturedFrames: this.#sequence, retainedActualFrame: Boolean(this.#lastFrame), boundary: this.#boundary?.status() ?? null,
    frameClock: this.#frameClock?.status() ?? null,
    encoder: this.#encoder?.status() ?? null,
    suspension: { scriptPaused: this.#scriptPaused, animationsPaused: this.#animationRate !== null, frameSettled: this.#frameSettled } }; }
}
