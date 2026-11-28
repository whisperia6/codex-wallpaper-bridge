import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EngineRendererOwner } from '../src/engine-renderer-owner.mjs';
import { EngineFailureMemory } from '../bridge-runtime/src/engine-health.mjs';
import { createMediaSwitcher } from '../bridge-runtime/src/media-switch.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 2500) { const end = performance.now() + ms; while (!fn() && performance.now() < end) await delay(10); assert.ok(fn()); }
async function fixture(t, { phase = 'renderable', type = 'web', invalidCapture = false, frozenSequence = false, pauseAcknowledged = true, encoding = false, codecLoadGate } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cwb-engine-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ type, file: 'index.html', general: { properties: { enabled: { type: 'bool', value: true } } } }));
  await writeFile(path.join(root, 'index.html'), '<html><head></head><body>unit fixture only</body></html>');
  const windows = [], sessions = [];
  const ipcMain = new EventEmitter(), png = Buffer.alloc(40); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(800, 16); png.writeUInt32BE(450, 20);
  const image = { isEmpty: () => invalidCapture, getSize: () => ({ width: 800, height: 450 }), toPNG: () => encoding ? png : Buffer.from('unit-image-not-real-png'),
    resize: () => image, toBitmap: () => Buffer.alloc(800 * 450 * 4) };
  class Window extends EventEmitter {
    destroyed = false;
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setAudioMuted = () => {};
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.mainFrame = { url: '' }; this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = (channel, packet) => {
        if (channel !== 'cwb-engine-vp8-frame-v1') return;
        const bytes = Buffer.alloc(24); bytes[0] = 48; bytes.set([157, 1, 42], 3); bytes.writeUInt16LE(800, 6); bytes.writeUInt16LE(450, 8);
        queueMicrotask(() => ipcMain.emit('cwb-engine-vp8-encoded-v1', { sender: this.webContents, senderFrame: this.webContents.mainFrame },
          { ok: true, sequence: packet.sequence, timestamp: packet.timestamp, vp8: bytes, encodeMs: 1 }));
      };
      this.webContents.isOffscreen = () => this.options.webPreferences.offscreen === true;
      this.webContents.setFrameRate = (n) => { this.frameRate = n; };
      this.webContents.startPainting = () => { this.painting = true; };
      this.webContents.stopPainting = () => { this.painting = false; };
      this.inspectorCommands = []; this.inspectorAttached = false;
      const inspector = new EventEmitter();
      Object.assign(inspector, { isAttached: () => this.inspectorAttached, attach: () => { this.inspectorAttached = true; },
        sendCommand: async (name, arg) => {
          this.inspectorCommands.push({ name, arg });
          if (name === 'Animation.getPlaybackRate') return { playbackRate: 1 };
          if (name === 'Debugger.pause' && pauseAcknowledged) queueMicrotask(() => inspector.emit('message', {}, 'Debugger.paused', {}));
          if (name === 'Debugger.resume') queueMicrotask(() => inspector.emit('message', {}, 'Debugger.resumed', {}));
          return {};
        } });
      this.webContents.debugger = inspector;
      this.webContents.capturePage = async () => image;
      this.webContents.executeJavaScript = async (code) => {
        if (code.includes('.state()')) { if (!frozenSequence || !this.state.sequence) this.state.sequence++; return structuredClone(this.state); }
        if (code.includes('.control(')) {
          const [op, extra] = JSON.parse('[' + code.slice(code.indexOf('.control(') + 9, -1) + ']');
          if (op === 'properties') { Object.assign(this.state.properties, extra.values); this.state.propertyRevision++; }
          if (['pause', 'resume'].includes(op)) this.state.pausedRequested = op === 'pause';
        }
      };
    }
    async loadURL(url) {
      this.webContents.mainFrame.url = url;
      const html = await (await fetch(url)).text();
      if (url.endsWith('/codec')) { if (codecLoadGate) await codecLoadGate; return; }
      this.state = { source: `cwb-${type}`, channel: JSON.parse(/channel=("[a-f0-9]+")/.exec(html)[1]), phase,
        sequence: 0, propertyRevision: 0, properties: { enabled: true }, propertiesSupported: true };
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const electron = { ipcMain, BrowserWindow: Window, nativeImage: { createFromBuffer: () => image }, session: { fromPartition: (name) => {
    const session = new EventEmitter(); session.partition = name; sessions.push(session);
    Object.assign(session, { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {},
      clearCache: async () => { session.cacheCleared = true; }, clearStorageData: async () => { session.storageCleared = true; } }); return session;
  } } };
  return { root, windows, sessions, ipcMain, create: (options = {}) => new EngineRendererOwner({ electron,
    project: { id: 'fixture', type, rootPath: root }, firstFrameTimeoutMs: 1000, ...options }) };
}
test('owner accepts a late scene frame within the iframe transfer budget', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { type: 'scene', phase: 'loading' });
  const pkg = path.join(f.root, 'scene.pkg');
  await writeFile(pkg, 'PKGV0001');
  await truncate(pkg, 320 * 1024 ** 2);
  t.mock.method(Date, 'now', () => now);
  const owner = f.create({ firstFrameTimeoutMs: undefined });
  t.after(() => owner.release());
  await until(() => owner.status().sequence > 0);
  const sequence = owner.status().sequence;
  now += 110_000;
  await until(() => owner.status().sequence > sequence || owner.status().closed);
  assert.equal(owner.status().phase, 'loading');
  f.windows[0].state.phase = 'renderable';
  await owner.ready;
  assert.equal(owner.status().actualFrame, true);
});

test('owner needs decoded native frame plus heartbeat; controls applied before readiness; release closes all owned resources', async (t) => {
  const f = await fixture(t), owner = f.create({ properties: { enabled: false } }); t.after(() => owner.release());
  await owner.ready;
  assert.equal(owner.status().actualFrame, true); assert.equal(owner.status().capturedFrames, 1);
  assert.equal((await owner.properties()).values.enabled, false);
  assert.equal((await owner.properties({ enabled: true })).values.enabled, true);
  await owner.pause(); assert.equal(owner.status().suspension.scriptPaused, true);
  assert.equal(owner.status().suspension.animationsPaused, true);
  assert.equal(owner.status().suspension.frameSettled, true);
  assert.equal(f.windows[0].inspectorCommands.find((command) => command.name === 'Animation.setPlaybackRate').arg.playbackRate, 0);
  await owner.resume(); assert.equal(owner.status().suspension.scriptPaused, false);
  assert.equal(f.windows[0].inspectorCommands.at(-2).name, 'Animation.setPlaybackRate');
  assert.equal(f.windows[0].inspectorCommands.at(-2).arg.playbackRate, 1);
  assert.equal(f.windows[0].inspectorCommands.at(-1).name, 'Debugger.resume');
  await owner.release(); await owner.release(); assert.equal(owner.status().resourcesClosed, true);
  assert.ok(f.windows.every((win) => win.isDestroyed()));
  assert.ok(f.sessions.every((session) => session.cacheCleared && session.storageCleared && !session.partition.startsWith('persist:')));
});
test('a legitimate entirely-dark decoded frame is not rejected by the old PoC bright-pixel heuristic', async (t) => {
  const f = await fixture(t), owner = f.create(); t.after(() => owner.release());
  await owner.ready; assert.equal(owner.status().actualFrame, true);
});
test('encoded capture lazily owns a separate sandboxed codec; pause does not share its inspector context', async (t) => {
  const f = await fixture(t, { encoding: true }), owner = f.create(); t.after(() => owner.release());
  await owner.ready; assert.equal(f.windows.length, 1);
  const first = await owner.captureEncoded(); assert.equal(first.vp8.length, 24); assert.equal(f.windows.length, 2);
  assert.ok(f.windows[1].options.webPreferences.preload.endsWith('engine-vp8-preload.cjs'));
  assert.notEqual(f.windows[0].options.webPreferences.session, f.windows[1].options.webPreferences.session);
  await owner.pause(); const second = await owner.captureEncoded(); assert.equal(second.duplicate, true);
  assert.equal(f.windows[1].inspectorCommands.length, 0);
  await owner.release(); assert.ok(f.windows.every((win) => win.isDestroyed())); assert.equal(owner.status().encoder.cachedBytes, 0);
  assert.equal(f.ipcMain.listenerCount('cwb-engine-vp8-encoded-v1'), 0);
});
test('release while codec document loads seals encoding and closes both native contexts', async (t) => {
  let resume; const codecLoadGate = new Promise((resolve) => { resume = resolve; });
  const f = await fixture(t, { encoding: true, codecLoadGate }), owner = f.create(); t.after(() => owner.release());
  await owner.ready; const pending = owner.captureEncoded(); const rejected = assert.rejects(pending, /engine_closed|engine_encoder_closed/);
  await until(() => f.windows.length === 2); const closing = owner.release(); resume(); await rejected; await closing;
  assert.equal(owner.status().resourcesClosed, true); assert.ok(f.windows.every((win) => win.isDestroyed()));
  assert.equal(f.ipcMain.listenerCount('cwb-engine-vp8-encoded-v1'), 0);
});
test('invalid decoded capture fails once, is remembered, and explicit retry is required to create another renderer', async (t) => {
  const f = await fixture(t, { invalidCapture: true }), failures = new EngineFailureMemory(), owner = f.create({ failures });
  await assert.rejects(owner.ready, /transport_failed/); await owner.release();
  const count = f.windows.length, cached = f.create({ failures }); await assert.rejects(cached.ready); await cached.release();
  assert.equal(f.windows.length, count);
  failures.retry(owner.identity); const retry = f.create({ failures }); await assert.rejects(retry.ready); await retry.release();
  assert.equal(f.windows.length, count + 1);
});
test('renderer crash and heartbeat stall terminate owner instead of resurrecting or leaking a window', async (t) => {
  const f = await fixture(t, { frozenSequence: true }), failures = new EngineFailureMemory(), notifications = [];
  const owner = f.create({ failures, heartbeatTimeoutMs: 120, onFailure: (event) => notifications.push(event) });
  await owner.ready; await until(() => owner.status().closed); await until(() => owner.status().resourcesClosed);
  assert.equal(failures.get(owner.identity).reason, 'heartbeat_timeout'); assert.equal(owner.status().retainedActualFrame, true);
  // A trusted native crash is a separate path from author release telemetry.
  failures.retry(owner.identity); const crashed = f.create({ failures }); await crashed.ready;
  f.windows.at(-1).webContents.emit('render-process-gone'); await until(() => crashed.status().resourcesClosed);
  assert.equal(failures.get(crashed.identity).reason, 'context_lost'); assert.equal(notifications.length, 1);
  await owner.release(); await crashed.release();
});
test('loading without a rendered frame hits first-frame deadline; M1 failed candidate retains active owner', async (t) => {
  const good = await fixture(t), bad = await fixture(t, { phase: 'loading' });
  const active = good.create(), candidate = bad.create({ firstFrameTimeoutMs: 120 });
  const closing = [], commits = [];
  const switcher = createMediaSwitcher({ create: (value) => value, commit: (owner) => commits.push(owner),
    dispose: (owner) => closing.push(owner.release()), timeoutMs: 1500 });
  assert.equal((await switcher.switchTo(active, 'a')).ok, true);
  assert.equal((await switcher.switchTo(candidate, 'bad')).ok, false);
  assert.equal(switcher.status().identity, 'a'); assert.equal(commits.length, 1); assert.equal(active.status().closed, false);
  switcher.close(); await Promise.all(closing); assert.equal(active.status().resourcesClosed, true);
});
test('cancelling during asynchronous startup seals the owner and does not allow a late window', async (t) => {
  const f = await fixture(t), owner = f.create(); await owner.release();
  await assert.rejects(owner.ready, /engine_cancelled/);
  assert.equal(owner.status().resourcesClosed, true); assert.equal(f.windows.length, 0);
});
test('native Web pause needs a Debugger.paused acknowledgement, not merely a successful command', async (t) => {
  const f = await fixture(t, { pauseAcknowledged: false }), owner = f.create({ suspensionTimeoutMs: 100 });
  t.after(() => owner.release());
  await owner.ready;
  await assert.rejects(owner.pause(), /engine_operation_timeout/); await owner.release();
  assert.equal(owner.status().reason, 'transport_failed'); assert.equal(owner.status().resourcesClosed, true);
  assert.equal(owner.status().suspension.scriptPaused, false);
});
test('unexpected native debugger resume invalidates the paused owner instead of pretending the source is frozen', async (t) => {
  const f = await fixture(t), owner = f.create(); t.after(() => owner.release()); await owner.ready; await owner.pause();
  f.windows[0].webContents.debugger.emit('message', {}, 'Debugger.resumed', {});
  await until(() => owner.status().resourcesClosed);
  assert.equal(owner.status().reason, 'context_lost'); await owner.release();
});
test('release during native pause cannot resurrect the renderer or retain debugger listeners', async (t) => {
  const f = await fixture(t, { pauseAcknowledged: false }), owner = f.create({ suspensionTimeoutMs: 120 });
  t.after(() => owner.release());
  await owner.ready; const pending = owner.pause(); pending.catch(() => {});
  await until(() => f.windows[0].inspectorCommands.some((command) => command.name === 'Debugger.pause'));
  await owner.release(); await assert.rejects(pending);
  assert.equal(f.windows[0].webContents.debugger.listenerCount('message'), 0);
  assert.equal(owner.status().resourcesClosed, true); assert.equal(f.windows.length, 1);
});
test('native source destruction cleanup never re-reads a destroyed BrowserWindow.webContents getter', async (t) => {
  const f = await fixture(t), owner = f.create(); await owner.ready; await owner.pause(); await owner.resume();
  const source = f.windows[0], contents = source.webContents;
  Object.defineProperty(source, 'webContents', { get() { if (source.destroyed) throw Error('Object has been destroyed'); return contents; } });
  source.destroy();
  await until(() => owner.status().resourcesClosed);
  assert.equal(owner.status().reason, 'context_lost');
  assert.equal(contents.debugger.listenerCount('message'), 0); await owner.release();
});
test('M1 slot identity is distinct from immutable native failure identity; cached retry cannot start a new source', async (t) => {
  const f = await fixture(t), failures = new EngineFailureMemory(), owner = f.create({ failures });
  const closes = [], switcher = createMediaSwitcher({ create: () => owner, commit: () => {}, dispose: (slot) => closes.push(slot.release()) });
  t.after(async () => { switcher.close(); await Promise.all(closes); await owner.release(); });
  const nativeIdentity = owner.engineIdentity;
  assert.equal(typeof nativeIdentity, 'string');
  assert.equal((await switcher.switchTo({}, 'ui-slot-fixture')).ok, true);
  assert.equal(owner.identity, 'ui-slot-fixture'); assert.equal(owner.engineIdentity, nativeIdentity);
  f.windows[0].destroy(); await until(() => owner.status().resourcesClosed);
  assert.equal(failures.get(nativeIdentity).reason, 'context_lost');
  const count = f.windows.length, cached = f.create({ failures }); await assert.rejects(cached.ready, /context_lost/); await cached.release();
  assert.equal(f.windows.length, count);
  failures.retry(nativeIdentity); const retried = f.create({ failures }); await retried.ready; await retried.release();
  assert.equal(f.windows.length, count + 1);
});
