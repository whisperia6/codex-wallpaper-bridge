import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { CdpWallpaperInjector } from '../bridge-overrides/src/cdp-injector.mjs';
import { buildInjectionPlan } from '../bridge-overrides/src/injection-plan.mjs';

const descriptor = { origin: 'http://127.0.0.1:43123', basePath: '/1234567890abcdef1234567890abcdef' };
const target = id => ({ id, type: 'page', url: 'app://-',
  webSocketDebuggerUrl: `ws://127.0.0.1:9335/devtools/page/${id}` });
const source = await readFile(new URL('../bridge-overrides/src/injected-renderer.mjs', import.meta.url), 'utf8');
const applySource = source.slice(source.indexOf('const apply = (payload) =>'), source.indexOf('const restore = async (options'));

function mediaPlan(type = 'video', options = { nativeEnabled: true, directSceneEnabled: true }) {
  const project = { id: type, type, mediaUrl: `${descriptor.basePath}/api/video/${type}`,
    previewUrl: `${descriptor.basePath}/api/preview/${type}`, webUrl: `${descriptor.basePath}/api/web/${type}/index.html` };
  const plan = buildInjectionPlan({ server: descriptor, config: { selectedId: type }, inventory: { projects: [project] }, ...options });
  return { ...plan, bootstrapScript: 'bootstrap', applyScript: 'apply' };
}

function fixture(t, { verified = true, decodeFailure = false, reportedState = null, forgedSuccess = false } = {}) {
  const calls = [], statuses = [], sockets = [], targets = [target('main')];
  const injector = new CdpWallpaperInjector({ pollIntervalMs: 60000,
    verifyEndpoint: async () => { calls.push({ method: 'verify' }); return { verified }; },
    onStatus: event => statuses.push(event), socketFactory: () => {
      const globals = {};
      let bypass = false, documentBypass = false;
      const socket = { closed: false, async connect() {},
        resetDocument() { documentBypass = false; },
        async call(method, params = {}, timeout) {
          calls.push({ method, params, timeout });
          if (method === 'Page.setBypassCSP') bypass = params.enabled;
          if (method === 'Page.reload') { documentBypass = bypass; delete globals.__cwbDocumentReload; }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook' };
          if (method === 'Runtime.callFunctionOn') return { result: params.returnByValue ? { value: true } : { objectId: 'receiver' } };
          if (method === 'Runtime.evaluate') {
            const expression = params.expression;
            if (expression === 'document.hidden === true') return { result: { value: false } };
            if (expression === 'bootstrap') return { result: params.returnByValue === false ? { objectId: 'boot' } : { value: { ready: true } } };
            if (expression.endsWith('.prepareTheme()')) return { result: { value: { state: 'dark', reloadRequired: false } } };
            if (expression === 'apply') {
              const ok = documentBypass && !decodeFailure;
              return { result: { value: { ok: forgedSuccess || ok, runtimeReady: true, domReady: true, theme: { reloadRequired: false },
                media: { state: reportedState || (ok ? 'ready' : 'error') }, switchResult: { ok, error: ok ? null : 'Media failed to load or decode' } } } };
            }
            if (expression.startsWith('globalThis.__cwbDocumentReload')) return { result: { value: runInNewContext(expression,
              { globalThis: globals, location: { origin: 'app://-' }, document: { readyState: 'interactive', body: {} } }) } };
            return { result: { value: { ok: true, theme: { reloadRequired: false } } } };
          }
          return {};
        },
        onEvent() { return () => {}; }, close() { this.closed = true; },
      };
      sockets.push(socket); return socket;
    },
  });
  injector.nativeDelivery = { close: async () => {} };
  injector.sceneDelivery = { warm: async () => { throw Error('ordinary media must not warm a scene'); }, close: async () => {} };
  injector.listTargets = async () => targets;
  t.after(() => injector.close());
  return { injector, calls, statuses, targets, sockets };
}

for (const options of [{ nativeEnabled: true, directSceneEnabled: true }, { nativeEnabled: true }, {}]) {
  test(`first video initializes document media access before apply: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t), plan = mediaPlan('video', options);
    const result = await f.injector.start(plan);
    assert.equal(result.failed, 0); assert.equal(result.sessions, 1);
    assert.equal(f.calls.filter(c => c.method === 'Page.reload').length, 1);
    const applyIndex = f.calls.findIndex(c => c.params?.expression === 'apply');
    assert.ok(f.calls.findIndex(c => c.method === 'Page.reload') < applyIndex);
    assert.equal(f.injector.sessions.get('main').cspBypassActive, true);
    assert.ok(f.calls[applyIndex].timeout > 15000, 'CDP must allow the existing 15 s media gate to settle');
    await f.injector.update(plan);
    assert.equal(f.calls.filter(c => c.method === 'Page.reload').length, 1, 'effect-only updates must not reload');
    await f.injector.restore();
    const reloads = f.calls.map((c, i) => c.method === 'Page.reload' ? i : -1).filter(i => i >= 0);
    assert.equal(reloads.length, 2, 'restore must reset the bypassed document');
    assert.equal(f.calls.slice(0, reloads[1]).findLast(c => c.method === 'Page.setBypassCSP').params.enabled, false);
    assert.equal(f.injector.sessions.get('main').cspBypassActive, false);
  });
}

test('injection plans mark local media, not empty or native-only scenes, for document initialization', () => {
  for (const kind of ['video', 'image', 'web']) assert.equal(mediaPlan(kind, {}).requiresMediaCsp, true, kind);
  assert.equal(mediaPlan('scene').requiresMediaCsp, true);
  assert.equal(mediaPlan('scene', { nativeEnabled: true }).requiresMediaCsp, false);
  const empty = buildInjectionPlan({ server: descriptor, config: {}, inventory: { projects: [] }, nativeEnabled: true, directSceneEnabled: true });
  assert.equal(empty.requiresMediaCsp, false);
});

test('media document requirement survives updates, new targets and rehydration', async t => {
  const f = fixture(t), plan = mediaPlan();
  await f.injector.start(plan);
  await f.injector.update(plan);
  f.targets.push(target('second'));
  await f.injector.scanOnce();
  assert.equal(f.injector.sessions.size, 2);
  assert.equal(f.calls.filter(c => c.method === 'Page.reload').length, 2);
  const session = f.injector.sessions.get('main');
  session.gpuCspInitialized = false; f.sockets[0].resetDocument();
  await f.injector.rehydrateSession(session);
  assert.equal(f.calls.filter(c => c.method === 'Page.reload').length, 3);
  assert.equal(f.statuses.some(event => event.type === 'rehydrate-error'), false);
});

test('unverified owned-media startup fails before any document mutation', async t => {
  const f = fixture(t, { verified: false });
  const result = await f.injector.start(mediaPlan());
  assert.equal(result.failed, 1); assert.equal(result.sessions, 0);
  assert.equal(f.calls.some(c => c.method === 'Page.setBypassCSP' || c.method === 'Page.reload' || c.params?.expression === 'apply'), false);
});

test('first-media decode failure never emits injection-ready and cleans the initialized document', async t => {
  const f = fixture(t, { decodeFailure: true });
  const result = await f.injector.start(mediaPlan());
  assert.equal(result.failed, 1); assert.equal(result.sessions, 0);
  assert.equal(f.statuses.some(event => event.type === 'injection-ready'), false);
  assert.equal(f.calls.filter(c => c.method === 'Page.reload').length, 2);
  assert.equal(f.calls.findLast(c => c.method === 'Page.setBypassCSP').params.enabled, false);
});

for (const reportedState of ['loading', 'error', 'play-rejected']) {
  test(`CDP verification rejects ${reportedState} even if a renderer reports ok`, async t => {
    const f = fixture(t, { reportedState, forgedSuccess: true });
    const result = await f.injector.start(mediaPlan());
    assert.equal(result.failed, 1); assert.equal(result.sessions, 0);
    assert.equal(f.statuses.some(event => event.type === 'injection-ready'), false);
  });
}

test('CDP verification rejects a failed switch even with a stale ready media state', async t => {
  const f = fixture(t, { decodeFailure: true, reportedState: 'ready', forgedSuccess: true });
  const result = await f.injector.start(mediaPlan());
  assert.equal(result.failed, 1); assert.equal(result.sessions, 0);
});

function applyFixture() {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const context = { currentMediaIdentity: '', current: null, lastMediaOperation: null,
    normalizeEffects: v => v || {}, ensureDarkTheme: async () => ({ state: 'dark', reloadRequired: false }),
    document: { body: {}, hidden: false, documentElement: { dataset: {} }, getElementById: () => ({ dataset: {} }) },
    ids: { root: 'root', media: 'media' }, ensureStyle() {}, ensureRoot() {}, applyVariables() {}, syncPlayback() {},
    applyShellOverrides() {}, updateVisibilityHandler() {}, startObserver() {}, mediaState: { state: 'loading' },
    mediaIdentity: wallpaper => wallpaper?.id || '',
    mountMedia: () => gate.then(result => { context.mediaState.state = result.ok ? 'ready' : 'error'; return result; }),
  };
  return { apply: runInNewContext(applySource + '\napply', context), resolve };
}

for (const playable of ['video', 'image', 'web']) {
  test(`first ${playable} waits for readiness rather than treating DOM existence as success`, async () => {
    const f = applyFixture(); let settled = false;
    const applying = f.apply({ wallpaper: { id: playable, playable } }).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    f.resolve({ ok: true });
    const result = await applying;
    assert.equal(result.ok, true); assert.equal(result.mediaState, 'ready');
  });

  test(`first ${playable} reports a load failure even when its DOM already exists`, async () => {
    const f = applyFixture();
    const applying = f.apply({ wallpaper: { id: playable, playable } });
    f.resolve({ ok: false, error: 'Media failed to load or decode' });
    const result = await applying;
    assert.equal(result.ok, false); assert.equal(result.switchResult.error, 'Media failed to load or decode');
  });
}

test('composer body uses the native composer surface for one uniform tone', () => {
  const rule = source.slice(
    source.indexOf('[data-composer-placement="thread"] [data-composer-body]'),
    source.indexOf('html[data-codex-wallpaper-bridge="active"] [class*="bg-gradient-to-t"]'),
  );
  assert.match(rule, /--composer-layout-surface-background/);
  assert.match(rule, /border-radius:\s*inherit/);
  assert.match(rule, /bg-\(--composer-layout-surface-background\)/);
  assert.match(rule, /background-image:\s*none/);
  assert.doesNotMatch(rule, /--cwb-glass-alpha/);
});
test('user message bubbles keep their native surface', () => {
  assert.doesNotMatch(source, /\[data-user-message-bubble\]\s*,/);
});
test('fallback dark theme updates data-theme for modern Codex builds and clears content fade', () => {
  assert.match(source, /getAttribute\?\.\("data-theme"\)/);
  assert.match(source, /setAttribute\?\.\("data-theme",\s*desired\)/);
  assert.match(source, /--app-shell-content-fade:\s*none !important/);
  assert.match(source, /\[class\*="app-shell-content-fade"\]/);
});
