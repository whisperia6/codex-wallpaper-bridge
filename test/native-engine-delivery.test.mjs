import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeEngineDelivery } from '../bridge-runtime/src/native-engine-delivery.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const frame = (sequence) => ({ vp8: Uint8Array.of(48, 0, 0, 157, 1, 42, 32, 3, 194, 1, 0),
  width: 800, height: 450, sequence, timestamp: sequence * 100000 });
function fixture(options = {}) {
  const owners = [], calls = [];
  const provider = { async retry(id) { assert.ok(owners.filter((o) => o.id === id).every((o) => o.closed)); return { cleared: true }; }, create(id) {
    let sequence = 0;
    const owner = { id, closed: false, paused: false, releases: 0, captures: 0,
      ready: Promise.resolve(), async captureEncoded() { this.captures++; return frame(++sequence); },
      async pause() { this.paused = true; }, async resume() { this.paused = false; },
      async properties(values) { return { phase: 'ready', method: 'engine-readback', values: values ?? {} }; },
      async release() { this.closed = true; this.releases++; }, status() { return { resourcesClosed: this.closed }; } };
    owners.push(owner); return owner;
  } };
  const session = (id) => ({ engineTransportId: id, socket: { async call(method, params) {
    calls.push({ id, method, params });
    const [action, key, packet] = params.arguments.map((v) => v.value);
    if (action === 'accept') return { result: { value: { ok: true, sequence: packet.sequence } } };
    if (action === 'state') return { result: { value: { present: true, playing: true, volume: 0, pointer: [] } } };
    return { result: { value: { ok: true } } };
  } } });
  const delivery = new NativeEngineDelivery({ provider, intervalMs: 10, ...options });
  return { delivery, owners, calls, session };
}
test('one native owner captures for two private CDP receivers and the last lease releases it', async () => {
  const f = fixture(), a = f.delivery.prepare(f.session('a'), 'scene'), b = f.delivery.prepare(f.session('b'), 'scene');
  await a.ready; await b.ready;
  for (let attempt = 0; attempt < 50 && (!a.accepted || !b.accepted); attempt++) await tick();
  assert.equal(f.owners.length, 1);
  assert.ok(f.calls.some((c) => c.id === 'a' && c.params.arguments[0].value === 'accept'));
  assert.ok(f.calls.some((c) => c.id === 'b' && c.params.arguments[0].value === 'accept'));
  await a.release(); assert.equal(f.owners[0].closed, false);
  await b.release(); assert.equal(f.owners[0].closed, true);
  assert.equal(f.owners[0].releases, 1); await f.delivery.close();
  assert.deepEqual(f.delivery.status(), { closed: true, sources: 0, leases: 0 });
});

for (const stalledAction of ['state', 'accept']) {
  test(`VP8 skips a receiver with a pending ${stalledAction} while the healthy host keeps receiving frames`, async (t) => {
    const failures = [];
    const f = fixture({ onFailure: (value) => failures.push(value) });
    t.after(() => f.delivery.close());
    const slow = f.session('codex'), call = slow.socket.call;
    let rejectRequest, slowRequests = 0;
    slow.socket.call = async (method, params) => {
      if (params.arguments[0].value !== stalledAction) return call(method, params);
      slowRequests++;
      return new Promise((_, reject) => { rejectRequest = reject; });
    };
    const stalled = f.delivery.prepare(slow, 'scene');
    const healthy = f.delivery.prepare(f.session('antigravity'), 'scene');
    const sequences = () => f.calls.filter(({ id, params }) => id === 'antigravity' && params.arguments[0].value === 'accept')
      .map(({ params }) => params.arguments[2].value.sequence);
    for (let attempt = 0; attempt < 50 && (!rejectRequest || healthy.accepted < 4); attempt++) await tick();
    assert.equal(slowRequests, 1);
    assert.equal(stalled.closed, false);
    const framesWhileStalled = sequences();
    assert.ok(framesWhileStalled.length >= 4);
    assert.ok(framesWhileStalled.every((sequence, index) => !index || sequence > framesWhileStalled[index - 1]));
    rejectRequest(Error('CDP request timed out'));
    for (let attempt = 0; attempt < 50 && (!stalled.closed || healthy.accepted <= framesWhileStalled.length); attempt++) await tick();
    assert.equal(stalled.closed, true);
    assert.equal(healthy.closed, false);
    assert.ok(sequences().at(-1) > framesWhileStalled.at(-1));
    assert.equal(f.owners[0].closed, false);
    assert.deepEqual(failures.map(({ stage }) => stage), [stalledAction]);
  });
}

for (const message of ['Cannot find object with given id', 'Cannot find context with specified id']) {
  test(`a protocol-confirmed destroyed receiver before lifecycle notification cannot poison shared native source: ${message}`, async (t) => {
    let old;
    const failures = [], lost = [];
    const f = fixture({ onFailure: (value) => failures.push(value), onReceiverLost: (session) => {
      lost.push(session); void old.release();
    } });
    t.after(() => f.delivery.close());
    const retiring = f.session('retiring'), call = retiring.socket.call;
    retiring.socket.call = async (method, params) => params.arguments[0].value === 'accept'
      ? Promise.reject(Object.assign(Error(message), { cdpCode: -32000 })) : call(method, params);
    old = f.delivery.prepare(retiring, 'scene');
    const live = f.delivery.prepare(f.session('live'), 'scene'); await live.ready;
    await tick(); await tick(); await tick();
    assert.equal(lost.length, 1); assert.equal(lost[0], retiring); assert.equal(old.closed, true);
    assert.equal(failures.length, 0); assert.equal(f.owners[0].closed, false);
    assert.ok(live.accepted > 0);
    const fresh = f.delivery.prepare(f.session('fresh-context'), 'scene'); await fresh.ready;
    assert.equal(f.owners.length, 1); await fresh.release();
  });
}
for (const kind of ['decode', 'transport', 'state']) {
  test(`VP8 ${kind} failure retires only the failed host lease and preserves the shared owner`, async (t) => {
    const failures = [], lost = [];
    const f = fixture({ onFailure: (value) => failures.push(value), onReceiverLost: (session) => lost.push(session) });
    t.after(() => f.delivery.close());
    const session = f.session('codex'), call = session.socket.call;
    const notices = [];
    session.socket.call = async (method, params) => {
      const [action] = params.arguments.map(({ value }) => value);
      if (action === 'fail') notices.push(action);
      if (action === 'state' && kind === 'state') throw Error('CDP connection failed');
      if (action === 'accept' && kind === 'transport') throw Error('Cannot find object with given id');
      if (action === 'accept' && kind === 'decode') return { result: { value: { ok: false, reason: 'decode', failureStage: 'decode' } } };
      return call(method, params);
    };
    const broken = f.delivery.prepare(session, 'scene');
    const healthy = f.delivery.prepare(f.session('antigravity'), 'scene');
    await Promise.all([broken.ready, healthy.ready]);
    for (let attempt = 0; attempt < 50 && (!broken.closed || healthy.accepted < 2); attempt++) await tick();
    assert.equal(broken.closed, true);
    assert.ok(healthy.accepted >= 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, kind === 'decode' ? 'decode' : 'receiver-failed');
    assert.deepEqual(notices, ['fail']);
    assert.deepEqual(lost, []);
    assert.equal(f.owners.length, 1);
    assert.equal(f.owners[0].closed, false);
    assert.equal(f.delivery.hasSourceFailure('scene'), false);
    assert.equal(f.calls.some(({ id, params }) => id === 'antigravity' && params.arguments[0].value === 'fail'), false);
    const replacement = f.delivery.prepare(f.session('replacement'), 'scene');
    await replacement.ready;
    assert.equal(f.owners.length, 1);
    await replacement.release();
    await healthy.release();
    await broken.release();
    assert.equal(f.owners[0].releases, 1);
  });
}
test('a lease is bound to its original private receiver, never a later document handle', async (t) => {
  const f = fixture(); t.after(() => f.delivery.close());
  const session = f.session('old'), lease = f.delivery.prepare(session, 'scene');
  session.engineTransportId = 'new-document'; await lease.ready; await tick(); await tick();
  const receiverCalls = f.calls.filter((call) => call.params.arguments);
  assert.ok(receiverCalls.length); assert.ok(receiverCalls.every((call) => call.params.objectId === 'old'));
});
test('retired receiver rejection cannot poison the still-live receiver or cache a source failure', async (t) => {
  const failures = [], f = fixture({ onFailure: (value) => failures.push(value) }); t.after(() => f.delivery.close());
  const session = f.session('retiring'), call = session.socket.call;
  let rejectOld;
  session.socket.call = async (method, params) => params.arguments[0].value === 'accept'
    ? new Promise((_, reject) => { rejectOld = reject; }) : call(method, params);
  const old = f.delivery.prepare(session, 'scene'), live = f.delivery.prepare(f.session('live'), 'scene');
  await old.ready; await live.ready;
  for (let i = 0; i < 100 && !rejectOld; i++) await tick();
  assert.ok(rejectOld); await old.release(); rejectOld(Error('old_context_destroyed'));
  await tick(); await tick();
  assert.equal(failures.length, 0); assert.equal(f.owners[0].closed, false);
  assert.equal(f.delivery.diagnostics()[0].failed, false);
  assert.ok(live.accepted >= 2); await live.release();
  const fresh = f.delivery.prepare(f.session('fresh'), 'scene'); await fresh.ready;
});

test('receiver failure event survives source cleanup but never carries arbitrary receiver or author data', async (t) => {
  const failures = [], f = fixture({ onFailure: (value) => failures.push(value) }); t.after(() => f.delivery.close());
  const session = f.session('a'), call = session.socket.call;
  session.socket.call = async (method, params) => params.arguments[0].value === 'accept'
    ? { result: { value: { ok: false, reason: 'decode', failureStage: 'copy', failureKind: 'TypeError', path: 'private-author' } } } : call(method, params);
  const lease = f.delivery.prepare(session, 'scene'); await lease.ready; await tick(); await tick();
  assert.deepEqual(failures, [{ stage: 'accept', reason: 'decode', decodeStage: 'copy', decodeKind: 'TypeError' }]);
  assert.equal(f.owners[0].closed, true); assert.equal(lease.accepted, 0);
  assert.doesNotMatch(JSON.stringify(failures), /private|author/);
});
test('receiver decoder diagnostics are independently whitelisted before failure logging', async (t) => {
  const failures = [], f = fixture({ onFailure: (value) => failures.push(value) }); t.after(() => f.delivery.close());
  const session = f.session('a'), call = session.socket.call;
  session.socket.call = async (method, params) => params.arguments[0].value === 'accept'
    ? { result: { value: { ok: false, reason: 'decode', failureStage: 'output', failureKind: 'Unknown', diagnostic: {
      signal: 'timestamp-mismatch', decoderState: 'configured', queueSize: 0, outputs: 1, documentHidden: true,
      timestampMatched: false, dimensionsMatched: true, path: 'private-author', script: 'private-script',
    } } } } : call(method, params);
  await f.delivery.prepare(session, 'scene').ready; await tick(); await tick();
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].decodeDiagnostic, { signal: 'timestamp-mismatch', decoderState: 'configured', queueSize: 0,
    outputs: 1, documentHidden: true, timestampMatched: false, dimensionsMatched: true });
  assert.doesNotMatch(JSON.stringify(failures), /private|author|script/);
});
test('cancel interrupts a native ready wait and never delivers its late first frame', async () => {
  const f = fixture(); let resolve;
  f.delivery.close();
  const owner = { ready: new Promise((r) => { resolve = r; }), captures: 0,
    captureEncoded() { this.captures++; return frame(1); }, release: async () => {}, status: () => ({ resourcesClosed: true }) };
  const d = new NativeEngineDelivery({ provider: { create: () => owner }, intervalMs: 10 });
  const lease = d.prepare(f.session('a'), 'scene'); await lease.release(); resolve(); await tick();
  assert.equal(owner.captures, 0); assert.equal(f.calls.length, 0); await d.close();
});
test('closing reservations count toward capacity and failed release is retryable', async () => {
  const f = fixture(), a = f.delivery.prepare(f.session('a'), 'a'), b = f.delivery.prepare(f.session('b'), 'b');
  await a.ready; await b.ready;
  assert.throws(() => f.delivery.prepare(f.session('c'), 'c'), /capacity/);
  let first = true; const original = f.owners[0].release;
  f.owners[0].release = async function () { if (first) { first = false; throw Error('blocked'); } await original.call(this); };
  await assert.rejects(a.release(), /blocked/); assert.equal(f.delivery.status().sources, 2);
  await a.release(); await b.release(); await f.delivery.close();
});
test('only explicit retry clears failure after old leases and parent cache are released', async (t) => {
  const f = fixture(); t.after(() => f.delivery.close());
  const lease = f.delivery.prepare(f.session('a'), 'a'); await lease.ready;
  f.owners[0].captureEncoded = async () => { throw Error('failed'); };
  await tick(); await tick();
  assert.throws(() => f.delivery.prepare(f.session('b'), 'a'), /failed/);
  await f.delivery.retry('a'); assert.equal(lease.closed, true);
  const next = f.delivery.prepare(f.session('b'), 'a'); await next.ready;
  assert.equal(f.owners.length, 2); assert.equal(f.owners[0].closed, true);
  await assert.rejects(f.delivery.retry('a'), /not_failed/);
});
test('rejected or paused frame acknowledgements are never counted as decoded throughput', async (t) => {
  const f = fixture(); t.after(() => f.delivery.close());
  const session = f.session('a'), original = session.socket.call;
  session.socket.call = async (method, params) => params.arguments[0].value === 'accept'
    ? { result: { value: { ok: false, reason: 'paused' } } } : original(method, params);
  const lease = f.delivery.prepare(session, 'a'); await lease.ready; await tick(); await tick();
  assert.ok(f.delivery.diagnostics()[0].samples.length);
  assert.ok(f.delivery.diagnostics()[0].samples.every((sample) => sample.acknowledged === 0));
  assert.equal(lease.accepted, 0);
});
test('destroyed source is detected while paused without capturing or resuming it', async (t) => {
  const f = fixture(); t.after(() => f.delivery.close());
  const session = f.session('paused'), call = session.socket.call;
  session.socket.call = async (method, params) => params.arguments[0].value === 'state'
    ? { result: { value: { present: true, playing: false, pointer: [], volume: 0 } } } : call(method, params);
  const lease = f.delivery.prepare(session, 'a'); await lease.ready;
  for (let attempt = 0; attempt < 50 && !f.owners[0].paused; attempt++) await tick();
  const before = f.owners[0].captures; assert.equal(f.owners[0].paused, true);
  f.owners[0].health = async () => ({ closed: true, phase: 'failed' });
  await tick(); await tick();
  assert.equal(f.owners[0].captures, before);
  assert.equal(f.delivery.diagnostics()[0].failed, true);
  assert.ok(f.calls.some((c) => c.params.arguments[0].value === 'fail'));
});
test('decoded acknowledgements carry fresh control state, avoiding a redundant CDP round trip per playing frame', async (t) => {
  const f = fixture(); t.after(() => f.delivery.close());
  const session = f.session('cached'), call = session.socket.call;
  session.socket.call = async (method, params) => {
    const result = await call(method, params);
    if (params.arguments[0].value === 'accept') result.result.value.state = { present: true, playing: true, pointer: [], volume: 0 };
    return result;
  };
  const lease = f.delivery.prepare(session, 'a'); await lease.ready;
  for (let i = 0; i < 6; i++) await tick();
  const count = (action) => f.calls.filter((c) => c.params.arguments[0].value === action).length;
  assert.ok(count('accept') >= 3); assert.equal(count('state'), 1);
});
test('capture failure notifies private receivers, remembers failure, and preserves other source', async () => {
  const f = fixture(), a = f.delivery.prepare(f.session('a'), 'a'), b = f.delivery.prepare(f.session('b'), 'b');
  await a.ready; await b.ready;
  f.owners[0].captureEncoded = async () => { throw Error('author path must not be returned'); };
  await tick(); await tick();
  assert.ok(f.calls.some((c) => c.id === 'a' && c.params.arguments[0].value === 'fail'));
  assert.equal(f.owners[1].closed, false);
  assert.throws(() => f.delivery.prepare(f.session('c'), 'a'), /failed/);
  await a.release(); await b.release(); await f.delivery.close();
});
