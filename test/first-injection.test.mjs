import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { CdpWallpaperInjector } from '../bridge-overrides/src/cdp-injector.mjs';
import { buildBootstrapScript } from '../bridge-overrides/src/injected-renderer.mjs';
import { DirectSceneDelivery } from '../bridge-runtime/src/direct-scene-delivery.mjs';

const target = (id) => ({ id, type: 'page', url: 'app://-',
  webSocketDebuggerUrl: `ws://127.0.0.1:9335/devtools/page/${id}` });
const gpuPlan = { bootstrapScript: 'bootstrap', applyScript: 'apply', directSceneEnabled: true, directSceneId: 'scene' };

function gpuFixture(t, { verified = true, lateTheme = false, hidden = new Set(), unknown = new Set(), visibleFailure = false, deferredOnce = false, broken = false, brokenError = 'gpu_source_failed', goneTarget = null, removeGone = false, ownerRemovesTarget = false, handshakeStatus = null, navigatesAway = false } = {}) {
  const calls = [], statuses = [], sockets = [];
  let targetGone = false;
  const injector = new CdpWallpaperInjector({ pollIntervalMs: 60000,
    verifyEndpoint: async () => { calls.push('verify'); if (ownerRemovesTarget) targetGone = true; return { verified }; },
    onStatus: (status) => statuses.push(status),
    socketFactory: url => {
      const globals = {}, events = new Map();
      globals.top = globals;
      let themePrepared = false, themeChecks = 0;
      const socket = { ws: new EventEmitter(), closed: false,
        async connect() {
          calls.push('connect');
          if (handshakeStatus && url.endsWith('/' + goneTarget)) {
            targetGone = removeGone;
            throw Object.assign(Error('Unexpected server response: ' + handshakeStatus), { cwbHandshakeStatus: handshakeStatus });
          }
        },
        async call(method, params = {}) {
          calls.push(method);
          if (method === 'Page.enable' && url.endsWith('/' + goneTarget)) { targetGone = removeGone; throw Error('CDP Page.enable timed out'); }
          if (method === 'Page.reload') {
            delete globals.__cwbDocumentReload;
            runInNewContext(params.scriptToEvaluateOnLoad, { globalThis: globals });
            return {};
          }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook' };
          if (method === 'Runtime.callFunctionOn') {
            if (params.objectId === 'boot') return { result: params.returnByValue ? { value: true } : { objectId: 'receiver' } };
            return { result: { value: true } };
          }
          if (method === 'Runtime.evaluate') {
            if (params.expression.startsWith('fallback-')) return { result: { value: {
              ok: params.expression !== 'fallback-bad', runtimeReady: true, domReady: true, theme: { reloadRequired: false } } } };
            if (params.expression === 'document.hidden === true') return { result: { value: unknown.has(url.split('/').at(-1)) ? null : hidden.has(url.split('/').at(-1)) } };
            if (params.expression === 'bootstrap') { calls.push('bootstrap'); return { result: { objectId: 'boot' } }; }
            if (params.expression.endsWith('.prepareTheme()')) {
              calls.push('theme'); themeChecks++;
              const reloadRequired = !themePrepared || (lateTheme && themeChecks === 2); themePrepared = true;
              return { result: { value: { state: reloadRequired ? 'dark-reload-required' : 'dark', reloadRequired } } };
            }
            if (params.expression.startsWith('globalThis.__cwbDocumentReload')) {
              return { result: { value: runInNewContext(params.expression, {
                globalThis: globals, location: { origin: 'app://-' }, document: { readyState: 'interactive', body: {} },
              }) } };
            }
            if (params.expression === 'apply') {
              calls.push('apply');
              if (deferredOnce) { deferredOnce = false; hidden.add(url.split('/').at(-1));
                return { result: { value: { ok: false, deferred: true, runtimeReady: true, domReady: false, switchResult: { cancelled: true } } } }; }
              if (visibleFailure) return { result: { value: { ok: false, runtimeReady: true, domReady: false,
                media: { state: 'error' }, switchResult: { error: 'Media failed to load or decode' } } } };
              return { result: { value: { ok: true, runtimeReady: true, domReady: true,
                media: { state: 'ready' }, theme: { reloadRequired: !themePrepared } } } };
            }
            return { result: { value: { ok: true } } };
          }
          return {};
        },
        onEvent(name, callback) { events.set(name, callback); return () => events.delete(name); },
        close() { this.closed = true; },
      };
      sockets.push(socket); return socket;
    },
  });
  injector.sceneDelivery = {
    warm: async () => { calls.push('warm'); return true; },
    fail: () => { calls.push('fail'); },
    prepare: async (session, key) => {
      calls.push('prepare');
      if (broken) throw Error(brokenError);
      const lease = { key, closed: false, release: async () => { lease.closed = true; session.sceneLeases.delete(lease); }, retire() {} };
      session.sceneLeases.add(lease); return lease;
    },
    close: async () => {},
  };
  injector.listTargets = async ({ includeAll = false } = {}) => [target('main'), ...(goneTarget && !targetGone ? [target(goneTarget)]
    : goneTarget && navigatesAway && includeAll ? [{ ...target(goneTarget), url: 'https://example.invalid/' }] : [])];
  t.after(() => injector.close({ restore: true, allowEndpointUnavailable: !verified }));
  return { injector, calls, statuses, sockets, hidden };
}

test('a verified target that disappears before any CSP mutation is retired, while a still-listed timeout remains a failure', async t => {
  const gone = gpuFixture(t, { goneTarget: 'gone', removeGone: true });
  const result = await gone.injector.start(gpuPlan); assert.equal(result.failed, 0); assert.equal(result.sessions, 1);
  assert.ok(gone.statuses.some(status => status.type === 'attach-gone'));
  const hung = gpuFixture(t, { goneTarget: 'hung' });
  assert.equal((await hung.injector.start(gpuPlan)).failed, 1);
  // End the synthetic target before fixture teardown; the actual still-listed
  // failure above must remain a failure, not be hidden by a cleanup catch.
  hung.injector.listTargets = async () => [target('main')];
});

test('unreadable GPU visibility defers an untouched target instead of enabling Page/CSP or pretending a frame', async t => {
  const f = gpuFixture(t, { unknown: new Set(['main']) });
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.sessions, 0); assert.equal(result.failed, 0); assert.equal(result.deferred, 1);
  assert.equal(f.calls.includes('Page.enable'), false); assert.equal(f.calls.includes('Page.setBypassCSP'), false);
  assert.equal(f.calls.includes('prepare'), false);
});

test('GPU target snapshot is refreshed after slow owner verification and before opening a stale socket', async t => {
  const f = gpuFixture(t, { goneTarget: 'stale', ownerRemovesTarget: true });
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 0); assert.equal(result.sessions, 1);
  assert.equal(f.calls.filter(c => c === 'connect').length, 1, 'disappeared snapshot must never open a socket');
  assert.ok(f.statuses.some(s => s.type === 'attach-gone'));
});

test('verified untouched HTTP500 is retired only when a full fresh target list proves closure', async t => {
  const f = gpuFixture(t, { goneTarget: 'gone', handshakeStatus: 500, removeGone: true });
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 0); assert.equal(result.sessions, 1);
  assert.ok(f.statuses.some(s => s.type === 'attach-gone'));
  for (const options of [{}, { removeGone: true, navigatesAway: true }, { verified: false, removeGone: true }]) {
    const failed = gpuFixture(t, { goneTarget: 'failed', handshakeStatus: 500, ...options });
    assert.ok((await failed.injector.start(gpuPlan)).failed > 0);
    assert.equal(failed.statuses.some(s => s.type === 'attach-gone'), false);
    failed.injector.listTargets = async () => [target('main')];
  }
});

test('GPU initial failure tries bounded fallbacks but never replaces an already committed wallpaper', async t => {
  const f = gpuFixture(t, { broken: true });
  const fallbackScripts = [{ reason: 'embedded_video', script: 'fallback-bad' }, { reason: 'preview', script: 'fallback-good' }];
  const result = await f.injector.start({ ...gpuPlan, fallbackScripts });
  assert.equal(result.failed, 0); assert.equal(result.sessions, 1); assert.equal(result.timings[0].degraded, true);
  assert.equal(result.timings[0].fallbackReason, 'preview');
  assert.ok(f.statuses.some(status => status.message?.includes('已降级 preview')));
  const session = f.injector.sessions.get('main'); session.fallbackFor = null;
  const update = await f.injector.update({ ...gpuPlan, fallbackScripts });
  assert.equal(update.failed, 1); assert.equal(session.lastApplied.directSceneId, 'scene');
});

test('GPU fallback cannot convert receiver loss or a restoration/identity failure into success', async t => {
  for (const brokenError of ['gpu_receiver_lost', 'Renderer restoration is in progress', 'identity_verification_failed']) {
    const f = gpuFixture(t, { broken: true, brokenError });
    const result = await f.injector.start({ ...gpuPlan, fallbackScripts: [{ reason: 'empty', script: 'fallback-good' }] });
    assert.equal(result.failed, 1); assert.equal(result.timings.length, 0);
  }
});

test('GPU first-frame failure uses the existing fallback without restarting application or reloading', async t => {
  const f = gpuFixture(t, { visibleFailure: true });
  const result = await f.injector.start({ ...gpuPlan, fallbackScripts: [{ reason: 'preview', script: 'fallback-good' }] });
  assert.equal(result.failed, 0);
  assert.equal(result.timings[0].fallbackReason, 'preview');
  assert.equal(f.calls.filter(call => call === 'apply').length, 1);
  assert.equal(f.calls.filter(call => call === 'Page.reload').length, 1);
  assert.equal(f.calls.filter(call => call === 'fail').length, 1);
});

test('GPU becoming hidden during first-frame wait is deferred, frees its candidate and reopens only after visibility', async t => {
  const f = gpuFixture(t, { deferredOnce: true });
  const start = await f.injector.start(gpuPlan);
  assert.equal(start.failed, 0); assert.equal(start.sessions, 0); assert.equal(start.deferred, 1);
  assert.equal(f.injector.sessions.get('main').sceneLeases.size, 0);
  await f.injector.scanOnce(); assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  f.hidden.clear(); await f.injector.scanOnce();
  assert.equal(f.injector.lastScanFailures, 0); assert.equal(f.injector.lastScanDeferred, 0);
  assert.equal(f.injector.sessions.get('main').sceneLease.key, 'scene');
  assert.equal(f.calls.filter(call => call === 'Page.reload').length, 1);
});

test('first GPU injection prepares theme before one document reload and loads the scene only once', async (t) => {
  const f = gpuFixture(t);
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 0); assert.equal(result.sessions, 1);
  assert.equal(f.calls.filter((call) => call === 'verify').length, 1);
  assert.equal(f.calls.filter((call) => call === 'Page.reload').length, 1);
  assert.equal(f.calls.filter((call) => call === 'prepare').length, 1);
  assert.equal(f.calls.filter((call) => call === 'apply').length, 1);
  assert.ok(f.calls.indexOf('theme') < f.calls.indexOf('Page.reload'));
  assert.ok(f.calls.indexOf('Page.reload') < f.calls.indexOf('prepare'));
  assert.ok(f.calls.indexOf('warm') < f.calls.indexOf('theme'));
  const detail = result.timings[0];
  assert.equal(detail.reloads, 1);
  for (const stage of ['owner', 'connect', 'runtime', 'theme', 'reload', 'resources', 'apply']) {
    assert.ok(Number.isFinite(detail.stages[stage]) && detail.stages[stage] >= 0, stage);
  }
  assert.ok(detail.totalMs >= detail.applyMs);
  assert.ok(f.statuses.some(({ type }) => type === 'injection-stage'));
  assert.equal(f.injector.sessions.get('main').attachmentVerified, false);
  await f.injector.update(gpuPlan);
  assert.equal(f.calls.filter((call) => call === 'Page.reload').length, 1, 'effect-only apply must not reload');
});

test('GPU hidden startup is deferred without CSP, runtime or source initialization and attaches when visible', async (t) => {
  const f = gpuFixture(t, { hidden: new Set(['hidden']) });
  f.injector.listTargets = async () => [target('hidden'), target('main')];
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 0);
  assert.equal(result.sessions, 1);
  assert.equal(result.deferred, 1);
  assert.equal(f.injector.sessions.has('hidden'), false);
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  assert.equal(f.calls.filter(call => call === 'warm').length, 1);
  assert.equal(f.calls.filter(call => call === 'Page.reload').length, 1);
  assert.equal(f.sockets[0].closed, true, 'temporary hidden probe must close');
  f.hidden.clear();
  await f.injector.scanOnce();
  assert.equal(f.injector.lastScanFailures, 0);
  assert.equal(f.injector.lastScanDeferred, 0);
  assert.equal(f.injector.sessions.size, 2);
  assert.equal(f.calls.filter(call => call === 'prepare').length, 2);
  assert.equal(f.calls.includes('Page.bringToFront'), false);
});

test('even a single all-hidden GPU page reports pending rather than fabricating a successful frame', async (t) => {
  const f = gpuFixture(t, { hidden: new Set(['main']) });
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.sessions, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.deferred, 1);
  for (const command of ['bootstrap', 'prepare', 'warm', 'Page.setBypassCSP', 'Page.reload']) {
    assert.equal(f.calls.includes(command), false, command);
  }
});

test('a deferred hidden GPU page never masks a real failure from a visible peer', async (t) => {
  const f = gpuFixture(t, { hidden: new Set(['hidden']), visibleFailure: true });
  f.injector.listTargets = async () => [target('hidden'), target('main')];
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.sessions, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.deferred, 1);
  assert.equal(f.calls.filter(call => call === 'apply').length, 1);
});

test('a later GPU initialization cannot reuse the initial attachment proof', async (t) => {
  const f = gpuFixture(t); await f.injector.start(gpuPlan);
  const session = f.injector.sessions.get('main');
  session.gpuCspInitialized = false;
  await f.injector.update(gpuPlan);
  assert.equal(f.calls.filter((call) => call === 'verify').length, 2);
});

test('a late host-theme fallback refresh still occurs before the only Scene preparation', async (t) => {
  const f = gpuFixture(t, { lateTheme: true });
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 0);
  assert.equal(result.timings[0].reloads, 2);
  assert.equal(f.calls.filter((call) => call === 'prepare').length, 1);
  assert.equal(f.calls.filter((call) => call === 'apply').length, 1);
  assert.ok(f.calls.lastIndexOf('Page.reload') < f.calls.indexOf('prepare'));
});

test('identity failure prevents even a multi-window visibility probe', async (t) => {
  const f = gpuFixture(t, { verified: false });
  f.injector.listTargets = async () => [target('a'), target('b')];
  const result = await f.injector.start(gpuPlan);
  assert.equal(result.failed, 2); assert.equal(result.sessions, 0);
  assert.equal(f.calls.includes('connect'), false);
  assert.equal(f.calls.includes('Runtime.evaluate'), false);
  assert.equal(f.calls.includes('warm'), false);
});

test('reload ignores a stale document and does not require loadEventFired or all subresources', async () => {
  const globals = {}; let probes = 0, reloads = 0;
  globals.top = globals;
  let reloadScript;
  const injector = new CdpWallpaperInjector();
  const session = { runtimeInstalled: true, socket: { async call(method, params) {
    if (method === 'Page.reload') { reloads++; reloadScript = params.scriptToEvaluateOnLoad; return {}; }
    if (method === 'Runtime.evaluate') {
      probes++;
      if (probes === 2) runInNewContext(reloadScript, { globalThis: globals });
      return { result: { value: runInNewContext(params.expression, { globalThis: globals,
        location: { origin: 'app://-' }, document: { body: {}, readyState: 'interactive', hidden: true } }) } };
    }
    throw Error('unexpected command');
  } } };
  await injector.reloadDocument(session);
  assert.equal(probes, 2); assert.equal(reloads, 1); assert.equal(session.runtimeInstalled, false);
});

test('reload tracks document and context changes before sending the command and discards a raced probe', async () => {
  const handlers = new Map(), globals = {};
  globals.top = globals;
  let probes = 0;
  const injector = new CdpWallpaperInjector();
  const session = { runtimeInstalled: true, socket: {
    onEvent(method, handler) { handlers.set(method, handler); return () => handlers.delete(method); },
    async call(method, params) {
      if (method === 'Page.reload') {
        assert.ok(handlers.has('Page.frameNavigated') && handlers.has('Runtime.executionContextsCleared'));
        handlers.get('Page.frameNavigated')({ frame: { id: 'main' } });
        runInNewContext(params.scriptToEvaluateOnLoad, { globalThis: globals });
        return {};
      }
      assert.equal(method, 'Runtime.evaluate');
      const value = runInNewContext(params.expression, { globalThis: globals,
        location: { origin: 'app://-' }, document: { body: {}, readyState: 'interactive' } });
      probes++;
      if (probes === 1) handlers.get('Runtime.executionContextsCleared')();
      return { result: { value } };
    },
  } };
  await injector.reloadDocument(session);
  assert.equal(probes, 2);
  assert.equal(handlers.size, 0);
});

test('visible target is applied before hidden ones and hidden concurrency is bounded at two', async (t) => {
  const applied = [], commands = [], sockets = [];
  let active = 0, maximum = 0, release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const pairStarted = new Promise((resolve) => { started = resolve; });
  const injector = new CdpWallpaperInjector({ pollIntervalMs: 60000, socketFactory: (url) => {
    const hidden = !url.endsWith('/visible');
    const socket = { closed: false, async connect() {},
      async call(method, params = {}) {
        commands.push(method);
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook' };
        if (method === 'Runtime.evaluate') {
          if (params.expression === 'document.hidden === true') return { result: { value: hidden } };
          if (params.expression === 'apply') {
            applied.push(url.split('/').at(-1));
            if (hidden) { active++; maximum = Math.max(maximum, active); if (active === 2) started(); await gate; active--; }
          }
          return { result: { value: { ok: true, ready: true, runtimeReady: true, domReady: true } } };
        }
        return {};
      }, close() { this.closed = true; },
    };
    sockets.push(socket); return socket;
  } });
  t.after(async () => { release(); await injector.close(); });
  injector.listTargets = async () => ['hidden-1', 'hidden-2', 'visible', 'hidden-3', 'hidden-4', 'hidden-5'].map(target);
  const starting = injector.start({ bootstrapScript: 'bootstrap', applyScript: 'apply' });
  await pairStarted;
  assert.deepEqual(applied.slice(0, 3), ['visible', 'hidden-1', 'hidden-2']);
  assert.equal(maximum, 2); release();
  const result = await starting;
  assert.equal(result.failed, 0); assert.equal(result.sessions, 6); assert.equal(maximum, 2);
  assert.equal(commands.includes('Page.bringToFront'), false);
  assert.equal(sockets.filter(({ closed }) => closed).length, 5, 'temporary hidden probes are closed');
});

test('serialized theme preflight exposes the same restore-aware theme implementation', () => {
  const bootstrap = buildBootstrapScript({ directSceneEnabled: true });
  assert.match(bootstrap, /prepareTheme: ensureDarkTheme/);
  assert.match(bootstrap, /m3-media-policy-v6/);
});

test('all-hidden startup serializes the first successful theme capture before parallel followers', async (t) => {
  const applied = []; let release, notify;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstApply = new Promise((resolve) => { notify = resolve; });
  const injector = new CdpWallpaperInjector({ pollIntervalMs: 60000, socketFactory: (url) => ({
    async connect() {},
    async call(method, params = {}) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook' };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.hidden === true') return { result: { value: true } };
        if (params.expression === 'apply') {
          applied.push(url.split('/').at(-1));
          if (url.endsWith('/one')) { notify(); await gate; }
        }
        return { result: { value: { ok: true, ready: true, runtimeReady: true, domReady: true } } };
      }
      return {};
    }, close() {},
  }) });
  t.after(async () => { release(); await injector.close(); });
  injector.listTargets = async () => ['one', 'two', 'three'].map(target);
  const starting = injector.start({ bootstrapScript: 'bootstrap', applyScript: 'apply' });
  await firstApply;
  assert.deepEqual(applied, ['one']);
  release();
  assert.equal((await starting).sessions, 3);
});

test('theme fallback recursion preserves the entire timing rather than only the final apply', async () => {
  let applications = 0, bootstraps = 0;
  const stages = [];
  const injector = new CdpWallpaperInjector({ onStatus: (event) => stages.push(event) });
  const session = { target: target('timing'), runtimeInstalled: false, socket: {
    async call(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'bootstrap') { bootstraps++; return { result: { value: { ready: true } } }; }
        if (params.expression === 'apply') {
          applications++;
          return { result: { value: { ok: true, runtimeReady: true, domReady: true,
            theme: { reloadRequired: applications === 1 } } } };
        }
      }
      return {};
    },
  } };
  const result = await injector.installScript(session, { bootstrapScript: 'bootstrap', applyScript: 'apply' }, { updateReloadHook: false });
  assert.equal(bootstraps, 2); assert.equal(applications, 2); assert.equal(result.reloads, 1);
  assert.ok(result.stages.reload >= 300, 'the retained legacy fallback delay must be included');
  assert.ok(result.totalMs >= result.stages.reload);
  assert.equal(stages.filter(({ type }) => type === 'injection-ready').length, 1);
});

test('a lifecycle change during visibility probing prevents deferred installation', async (t) => {
  const commands = [];
  const injector = new CdpWallpaperInjector({ pollIntervalMs: 60000, socketFactory: () => ({
    async connect() {},
    async call(method, params = {}) {
      commands.push(method);
      if (params.expression === 'document.hidden === true') {
        injector.lifecycleVersion++;
        return { result: { value: false } };
      }
      return {};
    },
    close() {},
  }) });
  t.after(() => injector.close());
  injector.listTargets = async () => [target('a'), target('b')];
  const result = await injector.start({ bootstrapScript: 'bootstrap', applyScript: 'apply' });
  assert.equal(result.sessions, 0);
  assert.equal(commands.includes('Page.setBypassCSP'), false);
  assert.equal(commands.includes('Page.addScriptToEvaluateOnNewDocument'), false);
});

test('resource warming shares in-flight work, obeys the two-key limit, and seals on close', async () => {
  let finish; const gate = new Promise((resolve) => { finish = resolve; });
  const requested = [];
  const delivery = new DirectSceneDelivery({ getProject: async (key) => { requested.push(key); await gate; return null; }, getConfig: () => ({}) });
  try {
    const a = delivery.warm('a'); assert.equal(delivery.warm('a'), a);
    const b = delivery.warm('b'); assert.equal(await delivery.warm('c'), false);
    const closing = delivery.close();
    assert.equal(await delivery.warm('d'), false);
    finish(); await closing;
    assert.deepEqual(await Promise.all([a, b]), [false, false]);
    assert.deepEqual(requested, ['a', 'b']);
  } finally { finish(); await delivery.close(); }
});
