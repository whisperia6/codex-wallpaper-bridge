import { randomBytes } from 'node:crypto';
import { validateEngineVp8Frame } from '../bridge-runtime/src/engine-vp8-frame.mjs';

const CHANNEL = 'cwb-engine-provider-v1';
const MAX_FRAME_BYTES = 2 * 1024 ** 2;
const ERRORS = new Set(['invalid_request', 'stale_request', 'provider_busy', 'provider_capacity',
  'unregistered_project', 'unknown_engine', 'engine_unavailable', 'provider_closed', 'invalid_native_frame', 'endpoint_unverified']);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const projectId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const handleId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const failure = (code) => Object.assign(Error(code), { providerCode: code });

function validValues(values) {
  if (!record(values) || Object.keys(values).length > 256) return false;
  for (const [key, value] of Object.entries(values)) {
    if (!key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
    if (typeof value === 'number' ? !Number.isFinite(value)
      : typeof value !== 'boolean' && (typeof value !== 'string' || value.length > 4096)) return false;
  }
  return Buffer.byteLength(JSON.stringify(values)) <= 128 * 1024;
}
function validRequest(request) {
  if (!record(request) || request.channel !== CHANNEL || !Number.isSafeInteger(request.sequence) || request.sequence < 1) return false;
  let keys = ['channel', 'sequence', 'op'];
  if (request.op === 'verify-endpoint') {
    keys.push('port');
    if (!Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) return false;
    if (Object.hasOwn(request, 'hostType')) {
      keys.push('hostType');
      if (!['codex', 'antigravity'].includes(request.hostType)) return false;
    }
    if (Object.hasOwn(request, 'purpose')) {
      keys.push('purpose');
      if (request.purpose !== 'restore' || !request.hostType) return false;
    }
  }
  else if (['create', 'retry'].includes(request.op)) { keys.push('projectId'); if (!projectId(request.projectId)) return false; }
  else if (['ready', 'capture', 'capture-vp8', 'pause', 'resume', 'properties', 'release', 'pointer', 'volume'].includes(request.op)) {
    keys.push('handle'); if (!handleId(request.handle)) return false;
    if (request.op === 'properties') { keys.push('values'); if (request.values !== null && !validValues(request.values)) return false; }
    if (request.op === 'volume') { keys.push('value'); if (typeof request.value !== 'number' || !Number.isFinite(request.value) || request.value < 0 || request.value > 1) return false; }
    if (request.op === 'pointer') {
      keys.push('value'); const input = request.value;
      if (!record(input) || Object.keys(input).length !== 4 || !['u', 'v', 'buttons', 'mods'].every((key) => Object.hasOwn(input, key))
        || ![input.u, input.v].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
        || ![0, 1].includes(input.buttons) || !Number.isInteger(input.mods) || input.mods < 0 || input.mods > 15) return false;
    }
  } else if (request.op !== 'close') return false;
  return Object.keys(request).length === keys.length && Object.keys(request).every((key) => keys.includes(key));
}
function safeStatus(owner) {
  const state = owner.status();
  return { phase: ['loading', 'ready', 'failed', 'released'].includes(state.phase) ? state.phase : 'loading',
    reason: typeof state.reason === 'string' && /^[a-z_]{1,64}$/.test(state.reason) ? state.reason : null,
    actualFrame: state.actualFrame === true, closed: state.closed === true, paused: state.paused === true,
    resourcesClosed: state.resourcesClosed === true };
}
function nativeFrame(frame) {
  const bytes = frame?.png;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > MAX_FRAME_BYTES
    || frame.width !== 800 || frame.height !== 450 || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1) throw failure('invalid_native_frame');
  const png = Buffer.from(bytes);
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png.readUInt32BE(8) !== 13
    || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== 800 || png.readUInt32BE(20) !== 450) throw failure('invalid_native_frame');
  return { png, width: 800, height: 450, sequence: frame.sequence };
}

/** Bind ONLY the already-owned Electron UtilityProcess object, never ipcMain,
 * author webContents, a network endpoint or a window postMessage listener.
 * The registry/config/properties resolver stays in the trusted parent.
 * This is a bounded resource transport, not a second media-switch state machine.
 */
export function serveEngineProvider({ peer, resolveProject, createOwner, retryProject = null, verifyEndpoint = null, onClosing = () => {} }) {
  if (!peer?.on || !peer.removeListener || !peer.postMessage || typeof resolveProject !== 'function' || typeof createOwner !== 'function') throw TypeError('invalid native provider');
  const entries = new Map(); let closed = false, closing = null, sequence = 0, flights = 0;
  const send = (request, payload) => {
    if (closed) return;
    try { peer.postMessage({ channel: CHANNEL, sequence: request.sequence, ...payload }); } catch { void close(); }
  };
  const release = async (handle, entry) => {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    entry.closing = (async () => {
      await entry.owner?.release();
      if (entry.owner && entry.owner.status().resourcesClosed !== true) throw failure('engine_unavailable');
      entries.delete(handle); return { resourcesClosed: true };
    })();
    entry.closing.catch(() => { entry.closing = null; });
    return entry.closing;
  };
  async function operation(request) {
    if (request.op === 'retry') {
      if (typeof retryProject !== 'function') throw failure('engine_unavailable');
      const result = await retryProject(request.projectId);
      if (closed || result?.cleared !== true) throw failure('engine_unavailable');
      return { cleared: true };
    }
    if (request.op === 'verify-endpoint') {
      try { if (typeof verifyEndpoint !== 'function' || (await verifyEndpoint(request.port, request.hostType, request.purpose))?.verified !== true || closed) throw Error(); }
      catch { throw failure('endpoint_unverified'); }
      return { verified: true };
    }
    if (request.op === 'create') {
      if (entries.size >= 2) throw failure('provider_capacity');
      const handle = randomBytes(16).toString('hex'), entry = { owner: null, closed: false, busy: false };
      // Reserve before any registry await. Closing/initializing resources count too.
      entries.set(handle, entry);
      try {
        const snapshot = await resolveProject(request.projectId);
        if (closed || entry.closed) throw failure('provider_closed');
        if (!snapshot || snapshot.project?.id !== request.projectId || !['scene', 'web'].includes(snapshot.project?.type)) throw failure('unregistered_project');
        entry.owner = createOwner(structuredClone(snapshot));
        if (!entry.owner?.ready?.then || !entry.owner.release || !entry.owner.capture || !entry.owner.status) throw failure('engine_unavailable');
        entry.owner.ready.catch(() => {});
        return { handle };
      } catch (error) { await release(handle, entry); throw error; }
    }
    const entry = entries.get(request.handle);
    if (!entry?.owner) throw failure('unknown_engine');
    // Release interrupts a pending first-frame wait instead of queueing behind it.
    if (request.op === 'release') return release(request.handle, entry);
    if (entry.closed) throw failure('unknown_engine');
    if (entry.busy) throw failure('provider_busy');
    entry.busy = true;
    try {
      await entry.owner.ready; if (closed || entry.closed) throw failure('engine_unavailable');
      if (request.op === 'ready') return safeStatus(entry.owner);
      if (request.op === 'capture') {
        const frame = await entry.owner.capture(); if (closed || entry.closed) throw failure('engine_unavailable');
        return nativeFrame(frame);
      }
      if (request.op === 'capture-vp8') {
        const frame = await entry.owner.captureEncoded(); if (closed || entry.closed) throw failure('engine_unavailable');
        try { return validateEngineVp8Frame(frame); } catch { throw failure('invalid_native_frame'); }
      }
      if (request.op === 'properties') {
        const result = await entry.owner.properties(request.values); if (closed || entry.closed) throw failure('engine_unavailable');
        if (!record(result) || !validValues(result.values) || !['ready', 'unsupported', 'unavailable'].includes(result.phase)
          || !['engine-readback', 'author-delivery', 'none'].includes(result.method)) throw failure('engine_unavailable');
        return { phase: result.phase, method: result.method, values: structuredClone(result.values) };
      }
      if (['pointer', 'volume'].includes(request.op)) {
        await entry.owner[request.op](request.value); if (closed || entry.closed) throw failure('engine_unavailable');
        return safeStatus(entry.owner);
      }
      await entry.owner[request.op](); if (closed || entry.closed) throw failure('engine_unavailable');
      return safeStatus(entry.owner);
    } finally { entry.busy = false; }
  }
  function receive(request) {
    if (closed || request?.channel !== CHANNEL) return;
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) return;
    if (request.sequence <= sequence) { send(request, { ok: false, error: 'stale_request' }); return; }
    sequence = request.sequence;
    if (!validRequest(request)) { send(request, { ok: false, error: 'invalid_request' }); return; }
    if (request.op === 'close') { void close(); return; }
    // Four ordinary flights plus at most two emergency cleanup flights. Even a
    // malformed trusted peer cannot build an unbounded release promise queue.
    if (flights >= 6 || (flights >= 4 && request.op !== 'release')) { send(request, { ok: false, error: 'provider_busy' }); return; }
    flights++;
    void operation(request).then((result) => send(request, { ok: true, result }),
      (error) => send(request, { ok: false, error: ERRORS.has(error.providerCode) ? error.providerCode : 'engine_unavailable' }))
      .finally(() => { flights--; });
  }
  function close() {
    if (closing) return closing;
    const wasClosed = closed;
    closed = true; peer.removeListener('message', receive); peer.removeListener('exit', onExit);
    if (!wasClosed) { try { onClosing(); } catch {} }
    closing = Promise.all([...entries].map(([handle, entry]) => release(handle, entry))).then(() => {});
    closing.catch(() => { closing = null; }); return closing;
  }
  const onExit = () => { void close(); };
  peer.on('message', receive); peer.on('exit', onExit);
  return { close, status: () => ({ closed, slots: entries.size, flights }) };
}

/** Node-side client used only inside the owned utility. Nothing is exposed to
 * the author or desktop renderer. Actual native pixels are captured in parent.
 */
export function createEngineProviderClient({ port, timeoutMs = 60000 }) {
  if (!port?.on || !port.removeListener || !port.postMessage || !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000) throw TypeError('invalid native provider client');
  const pending = new Map(); let closed = false, sequence = 0;
  function seal(error) {
    if (closed) return;
    closed = true; port.removeListener('message', receive);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }
  function close(error = failure('provider_closed')) {
    if (closed) return;
    try { port.postMessage({ channel: CHANNEL, sequence: ++sequence, op: 'close' }); } catch {}
    seal(error);
  }
  function receive({ data } = {}) {
    if (closed || data?.channel !== CHANNEL || !Number.isSafeInteger(data.sequence)) return;
    const waiter = pending.get(data.sequence); if (!waiter) return;
    if (!record(data) || typeof data.ok !== 'boolean' || (data.ok === false && !ERRORS.has(data.error))) { close(failure('invalid_response')); return; }
    clearTimeout(waiter.timer); pending.delete(data.sequence);
    if (data.ok) waiter.resolve(data.result); else waiter.reject(failure(data.error));
  }
  function request(op, extra = {}) {
    if (closed) return Promise.reject(failure('provider_closed'));
    if (pending.size >= 4) return Promise.reject(failure('provider_busy'));
    const message = { channel: CHANNEL, sequence: ++sequence, op, ...extra };
    if (!validRequest(message)) return Promise.reject(failure('invalid_request'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(failure('provider_timeout')), timeoutMs);
      pending.set(message.sequence, { resolve, reject, timer });
      try { port.postMessage(message); } catch { close(failure('provider_closed')); }
    });
  }
  function create(id) {
    let handle, cancelled = false, released;
    let state = { phase: 'loading', closed: false, resourcesClosed: false };
    const created = request('create', { projectId: id }).then((result) => {
      if (!handleId(result?.handle)) { close(failure('invalid_response')); throw failure('invalid_response'); }
      handle = result.handle; return handle;
    });
    const control = async (op, extra) => { await proxy.ready; const result = await request(op, { handle, ...extra }); return result; };
    const proxy = {
      ready: created.then(async () => {
        if (cancelled) throw failure('engine_cancelled');
        state = await request('ready', { handle });
        if (cancelled || closed) throw failure('engine_cancelled'); return proxy;
      }),
      capture: async () => nativeFrame(await control('capture')),
      captureEncoded: async () => validateEngineVp8Frame(await control('capture-vp8')),
      health: async () => { state = await control('ready'); return { ...state }; },
      pause: async () => { state = await control('pause'); }, resume: async () => { state = await control('resume'); },
      properties: (values = null) => control('properties', { values }),
      pointer: (value) => control('pointer', { value }), volume: (value) => control('volume', { value }),
      release() {
        if (released) return released;
        cancelled = true;
        // Do not await proxy.ready: it can be waiting for the first native frame.
        released = created.then(() => request('release', { handle })).then(() => { state = { phase: 'released', closed: true, resourcesClosed: true }; });
        released.catch(() => { released = null; }); return released;
      },
      status: () => ({ ...state, closed: state.closed || closed || cancelled }),
    };
    proxy.ready.catch(() => {}); return proxy;
  }
  port.on('message', receive);
  return { create, close,
    retry: (projectId) => request('retry', { projectId }),
    async verifyEndpoint(port, hostType, purpose) {
      const result = await request('verify-endpoint', { port, ...(hostType === undefined ? {} : { hostType }), ...(purpose === undefined ? {} : { purpose }) });
      if (result?.verified !== true) throw failure('endpoint_unverified');
      return result;
    },
    status: () => ({ closed, pending: pending.size }) };
}
