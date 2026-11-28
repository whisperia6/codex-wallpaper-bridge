/** Serialized into the verified Codex top document. This only manages Scene
 * resources inside M1 slots; it is not another selection/switch state machine.
 * Descriptors arrive through a private CDP handle, never a control HTTP API.
 */
import { resolvePlayback } from './playback-policy.mjs';
export function createDirectSceneTransport(createSceneSlot, readback, validate, validateInput, playback = resolvePlayback) {
  const records = new Map(), live = new Set(), retryKeys = new Set();
  let closed = false, used = false;
  const capability = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  function register(descriptor) {
    if (closed || !identity(descriptor?.key) || !capability(descriptor?.handle) || records.has(descriptor.handle)) return false;
    records.set(descriptor.handle, { descriptor, slot: null, released: false, commands: [], pending: new Map() });
    return true;
  }
  function create({ wallpaper, effects, initial = false }) {
    if (closed || live.size >= 2) throw Error('gpu_slot_capacity');
    const record = [...records.values()].find((value) => value.descriptor.key === wallpaper.id && !value.slot && !value.released);
    if (!record) throw Error('gpu_descriptor_unavailable');
    used = true; retryKeys.delete(wallpaper.id);
    const { descriptor } = record;
    const node = document.createElement('div'), frame = document.createElement('iframe'), label = document.createElement('div');
    node.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0';
    node.dataset.cwbRenderer = 'direct-gpu';
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none';
    frame.title = descriptor.type === 'web' ? 'Codex GPU Web' : 'Codex GPU Scene'; frame.allow = 'autoplay';
    const poster = initial && descriptor.type === 'scene' && wallpaper.previewUrl ? document.createElement('img') : null;
    if (poster) {
      poster.alt = ''; poster.referrerPolicy = 'no-referrer'; poster.src = wallpaper.previewUrl;
      poster.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:var(--cwb-fit,cover);object-position:var(--cwb-position,50% 50%)';
      node.append(poster); node.style.removeProperty('opacity');
    }
    label.hidden = true;
    label.style.cssText = 'position:absolute;bottom:8px;left:8px;color:#ffe08a;background:#211b09;font:12px sans-serif;padding:4px';
    node.append(frame, label);
    let currentEffects = effects, failed = false, committed = false, prepared = false, retryRequested = false;
    const api = async (_route, options) => {
      const request = JSON.parse(options.body);
      if (request.op === 'open' && request.id === descriptor.key && !record.released) return descriptor;
      if (request.op === 'close' && request.handle === descriptor.handle) { record.released = true; return { ok: true }; }
      if (request.op === 'renew' && request.handle === descriptor.handle && !record.released) return { ok: true };
      throw Error('gpu_lease_closed');
    };
    const scene = createSceneSlot({ node: frame, poster, project: { id: wallpaper.id, type: descriptor.type || 'scene' }, client: descriptor.handle, api,
      getEffects: () => currentEffects, window: globalThis, readback, validate, validateInput, playback, preserveOnFailure: true,
      onMediaControl: value => new Promise((resolve, reject) => {
        if (record.released || record.pending.size >= 4) { reject(Error('media_control_unavailable')); return; }
        const timer = setTimeout(() => { record.pending.delete(value.requestId); reject(Error('media_control_timeout')); }, 5000);
        record.pending.set(value.requestId, { resolve, reject, timer }); record.commands.push(value);
      }),
      onStatus(status) {
        node.dataset.cwbScenePhase = status.phase;
        if (status.phase === 'prepared' || status.phase === 'ready') prepared = true;
        if (status.phase === 'failed') {
          failed = true; label.hidden = false;
          label.textContent = 'GPU 场景已停止；请重试或切换壁纸';
        }
      } });
    const slot = {
      node, ready: scene.ready,
      update(value) {
        currentEffects = value.effects;
        frame.style.transform = 'scale(' + ((currentEffects.zoom ?? 100) / 100) + ') scaleX(' + (currentEffects.mirror ? -1 : 1) + ')';
        frame.style.transformOrigin = currentEffects.position || '50% 50%';
        if (poster) {
          poster.style.transform = frame.style.transform;
          poster.style.transformOrigin = frame.style.transformOrigin;
        }
        scene.update();
      },
      activate() {
        if (failed || record.released) throw Error('gpu_source_failed');
        committed = true; node.style.removeProperty('opacity'); scene.activate();
      },
      retire() { committed = false; scene.retire(); },
      release() {
        record.released = true; committed = false; live.delete(slot);
        for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('media_control_unavailable')); }
        record.pending.clear(); record.commands.length = 0;
        void scene.release().catch(() => {}); node.remove();
      },
      snapshot: () => ({ present: !record.released, released: record.released, detached: !record.released && node.isConnected === false,
        failed, committed, prepared, retryRequested,
        renderer: 'direct-gpu', ...(scene.stats() || {}) }),
      retry: () => { retryRequested = true; },
      properties: (schema, values) => scene.authorProperties(schema, values),
      setProperties: (values) => scene.properties(values),
      input: (value) => scene.input(value),
    };
    record.slot = slot; live.add(slot); slot.update({ effects });
    return slot;
  }
  return {
    create, register, used: () => used,
    key(handle) { const record = records.get(handle); return record && !record.released ? record.descriptor.key : null; },
    configure(handle, properties) {
      const record = records.get(handle);
      if (!record || record.released) return false;
      record.descriptor.properties = properties;
      record.slot?.setProperties(properties);
      return true;
    },
    state(handle) {
      const record = records.get(handle);
      const state = record?.slot?.snapshot();
      return state ? { ...state, mediaControls: record.commands.splice(0, 4) } : { present: false, released: !record || record.released, failed: false };
    },
    mediaControlResult(handle, value) {
      const record = records.get(handle), pending = record?.pending.get(value?.requestId);
      if (!pending || record.released) return false;
      record.pending.delete(value.requestId); clearTimeout(pending.timer); pending.resolve({ ok: value.ok === true }); return true;
    },
    retryRequested: (key) => retryKeys.has(key),
    retry(key) { retryKeys.add(key); for (const record of records.values()) if (record.descriptor.key === key) record.slot?.retry(); return true; },
    forget(handle) {
      const record = records.get(handle);
      if (record?.slot && !record.slot.snapshot().committed) record.slot.release();
      records.delete(handle); return true;
    },
    async properties(handle, { schema, values = null }) {
      const record = records.get(handle);
      if (!record?.slot || record.released) return { phase: 'unavailable', method: 'none', values: {} };
      return record.slot.properties(schema, values);
    },
    input(handle, value) {
      const record = records.get(handle);
      return !closed && !record?.released && record?.slot?.input(value) === true;
    },
    close() { closed = true; for (const slot of [...live]) slot.release(); records.clear(); retryKeys.clear(); return true; },
  };
}
