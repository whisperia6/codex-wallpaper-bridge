import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CdpWallpaperInjector } from '../bridge-overrides/src/cdp-injector.mjs';
import { buildInjectionPlan } from '../bridge-overrides/src/injection-plan.mjs';

function fixture(t, { verified = true, broken = null } = {}) {
  const owners = [], calls = [], statuses = [], events = new Map(); let key = null, readyResolve;
  const provider = { async retry() { broken = null; return { cleared: true }; }, async verifyEndpoint(port) { calls.push({ op: 'verify', port }); return { verified }; }, create(id) {
    const owner = { key: id, ready: Promise.resolve(), closed: false, sequence: 0, pauses: 0,
      captureEncoded: async () => { if (broken === id) throw Error('failed'); const sequence = ++owner.sequence;
        return { vp8: Uint8Array.of(48, 0, 0, 157, 1, 42, 32, 3, 194, 1, 0), width: 800, height: 450, sequence, timestamp: sequence * 100000 }; },
      async pause() { this.pauses++; }, async resume() {}, async release() { this.closed = true; },
      status() { return { resourcesClosed: this.closed }; } };
    owners.push(owner); return owner;
  } };
  const socket = { ws: new EventEmitter(), closed: false,
    async connect() { calls.push({ op: 'connect' }); },
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'bootstrap') return { result: { objectId: 'boot' } };
        if (params.expression === 'restore') return { result: { value: { ok: true } } };
        if (params.expression.includes('delete globalThis')) return { result: { value: { ok: true } } };
        if (params.expression.startsWith('apply:')) {
          key = params.expression.slice(6);
          return new Promise((resolve) => { readyResolve = (ok) => resolve({ result: { value: { ok, runtimeReady: true, domReady: true } } }); });
        }
      }
      if (method === 'Runtime.callFunctionOn') {
        if (params.objectId === 'boot') return { result: params.returnByValue ? { value: true } : { objectId: 'receiver' } };
        if (!params.arguments) { readyResolve?.(false); return { result: { value: true } }; }
        const [action, id, packet] = params.arguments.map((v) => v.value);
        if (params.functionDeclaration.includes('this.retry')) return { result: { value: true } };
        if (action === 'state') return { result: { value: { present: key === id, playing: true, volume: 0, pointer: [] } } };
        if (action === 'accept') { readyResolve?.(true); return { result: { value: { ok: true, sequence: packet.sequence } } }; }
        if (action === 'fail') { readyResolve?.(false); return { result: { value: true } }; }
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook' };
      return {};
    },
    onEvent(method, handler) { events.set(method, handler); return () => events.delete(method); }, close() { this.closed = true; },
  };
  const injector = new CdpWallpaperInjector({ nativeProvider: provider, socketFactory: () => socket, pollIntervalMs: 60000,
    onStatus: (event) => statuses.push(event) });
  injector.listTargets = async () => [{ id: 'target', type: 'page', url: 'app://-', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/mock' }];
  t.after(() => injector.close());
  const plan = (id) => ({ bootstrapScript: 'bootstrap', applyScript: `apply:${id}`,
    nativeEnabled: true, nativeWallpaperId: id });
  return { injector, plan, owners, calls, socket, events, statuses };
}

test('multi-renderer update reports fixed failed-apply categories without raw renderer or author content', async (t) => {
  const f = fixture(t); await f.injector.start(f.plan('scene'));
  const call = f.socket.call;
  f.socket.call = async (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.startsWith('apply:')) {
      return { result: { value: { ok: false, runtimeReady: true, domReady: true,
        mediaState: 'ready', switchResult: { error: 'Media load timed out' },
        privateAuthorText: 'secret-auth-url-and-body' } } };
    }
    return call(method, params);
  };
  const result = await f.injector.update(f.plan('scene'));
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failureDetails, [{ targetIndex: 0, category: 'renderer-dom-not-ready',
    cdpCode: null, mediaState: 'ready', switchFailure: 'media-load-timeout' }]);
  assert.deepEqual(JSON.parse(f.statuses.find((e) => e.type === 'injection-failed').message), result.failureDetails[0]);
  assert.ok(!JSON.stringify(result.failureDetails).includes('secret'));
  assert.equal(f.injector.sessions.get('target').nativeLease.key, 'scene');
  assert.equal(f.owners[0].closed, false);
});

test('update diagnostics do not leak unknown messages and retain all-renderer failure semantics', async (t) => {
  const f = fixture(t); await f.injector.start(f.plan('scene'));
  const call = f.socket.call;
  for (const [error, category, cdpCode] of [
    [Object.assign(Error('Cannot find object with given id'), { cdpCode: -32000 }), 'receiver-disposed', -32000],
    [Object.assign(Error('private URL and author exception'), { cdpCode: -32000 }), 'cdp-command-error', -32000],
    [Object.assign(Error('Cannot find object with given id'), { cdpCode: '-32000' }), 'unknown', null],
    [Error('CDP Runtime.evaluate timed out'), 'cdp-timeout', null],
    [Error('arbitrary author text'), 'unknown', null],
  ]) {
    f.socket.call = async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.startsWith('apply:')) throw error;
      return call(method, params);
    };
    const result = await f.injector.update(f.plan('scene'));
    assert.equal(result.failed, 1); assert.equal(result.sessions, 1);
    assert.deepEqual(result.failureDetails, [{ targetIndex: 0, category, cdpCode,
      mediaState: 'unknown', switchFailure: 'unknown' }]);
    assert.ok(!JSON.stringify(result.failureDetails).includes('author'));
  }
  f.socket.call = call;
  assert.deepEqual((await f.injector.update(f.plan('scene'))).failureDetails, []);
});
test('document disposal seals native leases before any asynchronous receiver close', async (t) => {
  const f = fixture(t); await f.injector.start(f.plan('scene'));
  const session = f.injector.sessions.get('target'), lease = session.nativeLease, call = f.socket.call;
  let releaseClose, closing = false;
  const gate = new Promise((resolve) => { releaseClose = resolve; }); t.after(() => releaseClose());
  f.socket.call = async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.close()')) {
      closing = true; await gate;
    }
    return call(method, params);
  };
  const releasing = f.injector.releaseSessionNative(session);
  await Promise.resolve(); assert.equal(closing, true);
  try { assert.equal(lease.closed, true); assert.equal(f.owners[0].closed, true); }
  finally { releaseClose(); await releasing; }
});
test('external document context loss cancels old leases before rehydration, without poisoning a fresh source', async (t) => {
  const f = fixture(t); await f.injector.start(f.plan('scene'));
  const session = f.injector.sessions.get('target'), lease = session.nativeLease;
  assert.equal(typeof f.events.get('Runtime.executionContextsCleared'), 'function');
  f.events.get('Runtime.executionContextsCleared')({});
  assert.equal(lease.closed, true); assert.equal(session.runtimeInstalled, false);
  await f.injector.rehydrateSession(session);
  assert.equal(session.nativeLease.closed, false); assert.notEqual(session.nativeLease, lease);
  assert.equal(f.owners.length, 2); assert.equal(f.owners[0].closed, true);
  assert.equal(f.injector.nativeDelivery.diagnostics()[0].failed, false);
  await f.injector.close({ restore: true }); assert.equal(f.events.size, 0);
});
test('a destroyed private receiver reported before context-cleared event retires and rehydrates only that session', async (t) => {
  const f = fixture(t); await f.injector.start(f.plan('scene'));
  const session = f.injector.sessions.get('target'), old = session.nativeLease, call = f.socket.call;
  let lost = false;
  f.socket.call = async (method, params) => {
    if (!lost && method === 'Runtime.callFunctionOn' && params.arguments?.[0]?.value === 'accept') {
      lost = true; throw Object.assign(Error('Cannot find object with given id'), { cdpCode: -32000 });
    }
    return call(method, params);
  };
  const deadline = Date.now() + 1000;
  while ((!lost || session.nativeLease === old || !session.nativeLease?.accepted) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(lost, true); assert.equal(old.closed, true);
  assert.notEqual(session.nativeLease, old); assert.ok(session.nativeLease?.accepted > 0);
  assert.equal(f.owners[0].closed, true); assert.equal(f.owners.at(-1).closed, false);
  assert.equal(f.injector.nativeDelivery.diagnostics()[0].failed, false);
});
test('native injector verifies identity before connecting, keeps CSP, commits only decoded-ready source', async (t) => {
  const f = fixture(t), start = await f.injector.start(f.plan('scene'));
  assert.equal(start.failed, 0); assert.equal(start.sessions, 1);
  assert.deepEqual(f.calls.slice(0, 2).map((c) => c.op), ['verify', 'connect']);
  assert.ok(f.calls.filter((c) => c.method === 'Page.setBypassCSP').every((c) => c.params.enabled === false));
  const session = f.injector.sessions.get('target'); assert.equal(session.nativeLease.key, 'scene');
  assert.ok(session.nativeLease.accepted > 0); assert.equal(f.owners.length, 1);
  assert.equal((await f.injector.update(f.plan('scene'))).failed, 0); assert.equal(f.owners.length, 1);
  await f.injector.close({ restore: true }); assert.equal(f.owners[0].closed, true);
  assert.equal(f.injector.nativeDelivery.status().sources, 0);
});
test('unverified native endpoint never opens a socket, executes a script, or creates a renderer', async (t) => {
  const f = fixture(t, { verified: false }), start = await f.injector.start(f.plan('scene'));
  assert.equal(start.failed, 1); assert.equal(start.sessions, 0); assert.equal(f.owners.length, 0);
  assert.equal(f.calls.filter((c) => c.op === 'connect').length, 0);
  assert.equal(f.calls.filter((c) => c.method === 'Runtime.evaluate').length, 0);
});
test('failed native candidate releases only its lease and keeps old committed source live', async (t) => {
  const f = fixture(t, { broken: 'broken' }); await f.injector.start(f.plan('old'));
  const result = await f.injector.update(f.plan('broken')); assert.equal(result.failed, 1);
  assert.equal(f.injector.sessions.get('target').nativeLease.key, 'old');
  assert.equal(f.owners[0].closed, false); assert.equal(f.owners[1].closed, true);
});
test('explicit injector retry clears both caches, requests private same-identity preparation and commits via M1', async (t) => {
  const f = fixture(t, { broken: 'broken' }); await f.injector.start(f.plan('old'));
  assert.equal((await f.injector.update(f.plan('broken'))).failed, 1);
  const before = f.owners.length; assert.equal((await f.injector.update(f.plan('broken'))).failed, 1);
  assert.equal(f.owners.length, before); await f.injector.retryNative('broken');
  assert.equal((await f.injector.update(f.plan('broken'))).failed, 0);
  assert.equal(f.injector.sessions.get('target').nativeLease.key, 'broken');
  assert.ok(f.calls.some((call) => call.params?.functionDeclaration?.includes('this.retry')));
});
test('native retry distinguishes an unchanged renderer, a retired lease, and a CDP evaluation failure', async (t) => {
  const f = fixture(t);
  await f.injector.start(f.plan('scene'));
  const call = f.socket.call;
  let response = { result: { value: false } };
  f.socket.call = async (method, params) => params?.functionDeclaration?.includes('this.retry') ? response : call(method, params);
  assert.deepEqual(await f.injector.retryNative('scene'), { cleared: false });
  const session = f.injector.sessions.get('target');
  await session.nativeLease.release();
  assert.deepEqual(await f.injector.retryNative('scene'), { cleared: true });
  assert.equal(session.nativeLease, null);
  response = { exceptionDetails: { text: 'CDP retry evaluation failed' } };
  await assert.rejects(f.injector.retryNative('scene'), /CDP retry evaluation failed/);
});
test('native injection plans contain project identity only, never author URL/path/property index', () => {
  const server = { origin: 'http://127.0.0.1:18700', basePath: '/0123456789abcdefghijklmnop' };
  const inventory = { projects: [{ id: 'scene', type: 'scene', rootPath: 'D:/private',
    sceneScript: 'author-script', previewUrl: `${server.basePath}/api/preview/scene` }] };
  const plan = buildInjectionPlan({ server, inventory, config: { selectedId: 'scene', authorProperties: { scene: { enabled: true } } }, nativeEnabled: true });
  assert.equal(plan.nativeWallpaperId, 'scene'); assert.equal(plan.nativeEnabled, true);
  for (const value of ['D:/private', 'author-script', 'authorProperties']) assert.ok(!plan.applyScript.includes(value));
  assert.match(plan.applyScript, /"playable":"native"/);
});
