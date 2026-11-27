import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createEngineProviderClient, serveEngineProvider } from '../src/engine-provider-rpc.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); return { promise, resolve, reject };
}
function png() {
  const bytes = Buffer.alloc(40); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(450, 20);
  return bytes;
}
function fixture(t, { resolveProject, verifyEndpoint, pendingReady = false, captureGate, invalidFrame = false, invalidEncoded = false, timeoutMs = 1000 } = {}) {
  const peer = new EventEmitter(), port = new EventEmitter(), owners = [], resolutions = [], responses = [];
  peer.postMessage = (data) => { responses.push(data); queueMicrotask(() => port.emit('message', { data: structuredClone(data) })); };
  port.postMessage = (data) => { queueMicrotask(() => peer.emit('message', structuredClone(data))); };
  const server = serveEngineProvider({ peer, verifyEndpoint, resolveProject: resolveProject ?? (async (id) => {
    resolutions.push(id); return id === 'registered' ? { project: { id, type: 'scene', rootPath: 'parent-only-path' }, config: { marker: 1 }, properties: { enabled: true } } : null;
  }), createOwner: (snapshot) => {
    const ready = deferred(), owner = { snapshot, ready: ready.promise, closed: false, releases: 0, captures: 0, writes: 0,
      status() { return { phase: this.closed ? 'released' : 'ready', closed: this.closed, resourcesClosed: this.closed, actualFrame: !this.closed }; },
      async capture() { this.captures++; await captureGate?.promise; return { png: invalidFrame ? Buffer.alloc(40) : png(), width: 800, height: 450, sequence: this.captures }; },
      async captureEncoded() {
        this.captures++; await captureGate?.promise;
        const bytes = Buffer.alloc(24); bytes[0] = 48; bytes.set([157, 1, 42], 3); bytes.writeUInt16LE(800, 6); bytes.writeUInt16LE(450, 8);
        return { vp8: invalidEncoded ? Buffer.alloc(24) : bytes, width: 800, height: 450, sequence: this.captures, timestamp: this.captures * 100000 };
      },
      async pause() { this.paused = true; }, async resume() { this.paused = false; },
      async properties(values) { this.writes++; return { phase: 'ready', method: 'engine-readback', values: values ?? { enabled: true } }; },
      async release() { this.releases++; this.closed = true; ready.reject(Error('author/path/must/not/be-returned')); },
    };
    owners.push(owner); if (!pendingReady) ready.resolve(owner); return owner;
  } });
  const client = createEngineProviderClient({ port, timeoutMs });
  t.after(async () => { client.close(); await server.close(); });
  return { peer, port, owners, resolutions, responses, server, client };
}
test('endpoint verification forwards an optional known host type and fails closed on mismatches', async (t) => {
  const checks = [];
  const f = fixture(t, { verifyEndpoint: async (port, hostType, purpose) => {
    checks.push([port, hostType, purpose]);
    return { verified: hostType === undefined || hostType === 'antigravity' };
  } });
  assert.deepEqual(await f.client.verifyEndpoint(9336, 'antigravity'), { verified: true });
  await assert.rejects(f.client.verifyEndpoint(9336, 'codex'), /endpoint_unverified/);
  await assert.rejects(f.client.verifyEndpoint(9336, 'unknown'), /invalid_request/);
  assert.deepEqual(await f.client.verifyEndpoint(9336), { verified: true });
  assert.deepEqual(await f.client.verifyEndpoint(9336, 'antigravity', 'restore'), { verified: true });
  await assert.rejects(f.client.verifyEndpoint(9336, 'antigravity', 'attach'), /invalid_request/);
  await assert.rejects(f.client.verifyEndpoint(9336, undefined, 'restore'), /invalid_request/);
  assert.deepEqual(checks, [[9336, 'antigravity', undefined], [9336, 'codex', undefined],
    [9336, undefined, undefined], [9336, 'antigravity', 'restore']]);
});
async function raw(f, request) {
  const count = f.responses.length; f.port.postMessage({ channel: 'cwb-engine-provider-v1', ...request });
  for (let i = 0; i < 100 && f.responses.length === count; i++) await tick();
  assert.ok(f.responses.length > count); return f.responses.at(-1);
}
test('native RPC resolves only the parent registry and clones bounded genuine capture bytes', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  assert.deepEqual(f.resolutions, ['registered']); assert.equal(f.owners[0].snapshot.project.rootPath, 'parent-only-path');
  assert.equal(f.owners[0].snapshot.config.marker, 1); assert.equal(f.owners[0].snapshot.properties.enabled, true);
  const frame = await proxy.capture(); assert.ok(Buffer.isBuffer(frame.png)); assert.ok(frame.png.equals(png()));
  await proxy.pause(); await proxy.resume(); assert.equal(f.owners[0].paused, false);
  await proxy.release(); assert.equal(f.owners[0].releases, 1); assert.equal(proxy.status().resourcesClosed, true);
});
test('requests cannot supply paths, config, schema, deadlines or unsupported operations', async (t) => {
  const f = fixture(t);
  for (const [index, extra] of ['rootPath', 'config', 'schema', 'firstFrameTimeoutMs', 'url'].entries()) {
    const result = await raw(f, { sequence: index + 1, op: 'create', projectId: 'registered', [extra]: 'untrusted' });
    assert.equal(result.error, 'invalid_request');
  }
  assert.equal((await raw(f, { sequence: 6, op: 'execute', code: 'ignored' })).error, 'invalid_request');
  assert.equal(f.owners.length, 0); assert.equal(f.resolutions.length, 0);
});
test('unregistered IDs and handles fail with fixed errors, never filesystem paths', async (t) => {
  const f = fixture(t), proxy = f.client.create('unknown'); await assert.rejects(proxy.ready, /unregistered_project/);
  assert.equal((await raw(f, { sequence: 2, op: 'capture', handle: 'a'.repeat(32) })).error, 'unknown_engine');
  assert.equal(f.owners.length, 0); assert.equal(JSON.stringify(f.responses).includes('parent-only-path'), false);
});
test('two reservations include pending registry lookups, not just ready windows', async (t) => {
  const gate = deferred(), f = fixture(t, { resolveProject: () => gate.promise });
  const a = f.client.create('registered'), b = f.client.create('registered'), c = f.client.create('registered');
  await assert.rejects(c.ready, /provider_capacity/); assert.equal(f.server.status().slots, 2); assert.equal(f.owners.length, 0);
  await f.server.close(); gate.resolve({ project: { id: 'registered', type: 'scene' } });
  f.client.close(); await Promise.allSettled([a.ready, b.ready]); await tick(); assert.equal(f.owners.length, 0);
});
test('release interrupts an outstanding native ready without waiting for first-frame timeout', async (t) => {
  const f = fixture(t, { pendingReady: true }), proxy = f.client.create('registered');
  await tick(); await tick(); await proxy.release(); await assert.rejects(proxy.ready, /engine_unavailable|engine_cancelled/);
  assert.equal(f.owners[0].closed, true); assert.equal(f.server.status().slots, 0);
});
test('same-handle captures are single-flight and stale requests cannot replay native work', async (t) => {
  const gate = deferred(), f = fixture(t, { captureGate: gate }), proxy = f.client.create('registered'); await proxy.ready;
  const first = proxy.capture(); await tick(); await assert.rejects(proxy.capture(), /provider_busy/);
  gate.resolve(); await first; assert.equal(f.owners[0].captures, 1);
  assert.equal((await raw(f, { sequence: 1, op: 'create', projectId: 'registered' })).error, 'stale_request');
  assert.equal(f.owners.length, 1);
});
test('invalid native capture shape or PNG header is rejected instead of crossing the boundary', async (t) => {
  const f = fixture(t, { invalidFrame: true }), proxy = f.client.create('registered'); await proxy.ready;
  await assert.rejects(proxy.capture(), /invalid_native_frame/);
  assert.equal(JSON.stringify(f.responses).includes('png'), false);
});
test('encoded native capture crosses only the owned channel with fixed VP8 bounds', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  const frame = await proxy.captureEncoded(); assert.equal(frame.vp8.length, 24); assert.equal(frame.timestamp, 100000);
  assert.equal('png' in frame, false); assert.equal('rootPath' in frame, false);
  const invalid = fixture(t, { invalidEncoded: true }), bad = invalid.client.create('registered'); await bad.ready;
  await assert.rejects(bad.captureEncoded(), /invalid_native_frame/);
  assert.equal(JSON.stringify(invalid.responses).includes('vp8'), false);
});
test('release interrupts an encoded capture and forbids a late native keyframe crossing', async (t) => {
  const gate = deferred(), f = fixture(t, { captureGate: gate }), proxy = f.client.create('registered'); await proxy.ready;
  const pending = proxy.captureEncoded(); await tick(); await proxy.release(); gate.resolve();
  await assert.rejects(pending, /engine_unavailable/); assert.equal(f.server.status().slots, 0);
  assert.equal(f.responses.some((response) => response.result?.vp8), false);
});
test('generic property envelope is bounded before actual owner schema validation', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  await assert.rejects(proxy.properties({ bad: Infinity }), /invalid_request/);
  await assert.rejects(proxy.properties({ bad: 'x'.repeat(4097) }), /invalid_request/);
  await assert.rejects(proxy.properties({ bad: { arbitrary: true } }), /invalid_request/);
  assert.equal(f.owners[0].writes, 0); assert.equal((await proxy.properties({ enabled: false })).values.enabled, false);
});
test('child exit seals the provider, releases all native resources and removes owned listeners', async (t) => {
  const f = fixture(t), a = f.client.create('registered'), b = f.client.create('registered'); await Promise.all([a.ready, b.ready]);
  f.peer.emit('exit', 0); await f.server.close(); assert.ok(f.owners.every((owner) => owner.closed && owner.releases === 1));
  assert.equal(f.peer.listenerCount('message'), 0); assert.equal(f.peer.listenerCount('exit'), 0);
  assert.equal(f.server.status().slots, 0); assert.equal(f.server.status().closed, true);
});
test('client timeout closes the owned parent channel and cannot resurrect a late lookup', async (t) => {
  const gate = deferred(), f = fixture(t, { resolveProject: () => gate.promise, timeoutMs: 60 });
  const proxy = f.client.create('registered'); await assert.rejects(proxy.ready, /provider_timeout/); await tick();
  gate.resolve({ project: { id: 'registered', type: 'scene' } }); await tick();
  assert.equal(f.client.status().closed, true); assert.equal(f.server.status().closed, true); assert.equal(f.owners.length, 0);
  assert.equal(f.port.listenerCount('message'), 0);
});
test('opaque engine handles are scoped to the fixed owning UtilityProcess peer', async (t) => {
  const a = fixture(t), b = fixture(t), proxy = a.client.create('registered'); await proxy.ready;
  const handle = a.responses.find((r) => r.result?.handle).result.handle;
  assert.equal((await raw(b, { sequence: 1, op: 'capture', handle })).error, 'unknown_engine');
  assert.equal(a.owners[0].captures, 0); assert.equal(b.owners.length, 0);
});
test('release during native capture suppresses a late frame even if a fake native source resolves', async (t) => {
  const gate = deferred(), f = fixture(t, { captureGate: gate }), proxy = f.client.create('registered'); await proxy.ready;
  const capture = proxy.capture(); capture.catch(() => {}); await tick(); await proxy.release();
  gate.resolve(); await assert.rejects(capture, /engine_unavailable/);
  assert.equal(f.responses.some((item) => item.result?.png), false); assert.equal(f.server.status().slots, 0);
});
test('property count and encoded byte size are bounded in addition to each scalar value', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  await assert.rejects(proxy.properties(Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['key' + i, true]))), /invalid_request/);
  await assert.rejects(proxy.properties(Object.fromEntries(Array.from({ length: 128 }, (_, i) => ['key' + i, 'x'.repeat(4096)]))), /invalid_request/);
  assert.equal(f.owners[0].writes, 0);
});
test('failed native release keeps its reservation and a later parent close can retry acknowledgement', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  const owner = f.owners[0], original = owner.release;
  owner.release = async () => { throw Error('native-cleanup-error-must-not-escape'); };
  await assert.rejects(proxy.release(), /engine_unavailable/); assert.equal(f.server.status().slots, 1);
  await assert.rejects(f.server.close()); assert.equal(f.server.status().closed, true); assert.equal(f.server.status().slots, 1);
  owner.release = original; await f.server.close(); assert.equal(owner.closed, true); assert.equal(f.server.status().slots, 0);
});
test('proxy release can retry a failed native cleanup without leaking its opaque reservation', async (t) => {
  const f = fixture(t), proxy = f.client.create('registered'); await proxy.ready;
  const owner = f.owners[0], release = owner.release.bind(owner); let first = true;
  owner.release = async () => { if (first) { first = false; throw Error('fixed'); } return release(); };
  await assert.rejects(proxy.release(), /engine_unavailable/); await proxy.release();
  assert.equal(proxy.status().resourcesClosed, true); assert.equal(f.server.status().slots, 0);
});
test('retry IPC accepts only a registered identity and never passes author URL, path or script', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.client.retry('registered'), /engine_unavailable/);
  assert.equal((await raw(f, { sequence: 2, op: 'retry', projectId: 'registered', path: 'forbidden' })).error, 'invalid_request');
  assert.equal(f.owners.length, 0);
});
