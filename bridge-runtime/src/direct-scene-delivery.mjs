import { randomBytes } from 'node:crypto';
import { createReadonlyWallpaperServer as createSceneServer, prewarmSceneAssets } from './scene-server.mjs';
import { readAuthorProperties, validateAuthorPropertyPatch } from './author-properties.mjs';
import { effectiveAuthorFileProperties } from './author-property-state.mjs';
import { validateWebWallpaperInput } from './web-wallpaper-input.mjs';

/** Trusted resource control for GPU-direct Scene iframes. The same readonly
 * service/quality settings and slot adapter serve the workbench and Codex.
 * No pixel capture, VP8 encoder, decoder or per-frame CDP pump is used here.
 * Servers are shared across verified targets; M1 owns when each slot retires.
 */
export class DirectSceneDelivery {
  #getProject; #getConfig; #sources = new Map(); #failures = new Set();
  #closed = false; #timer; #polling = null; #onReceiverLost; #onPreloadReady;
  #warming = new Map();
  #diagnosticProbe;
  #authorFiles;
  #onMediaControl;
  constructor({ getProject, getConfig, onReceiverLost = () => {}, onPreloadReady = () => {}, diagnosticProbe = false, authorFiles = null, onMediaControl = null }) {
    if (typeof getProject !== 'function' || typeof getConfig !== 'function') throw TypeError('gpu_provider_invalid');
    if (typeof diagnosticProbe !== 'boolean') throw TypeError('gpu_diagnostic_invalid');
    this.#diagnosticProbe = diagnosticProbe;
    this.#authorFiles = authorFiles;
    this.#getProject = getProject; this.#getConfig = getConfig;
    this.#onReceiverLost = onReceiverLost;
    this.#onPreloadReady = onPreloadReady;
    this.#onMediaControl = onMediaControl;
    // Lease/health polling only, at 1 Hz, independent of the renderer's FPS.
    this.#timer = setInterval(() => { void this.sweep().catch(() => {}); }, 1000); this.#timer.unref?.();
  }
  #call(lease, action, value = null, timeoutMs = 6000) {
    return lease.session.socket.call('Runtime.callFunctionOn', { objectId: lease.receiverId,
      functionDeclaration: 'function(action,handle,value){return this[action](handle,value)}',
      arguments: [{ value: action }, { value: lease.handle }, { value }], awaitPromise: true, returnByValue: true }, timeoutMs)
      .then((result) => { if (result.exceptionDetails) throw Error('gpu_receiver_lost'); return result.result?.value; });
  }
  #rememberFailure(key) {
    this.#failures.add(key);
    if (this.#failures.size > 128) this.#failures.delete(this.#failures.values().next().value);
  }
  async #start(entry) {
    const [project, config] = await Promise.all([this.#getProject(entry.key), this.#getConfig()]);
    if (this.#closed || entry.closed) throw Error('gpu_lease_cancelled');
    if (!project || !['scene', 'web'].includes(project.type) || project.eligible === false || project.hidden) throw Error('gpu_project_unavailable');
    const parentOrigin = entry.parentOrigin || 'app://-';
    entry.server = createSceneServer({
      project,
      config,
      parentOrigin,
      allowHttpsLoopback: parentOrigin.startsWith('https://127.0.0.1:'),
      frameRate: 60,
      nativeQuality: true,
      diagnosticProbe: this.#diagnosticProbe,
      authorFiles: this.#authorFiles,
    });
    entry.rootPath = project.rootPath;
    entry.type = project.type;
    await entry.server.start();
    if (this.#closed || entry.closed) throw Error('gpu_lease_cancelled');
    entry.schema = entry.server.authorProperties.schema;
    return entry.server;
  }
  warm(key) {
    if (this.#closed || typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)) return Promise.resolve(false);
    if (this.#warming.has(key)) return this.#warming.get(key);
    if (this.#warming.size >= 2) return Promise.resolve(false);
    const pending = (async () => {
      const [project, config] = await Promise.all([this.#getProject(key), this.#getConfig()]);
      return prewarmSceneAssets({ project, config, cancelled: () => this.#closed });
    })().catch(() => false).finally(() => this.#warming.delete(key));
    this.#warming.set(key, pending);
    return pending;
  }
  async prepare(session, key, { speculative = false } = {}) {
    if (this.#closed || !session.sceneTransportId || typeof key !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)) throw Error('gpu_lease_invalid');
    if (this.#failures.has(key)) throw Error('gpu_source_failed');
    await this.sweep();
    if (this.#closed) throw Error('gpu_delivery_closed');
    if (!session.sceneTransportId) throw Error('gpu_receiver_lost');
    if (this.#failures.has(key)) throw Error('gpu_source_failed');
    const parentOrigin = session.targetOrigin || 'app://-';
    let entry = this.#sources.get(key);
    if (entry && !entry.closed && entry.parentOrigin !== parentOrigin) {
      await Promise.all([...entry.leases].map((lease) => this.#release(lease)));
      await entry.closing;
      entry = this.#sources.get(key);
    }
    if (entry?.closed) throw Error('gpu_source_closing');
    if (!entry) {
      // Finish only already committed transitions before reserving a third
      // resource. Candidates still use the unchanged M1 ready/commit gate.
      if (this.#sources.size >= 2) {
        // Preloading is optional and must not cut short a user transition.
        if (speculative) throw Error('gpu_source_capacity');
        const receivers = new Map([...this.#sources.values()].flatMap((source) => [...source.leases])
          .filter((lease) => !lease.closed && lease.registered).map((lease) => [lease.session, lease]));
        await Promise.all([...receivers.values()].map((lease) => this.#call(lease, 'finishTransition')));
        await this.#polling;
        await this.sweep();
      }
      if (this.#sources.size >= 2) throw Error('gpu_source_capacity');
      entry = { key, parentOrigin, server: null, schema: {}, leases: new Set(), closed: false, closing: null };
      this.#sources.set(key, entry);
      entry.starting = this.#start(entry);
      entry.starting.catch(() => {});
    }
    const lease = { key, entry, session, receiverId: session.sceneTransportId, handle: randomBytes(16).toString('hex'),
      closed: false, registered: false, retiring: false, closing: null, snapshot: null,
      speculative, expires: speculative ? Date.now() + 120000 : null, startedAt: Date.now(), readyReported: false };
    entry.leases.add(lease); session.sceneLeases ||= new Set(); session.sceneLeases.add(lease);
    lease.release = () => this.#release(lease);
    lease.retire = () => { lease.retiring = true; };
    try {
      const server = await entry.starting;
      const config = await this.#getConfig();
      if (this.#closed || lease.closed) throw Error('gpu_lease_cancelled');
      const { values: properties } = await effectiveAuthorFileProperties(server.authorProperties, config.authorProperties?.[key], { projectId: key, authorFiles: this.#authorFiles });
      if (this.#closed || lease.closed) throw Error('gpu_lease_cancelled');
      const descriptor = { key, type: entry.type, handle: lease.handle, origin: server.origin, url: server.rendererUrl, resourceBase: server.resourceBase, channel: server.channel,
        fps: 60, firstFrameTimeoutMs: server.firstFrameTimeoutMs,
        properties };
      const result = await session.socket.call('Runtime.callFunctionOn', { objectId: lease.receiverId,
        functionDeclaration: 'function(descriptor){return this.register(descriptor)}', arguments: [{ value: descriptor }], returnByValue: true });
      if (result.exceptionDetails || result.result?.value !== true) throw Error('gpu_descriptor_rejected');
      if (this.#closed || lease.closed) throw Error('gpu_lease_cancelled');
      lease.registered = true;
      return lease;
    } catch (error) {
      const contentFailure = ['gpu_project_unavailable', 'scene project root is unavailable',
        'scene manifest is unavailable', 'scene manifest is invalid', 'scene_manifest', 'scene_resource'].includes(error.message);
      if (!speculative && !lease.closed && !entry.closed && contentFailure) this.#rememberFailure(key);
      await lease.release(); throw error;
    }
  }
  async promote(lease) {
    if (lease.closed || !lease.speculative || lease.expires <= Date.now()) return false;
    const [project, config] = await Promise.all([this.#getProject(lease.key), this.#getConfig()]);
    if (!project || project.type !== lease.entry.type || project.eligible === false || project.hidden
      || project.rootPath !== lease.entry.rootPath || !await lease.entry.server.isCurrent()) return false;
    const { values: properties } = await effectiveAuthorFileProperties(lease.entry.server.authorProperties, config.authorProperties?.[lease.key], { projectId: lease.key, authorFiles: this.#authorFiles });
    if (this.#closed || lease.closed) return false;
    if (lease.closed || this.#closed || lease.expires <= Date.now()) return false;
    const state = await this.#call(lease, 'state');
    if (!state?.present || state.failed || state.released || lease.closed) return false;
    lease.snapshot = state;
    const accepted = await this.#call(lease, 'configure', properties);
    if (accepted !== true || lease.closed) return false;
    lease.speculative = false; lease.expires = null;
    return true;
  }
  sweep() {
    if (this.#polling) return this.#polling;
    this.#polling = (async () => {
      const leases = [...this.#sources.values()].flatMap((entry) => [...entry.leases]).filter((lease) => !lease.closed && lease.registered);
      await Promise.all(leases.map(async (lease) => {
        if (lease.speculative && lease.expires <= Date.now()) {
          await this.#call(lease, 'cancelPreload', lease.key).catch(() => {});
          await this.#release(lease); return;
        }
        let state;
        try { state = await this.#call(lease, 'state'); }
        catch (error) {
          // Disposal during navigation/disconnect is not a Scene content failure.
          if (lease.closed || lease.session.socket.closed || (error.cdpCode === -32000
            && ['Cannot find object with given id', 'Cannot find context with specified id'].includes(error.message))) {
            if (!lease.closed && !lease.session.socket.closed) { try { this.#onReceiverLost(lease.session); } catch {} }
            await this.#release(lease); return;
          }
          return;
        }
        if (lease.closed) return;
        lease.snapshot = state;
        if (Array.isArray(state?.mediaControls) && state.mediaControls.length <= 4 && !lease.speculative && !lease.retiring && state.committed) {
          for (const control of state.mediaControls) {
            if (!Number.isSafeInteger(control?.requestId) || control.requestId <= 0) continue;
            let ok = false;
            try {
              if (this.#onMediaControl && !lease.closed && !this.#closed) ok = (await this.#onMediaControl(lease.key,
                { command: control.command, sessionId: control.sessionId }))?.ok === true;
            } catch {}
            if (!lease.closed && !this.#closed) await this.#call(lease, 'mediaControlResult', { requestId: control.requestId, ok }, 2000).catch(() => {});
          }
        }
        if (lease.speculative && state?.prepared && !state.failed && !state.released && !lease.readyReported) {
          lease.readyReported = true;
          try { this.#onPreloadReady(Date.now() - lease.startedAt); } catch {}
        }
        if (state?.detached && !lease.retiring) {
          try { this.#onReceiverLost(lease.session); } catch {}
          await this.#release(lease); return;
        }
        if (state?.failed && !lease.speculative) this.#rememberFailure(lease.key);
        if (state?.released) await this.#release(lease);
      }));
    })().finally(() => { this.#polling = null; });
    return this.#polling;
  }
  fail(lease) { if (!lease.closed && this.#sources.get(lease.key) === lease.entry) this.#rememberFailure(lease.key); }
  #release(lease) {
    if (lease.closing) return lease.closing;
    lease.closed = true;
    const entry = lease.entry;
    entry.leases.delete(lease); lease.session.sceneLeases?.delete(lease);
    if (!entry.leases.size) entry.closed = true;
    lease.closing = (async () => {
      await this.#call(lease, 'forget').catch(() => {});
      if (entry.closed) {
        entry.closing ||= (async () => {
          await entry.starting.catch(() => {}); await entry.server?.close();
          if (this.#sources.get(entry.key) === entry) this.#sources.delete(entry.key);
        })().catch((error) => { entry.closing = null; throw error; });
        await entry.closing;
      }
    })().catch((error) => { lease.closing = null; throw error; });
    return lease.closing;
  }
  async properties(key, values = null) {
    const entry = this.#sources.get(key);
    if (!entry || entry.closed || this.#closed) return { phase: 'unavailable', method: 'none', values: {} };
    const results = await Promise.all([...entry.leases].filter((lease) => !lease.closed && !lease.retiring && !lease.speculative).map(async (lease) => {
      try {
        const result = await this.#call(lease, 'properties', { schema: entry.schema, values }, 4000);
        const actual = readAuthorProperties(entry.schema, result?.values, validateAuthorPropertyPatch);
        const available = Object.keys(entry.schema).length === 0 || Object.keys(actual.values).length > 0;
        const matchesWrite = values === null || Object.entries(values).every(([key, value]) => Object.hasOwn(actual.values, key) && actual.values[key] === value);
        const ready = !this.#closed && !lease.closed && result?.phase === 'ready' && available && matchesWrite;
        return { phase: ready ? 'ready' : 'unavailable', method: ready ? entry.type === 'web' ? 'author-delivery' : 'engine-readback' : 'none', source: 'codex-gpu', ...actual };
      } catch { return { phase: 'failed', method: 'none', values: {} }; }
    }));
    if (!results.length) return { phase: 'unavailable', method: 'none', values: {} };
    const problem = results.find((result) => result.phase !== 'ready');
    if (problem) return problem;
    // A success from one window cannot hide a failed/stale second window.
    if (results.some((result) => JSON.stringify(result.values) !== JSON.stringify(results[0].values))) {
      return { phase: 'unavailable', method: 'none', source: 'codex-gpu', values: {} };
    }
    return results[0];
  }
  async input(key, value) {
    const input = validateWebWallpaperInput(value);
    const entry = this.#sources.get(key), config = await this.#getConfig();
    if (this.#closed || !entry || entry.closed || (entry.type !== 'web' && input.op !== 'audio') || config.effects?.playing === false
      || config.selectedId !== key) return { ok: true, status: 'unavailable', delivered: 0 };
    const leases = [...entry.leases].filter(lease => !lease.closed && lease.registered && !lease.retiring && !lease.speculative);
    if (leases.length > 16) throw Error('web_input_capacity');
    const fingerprint = JSON.stringify(input);
    const results = await Promise.all(leases.map(async lease => {
      lease.mediaInputs ||= new Map();
      if (input.op !== 'audio' && lease.mediaInputs.get(input.op) === fingerprint) return 'unchanged';
      try {
        const delivered = await this.#call(lease, 'input', input, 3000) === true && !lease.closed && !this.#closed;
        if (delivered) {
          // Disabling clears all media fields inside the Web shim. Their old
          // fingerprints must not suppress a same-track replay on re-enable.
          if (input.op === 'mediaStatus' && !input.value.enabled) lease.mediaInputs.clear();
          lease.mediaInputs.set(input.op, fingerprint);
        }
        return delivered;
      }
      catch { return false; }
    }));
    const delivered = results.filter(value => value === true).length;
    return { ok: true, status: delivered ? 'dispatched' : results.includes('unchanged') ? 'unchanged' : 'unavailable', delivered };
  }
  async retry(key) {
    await this.sweep();
    if (this.#closed || !this.#failures.has(key)) throw Error('gpu_source_not_failed');
    const entry = this.#sources.get(key);
    if (entry) await Promise.all([...entry.leases].map((lease) => this.#release(lease)));
    await entry?.closing;
    if (this.#sources.has(key)) throw Error('gpu_source_closing');
    this.#failures.delete(key); return { cleared: true };
  }
  diagnostics() {
    const result = [...this.#sources.values()].map((entry) => ({ id: entry.key, type: entry.type, renderer: 'direct-gpu', requestedFps: 60,
      failed: this.#failures.has(entry.key), targets: [...entry.leases].filter((lease) => !lease.closed).map((lease) => ({
        active: lease.snapshot?.committed === true, width: lease.snapshot?.width || 0, height: lease.snapshot?.height || 0,
        preloaded: lease.speculative && lease.snapshot?.prepared === true,
        pointerReceived: lease.snapshot?.pointerReceived || 0, pointerForwarded: lease.snapshot?.pointerForwarded || 0,
        pointerBlocked: lease.snapshot?.pointerBlocked || 'none',
        fps: lease.snapshot?.fps || 0, renderCompletions: lease.snapshot?.renderCompletions || 0,
        ...(entry.type === 'web' ? { paintFrames: lease.snapshot?.paintFrames || 0, animationFrames: lease.snapshot?.animationFrames || 0 } : {}) })) }));
    for (const id of this.#failures) if (!this.#sources.has(id)) result.push({ id, renderer: 'direct-gpu', requestedFps: 60, failed: true, targets: [] });
    return result;
  }
  async close() {
    this.#closed = true; clearInterval(this.#timer);
    await Promise.all([...this.#warming.values()]);
    await this.#polling;
    await Promise.all([...this.#sources.values()].flatMap((entry) => [...entry.leases]).map((lease) => this.#release(lease)));
    // Failed closes remain reserved and are retried, not forgotten.
    await Promise.all([...this.#sources.values()].map(async (entry) => {
      await entry.starting.catch(() => {}); await entry.server?.close(); this.#sources.delete(entry.key);
    }));
    this.#failures.clear();
  }
}
