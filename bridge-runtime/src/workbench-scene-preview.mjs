import { readAuthorProperties, validateAuthorPropertyPatch } from './author-properties.mjs';
import { validateWebWallpaperInput } from './web-wallpaper-input.mjs';
import { resolvePlayback } from './playback-policy.mjs';

/** Shared GPU-direct Scene slot. Engine telemetry is a readiness hint, never
 * the trusted native decoded-frame proof used by the optional VP8 path.
 */
export function createScenePreviewSlot({ node, project, client, api, getEffects, onStatus = () => {},
  beforeOpen = async () => {}, window = globalThis, preserveOnFailure = false,
  readback = readAuthorProperties, validate = validateAuthorPropertyPatch, validateInput = validateWebWallpaperInput,
  playback = resolvePlayback, onMediaControl = null }) {
  let descriptor, released = false, committed = false, prepared = false, failed = false, closing;
  let sequence = 0, meter = null, startupTimer, renewalTimer, healthTimer, lastMessage = Date.now();
  let resolveReady, rejectReady;
  let propertyRequest = 0, propertyPending = null;
  let pointerDown = false;
  let lastControlRequest = 0, controlPending = 0;
  let pointerReceived = 0, pointerForwarded = 0, pointerBlocked = 'none';
  const isWeb = project.type === 'web';
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
  const capability = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const request = (op, extra = {}) => api('scene-preview', { method: 'POST', keepalive: op === 'close',
    body: JSON.stringify({ op, client, ...extra }) });
  const send = (op, extra = {}) => {
    if (!descriptor || released || !node.contentWindow) return;
    node.contentWindow.postMessage({ source: isWeb ? 'cwb-web-control' : 'cwb-scene-control', channel: descriptor.channel, op, ...extra }, descriptor.origin);
  };
  const publish = (phase, reason) => {
    node.dataset.cwbScenePhase = phase;
    if (meter) {
      node.dataset.cwbSceneWidth = String(meter.width); node.dataset.cwbSceneHeight = String(meter.height);
      node.dataset.cwbSceneFps = String(meter.fps);
    }
    onStatus({ phase, active: committed, ...(reason ? { reason } : {}), ...meter });
  };
  const update = () => {
    if (!prepared || released || failed) return;
    const effects = getEffects();
    const playing = playback(effects, { hidden: window.document?.hidden === true, inactive: !committed }).playing;
    if (!playing) pointerDown = false;
    const fit = ['cover', 'contain', 'fill'].includes(effects.fit) ? effects.fit : 'cover';
    send('fit', { value: fit });
    send('volume', { value: playing && effects.audioEnabled === true ? Math.max(0, Math.min(100, Number(effects.volume) || 0)) / 100 : 0 });
    send('loopHold', { value: Math.max(0, Math.min(3600, Math.round(Number(effects.webLoopHoldSeconds) || 0))) });
    send('forceSingleLoop', { value: effects.webForceSingleLoop === true });
    send(playing ? 'resume' : 'pause');
  };
  const onVisibility = () => { lastMessage = Date.now(); update(); };
  const onPagehide = () => { void release(); };
  const onPointer = (event) => {
    pointerReceived = Math.min(1e9, pointerReceived + 1);
    pointerBlocked = !committed ? 'inactive' : released ? 'released' : failed ? 'failed' : !prepared ? 'unprepared'
      : window.document?.hidden ? 'hidden' : !playback(getEffects()).playing ? 'paused' : 'none';
    if (pointerBlocked !== 'none') return;
    if (event.type !== 'pointermove' && event.target?.closest?.('button,input,select,textarea,a,summary,[role="button"],[contenteditable]')) {
      if (event.type === 'pointerup' && pointerDown) { pointerDown = false; send('pointerLeave'); }
      pointerBlocked = 'control';
      return;
    }
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) { pointerBlocked = 'geometry'; return; }
    let u = (event.clientX - rect.left) / rect.width, v = (event.clientY - rect.top) / rect.height;
    if (![u, v].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) { pointerBlocked = 'outside'; pointerDown = false; send('pointerLeave'); return; }
    if (event.type === 'pointerdown') pointerDown = (event.buttons & 1) === 1;
    if (event.type === 'pointerup') pointerDown = false;
    if (getEffects().mirror) u = 1 - u;
    pointerForwarded = Math.min(1e9, pointerForwarded + 1);
    send('pointer', { u, v, buttons: pointerDown ? event.buttons & 1 : 0,
      mods: Number(Boolean(event.shiftKey)) | Number(Boolean(event.ctrlKey)) << 1 | Number(Boolean(event.altKey)) << 2 | Number(Boolean(event.metaKey)) << 3 });
  };
  const cleanup = () => {
    window.clearTimeout(startupTimer); window.clearInterval(renewalTimer); window.clearInterval(healthTimer);
    window.removeEventListener('message', onMessage); window.removeEventListener('pagehide', onPagehide);
    window.document?.removeEventListener?.('visibilitychange', onVisibility);
    pointerDown = false;
    for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.removeEventListener(type, onPointer, { capture: true });
    if (propertyPending) {
      window.clearTimeout(propertyPending.timer); propertyPending.reject(Error('preview_cancelled')); propertyPending = null;
    }
  };
  const release = () => {
    if (closing) return closing;
    send('release'); released = true; committed = false; cleanup();
    rejectReady(Error('preview_cancelled')); node.removeAttribute('src'); node.remove();
    closing = opening.then(async () => {
      if (capability(descriptor?.handle)) await request('close', { handle: descriptor.handle }).catch(() => {});
    });
    return closing;
  };
  const fail = (reason) => {
    if (failed || released) return;
    failed = true; rejectReady(Error(reason)); publish('failed', reason);
    if (committed && preserveOnFailure) {
      // Keep an already displayed iframe, mute/pause it, and stop its handlers.
      // A failed candidate still releases immediately, so M1 retains the old slot.
      send('volume', { value: 0 }); send('pause'); cleanup();
    } else void release();
  };
  const onMessage = (event) => {
    if (released || failed || !descriptor || event.source !== node.contentWindow || event.origin !== descriptor.origin) return;
    const message = event.data;
    if (isWeb && message?.source === 'cwb-web-media-control' && message.channel === descriptor.channel) {
      if (!committed || !prepared || window.document?.hidden || !playback(getEffects()).playing || !onMediaControl
        || !Number.isSafeInteger(message.requestId) || message.requestId <= lastControlRequest || controlPending >= 4
        || !['play', 'pause', 'previous', 'next'].includes(message.command) || !/^[a-f0-9]{32}$/.test(message.sessionId || '')
        || Object.keys(message).some(key => !['source', 'channel', 'requestId', 'command', 'sessionId'].includes(key))) return;
      lastControlRequest = message.requestId; controlPending++;
      void Promise.resolve().then(() => {
        if (!committed || released || failed || window.document?.hidden || !playback(getEffects()).playing) throw Error('media_control_unavailable');
        return onMediaControl({ requestId: message.requestId, command: message.command, sessionId: message.sessionId });
      })
        .then(value => { if (!released && !failed) send('mediaControlResult', { requestId: message.requestId, ok: value?.ok === true }); },
          () => { if (!released && !failed) send('mediaControlResult', { requestId: message.requestId, ok: false }); })
        .finally(() => { controlPending--; });
      return;
    }
    if (message?.source !== (isWeb ? 'cwb-web' : 'cwb-scene') || message.channel !== descriptor.channel || !Number.isSafeInteger(message.sequence)
      || message.sequence <= sequence || !['loading', isWeb ? 'renderable' : 'ready', 'failed', 'released'].includes(message.phase)) return;
    const readyPhase = message.phase === (isWeb ? 'renderable' : 'ready');
    if (readyPhase && (![message.width, message.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
      || (isWeb ? !Number.isSafeInteger(message.paintFrames) || message.paintFrames < 2
        : !Number.isSafeInteger(message.draws) || message.draws <= 0 || !Number.isInteger(message.layers) || message.layers <= 0))) return;
    sequence = message.sequence; lastMessage = Date.now();
    if (message.phase === 'failed' || message.phase === 'released') { fail('preview_engine_failed'); return; }
    if (readyPhase) {
      if (propertyPending && message.propertyRequest === propertyPending.id) {
        const pending = propertyPending; propertyPending = null; window.clearTimeout(pending.timer);
        const actual = readback(pending.schema, message.properties, validate);
        const directoryReady = !isWeb || !Object.values(pending.schema).some(spec => spec.type === 'directory') || message.directoryStatus === 'ready';
        const available = directoryReady && (!isWeb || message.propertiesSupported === true) && (Object.keys(actual.values).length > 0 || Object.keys(pending.schema).length === 0);
        pending.resolve({ phase: available ? 'ready' : 'unavailable', method: available ? isWeb ? 'author-delivery' : 'engine-readback' : 'none',
          source: 'workbench-preview', ...actual });
      }
      meter = { width: message.width, height: message.height,
        fps: Number.isFinite(message.fps) ? Math.round(Math.max(0, Math.min(240, message.fps))) : 0,
        draws: Number.isSafeInteger(message.draws) ? Math.min(1e9, message.draws) : 0,
        renderCompletions: Number.isSafeInteger(message.renderCompletions) ? Math.min(1e9, message.renderCompletions) : 0,
        ...(isWeb ? { paintFrames: message.paintFrames, animationFrames: message.animationFrames || 0 } : {}) };
      if (!prepared) {
        prepared = true; window.clearTimeout(startupTimer);
        send('properties', { values: descriptor.properties ?? {} }); update(); resolveReady();
      }
      publish(committed ? 'ready' : 'prepared');
    }
  };
  const opening = Promise.resolve().then(async () => {
    await beforeOpen();
    if (released) return;
    descriptor = await request('open', { id: project.id, fps: 60 });
    if (released) return;
    let origin, url;
    try { origin = new URL(descriptor.origin); url = new URL(descriptor.url); } catch { throw Error('preview_descriptor_invalid'); }
    const webBase = typeof descriptor.resourceBase === 'string' ? descriptor.resourceBase : '';
    const validWeb = new RegExp('^' + origin.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[a-f0-9]{32}/files/project$').test(webBase)
      && url.href.startsWith(webBase + '/') && /\.html?$/i.test(url.pathname) && !url.search && !url.hash
      && url.pathname.split('/').every(part => { try { return !/[\\\0]/.test(decodeURIComponent(part)) && !['.', '..'].includes(decodeURIComponent(part)); } catch { return false; } });
    if (!capability(descriptor.handle) || !capability(descriptor.channel) || origin.origin !== descriptor.origin
      || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password
      || url.origin !== origin.origin || (isWeb ? descriptor.type !== 'web' || !validWeb
        : url.pathname !== '/wallpaper-engine/scene-live/index.html' || url.searchParams.get('type') !== 'scene' || url.searchParams.get('src') !== 'project')) throw Error('preview_descriptor_invalid');
    node.sandbox = 'allow-scripts allow-same-origin'; node.referrerPolicy = 'no-referrer'; node.style.pointerEvents = 'none';
    window.addEventListener('message', onMessage); window.addEventListener('pagehide', onPagehide);
    window.document?.addEventListener?.('visibilitychange', onVisibility);
    // Passive capture observes input before host bubble handlers stop it;
    // it never prevents or redirects the host's own click/drag behaviour.
    for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.addEventListener(type, onPointer, { passive: true, capture: true });
    startupTimer = window.setTimeout(() => fail('preview_first_frame_timeout'), Math.min(90000, Math.max(15000, descriptor.firstFrameTimeoutMs || 90000)));
    renewalTimer = window.setInterval(() => {
      void request('renew', { handle: descriptor.handle }).catch(() => fail('preview_lease_lost'));
    }, 15000);
    healthTimer = window.setInterval(() => {
      if (!window.document?.hidden && prepared && Date.now() - lastMessage > 10000) fail('preview_heartbeat_timeout');
    }, 1000);
    publish('loading'); node.src = descriptor.url;
  }).catch((error) => { fail(error.message === 'preview_descriptor_invalid' ? error.message : 'preview_unavailable'); });
  return { node, kind: isWeb ? 'Web' : 'Scene', projectId: project.id, canonicalId: isWeb ? 'backgroundWeb' : 'backgroundScene', ready, update, release,
    async validatePrepared() {
      // Used by the workbench only. Codex promotes its private CDP lease instead.
      await opening;
      if (released || failed || !descriptor) return false;
      const result = await api('scene-preview', { method: 'POST', signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ op: 'validate', client, handle: descriptor.handle }) }).catch(() => null);
      if (released || failed || result?.current !== true) return false;
      descriptor.properties = result.properties ?? {};
      if (prepared) send('properties', { values: descriptor.properties });
      return true;
    },
    activate() {
      if (released || failed || !prepared) throw Error('preview_unavailable');
      committed = true; update(); publish('ready');
    },
    retire() { committed = false; update(); },
    input(value) {
      if ((!isWeb && value?.op !== 'audio') || !prepared || !committed || released || failed || window.document?.hidden
        || !playback(getEffects()).playing || !node.contentWindow) return false;
      let input;
      try { input = validateInput(value); } catch { return false; }
      send(input.op, input.op === 'audio' ? { values: input.values } : { value: input.value });
      return true; // dispatched to the exact frame; not an OS/author-consumption ACK
    },
    properties(values) { if (prepared) send('properties', { values }); },
    authorProperties(schema, values = null) {
      if (!prepared || !committed || released || failed) return Promise.reject(Error('preview_properties_unavailable'));
      if (propertyPending) return Promise.reject(Error('preview_properties_busy'));
      if (propertyRequest >= Number.MAX_SAFE_INTEGER) return Promise.reject(Error('preview_properties_unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++propertyRequest;
        propertyPending = { id, schema, resolve, reject, timer: window.setTimeout(() => {
          if (propertyPending?.id !== id) return;
          window.clearTimeout(propertyPending.timer); propertyPending = null; reject(Error('preview_properties_timeout'));
        }, 3000) };
        send(values === null ? 'readProperties' : 'properties', { propertyRequest: id, ...(values === null ? {} : { values }) });
      });
    },
    stats: () => meter ? { ...meter, pointerReceived, pointerForwarded, pointerBlocked } : null };
}
