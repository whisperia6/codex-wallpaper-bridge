/* Trusted adapter on the dedicated readonly scene origin; never contains the control capability. */
(() => {
  'use strict';
  const session = document.querySelector('meta[name="cwb-scene-session"]')?.content;
  if (!/^[a-f0-9]{32}$/.test(session ?? '')) return;
  const engine = new Promise(resolve => { window.__cwbStartScene = resolve; });
  const forgetEngine = () => { delete window.__cwbStartScene; };
  let draws = 0;
  // FPS needs a second frame and an idle scene may render only once. Count actual
  // WebGL submits before the async engine mount, rather than treating iframe load as ready.
  const patches = [];
  const audioElements = new Set();
  const mediaProto = window.HTMLMediaElement?.prototype;
  if (mediaProto && typeof mediaProto.play === 'function') {
    const original = mediaProto.play;
    const wrapped = function (...args) {
      if (this.tagName === 'AUDIO' && audioElements.size < 128) audioElements.add(this);
      return original.apply(this, args);
    };
    mediaProto.play = wrapped;
    patches.push(() => { if (mediaProto.play === wrapped) mediaProto.play = original; audioElements.clear(); });
  }
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const proto = type?.prototype;
      if (!proto || !Object.hasOwn(proto, method) || typeof proto[method] !== 'function') continue;
      const original = proto[method];
      const wrapped = function (...args) { const value = original.apply(this, args); draws = Math.min(1e9, draws + 1); return value; };
      proto[method] = wrapped;
      patches.push(() => { if (proto[method] === wrapped) proto[method] = original; });
    }
  }
  void fetch(`/${session}/bridge-config.json`).then((response) => {
    if (!response.ok) throw new Error('scene-bridge-config');
    return response.json();
  }).then(({ parentOrigin, channel, resourceBase, fps, firstFrameTimeoutMs, maxFirstFrameTimeoutMs, authorProperties = { schema: {}, values: {} } }) => {
    let sequence = 0;
    let phase = 'loading';
    let timer;
    let released = false;
    let propertyRevision = 0;
    let volume = 0;
    let instance, firstFrame, audioReceived = 0;
    const silence = () => ({ left: Array(64).fill(0), right: Array(64).fill(0) });
    let audioSnapshot = silence();
    let pointerInFlight = false;
    let pointerAccepted = 0, pointerDelivered = 0;
    let pointerAcknowledged = 0, renderCompletions = 0;
    const pointerQueue = [];
    const startedAt = performance.now();
    let deadline = firstFrameTimeoutMs;
    let checkingProgress = false;
    let payloadBytes = 0;
    const snapshot = () => {
      const meter = instance?.stats ?? {};
      const canvas = instance?.canvas;
      const readback = window.__cwbReadProperties?.(authorProperties.schema, instance?.getProperties(), window.__cwbValidateProperties)
        ?? { values: {}, rejected: 0 };
      return { fps: Number.isFinite(meter.fps) ? Math.max(0, Math.min(240, meter.fps)) : 0,
        running: meter.running === true, idle: meter.idle === true, draws,
        paused: instance?.paused === true,
        layers: Math.min(10000, firstFrame?.layerCount ?? 0),
        width: canvas?.width ?? 0, height: canvas?.height ?? 0, volume, propertyRevision,
        pendingPointers: pointerQueue.length, pointerAccepted, pointerDelivered, pointerAcknowledged, renderCompletions,
        systemAudio: { attached: Boolean(instance) && !released, received: audioReceived },
        audio: { elements: audioElements.size, ready: [...audioElements].filter((audio) => audio.readyState >= 2).length,
          playing: [...audioElements].filter((audio) => !audio.paused && !audio.ended).length,
          time: Math.round([...audioElements].reduce((time, audio) => time + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0), 0) * 1000) / 1000 },
        properties: readback.values, propertyReadbackRejected: readback.rejected };
    };
    const cancelPointers = () => {
      pointerInFlight = false; pointerQueue.length = 0;
    };
    const pumpPointer = () => {
      if (phase !== 'ready' || instance?.paused === true) { cancelPointers(); return; }
      // A GL submission is before cursor dispatch. Only the pinned engine's
      // exact post-dispatch/beginFrame callback may consume an in-flight transition.
      if (pointerQueue.length && !pointerInFlight) {
        const value = pointerQueue.shift();
        pointerInFlight = true;
        instance?.pushPointer(value.u, value.v, value.buttons, value.mods);
        pointerDelivered = Math.min(1e9, pointerDelivered + 1);
        publish();
      }
    };
    const previousComplete = window.__cwbSceneRenderComplete;
    const onRenderComplete = () => {
      if (released || phase === 'failed' || phase === 'released') return;
      renderCompletions = Math.min(1e9, renderCompletions + 1);
      if (pointerInFlight) {
        pointerAcknowledged = Math.min(1e9, pointerAcknowledged + 1); pointerInFlight = false;
        pumpPointer(); publish();
      }
    };
    window.__cwbSceneRenderComplete = onRenderComplete;
    patches.push(() => {
      if (window.__cwbSceneRenderComplete === onRenderComplete) {
        if (previousComplete === undefined) delete window.__cwbSceneRenderComplete;
        else window.__cwbSceneRenderComplete = previousComplete;
      }
    });
    const cleanup = () => {
      audioSnapshot = silence(); forgetEngine();
      clearInterval(timer);
      cancelPointers();
      window.removeEventListener('message', onMessage);
      for (const restore of patches) restore();
      if (!released) {
        released = true; instance?.destroy({ releasePkgCache: true });
        instance = undefined; firstFrame = undefined;
      }
    };
    const publish = (propertyRequest) => {
      const message = { source: 'cwb-scene', channel, sequence: ++sequence, phase, ...snapshot() };
      if (Number.isSafeInteger(propertyRequest) && propertyRequest > 0) message.propertyRequest = propertyRequest;
      window.__cwbScene = Object.freeze(message);
      if (parentOrigin && window.parent !== window) window.parent.postMessage(message, parentOrigin);
      if (phase === 'failed' || phase === 'released') clearInterval(timer);
    };
    const fail = () => {
      if (released) return;
      phase = 'failed'; cleanup(); publish();
    };
    const checkFirstFrame = async () => {
      if (checkingProgress || phase !== 'loading' || performance.now() - startedAt < deadline) return;
      checkingProgress = true;
      try {
        const response = await fetch(`/${session}/payload-progress.json`, { signal: AbortSignal.timeout(1500) });
        const progress = response.ok ? await response.json() : null;
        if (phase !== 'loading') return;
        const elapsed = performance.now() - startedAt;
        const age = Date.now() - progress?.lastByteAt;
        // A recent final chunk also gets a decode window. A stalled or repeated
        // snapshot cannot renew the deadline, and each mount has a hard cap.
        if (elapsed < maxFirstFrameTimeoutMs && progress?.bytesServed > payloadBytes && age >= 0 && age < 5000) {
          payloadBytes = progress.bytesServed;
          deadline = Math.min(maxFirstFrameTimeoutMs, elapsed + 5000);
          return;
        }
      } catch { /* The progress endpoint is advisory. */ }
      finally { checkingProgress = false; }
      if (phase === 'loading' && !released) fail();
    };
    const onMessage = (event) => {
      const message = event.data;
      if (!parentOrigin || event.origin !== parentOrigin || event.source !== window.parent
        || message?.source !== 'cwb-scene-control' || message.channel !== channel) return;
      if (phase === 'failed' || phase === 'released') return;
      let propertyRequest;
      if (message.op === 'pause') { audioSnapshot = silence(); cancelPointers(); instance?.pointerLeave(); instance?.pause(); }
      else if (message.op === 'resume') instance?.resume();
      else if (message.op === 'release') { phase = 'released'; cleanup(); }
      else if (message.op === 'audio' && phase === 'ready') {
        if (instance?.paused === true) return;
        let input; try { input = window.__cwbValidateWebInput?.({ op: 'audio', values: message.values }); } catch { return; }
        if (!input) return;
        audioSnapshot = { left: input.values.slice(0, 64), right: input.values.slice(64) };
        audioReceived = Math.min(1e9, audioReceived + 1);
      }
      else if (message.op === 'pointer' && phase === 'ready') {
        const { u, v, buttons = 0, mods = 0 } = message;
        if (![u, v].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
          || ![0, 1].includes(buttons) || !Number.isInteger(mods) || mods < 0 || mods > 15) return;
        if (instance?.paused === true) return;
        pointerAccepted = Math.min(1e9, pointerAccepted + 1);
        const last = pointerQueue.at(-1);
        if (last?.buttons === buttons) pointerQueue[pointerQueue.length - 1] = { u, v, buttons, mods };
        else if (pointerQueue.length < 64) pointerQueue.push({ u, v, buttons, mods });
        else { phase = 'failed'; cleanup(); publish(); return; }
        pumpPointer();
      }
      else if (message.op === 'pointerLeave' && phase === 'ready') { cancelPointers(); instance?.pointerLeave(); }
      else if (message.op === 'volume' && phase === 'ready') {
        if (typeof message.value !== 'number' || !Number.isFinite(message.value) || message.value < 0 || message.value > 1) return;
        instance?.setVolume(message.value); volume = message.value;
      }
      else if (message.op === 'fit' && phase === 'ready') {
        if (!['cover', 'contain', 'fill'].includes(message.value)) return;
        instance?.setFit(message.value);
      }
      else if (['properties', 'resetProperties'].includes(message.op) && phase === 'ready') {
        if (Object.hasOwn(message, 'propertyRequest')
          && (!Number.isSafeInteger(message.propertyRequest) || message.propertyRequest <= 0)) return;
        const patch = window.__cwbValidateProperties?.(authorProperties.schema,
          message.op === 'resetProperties' ? authorProperties.values : message.values);
        if (!patch) return;
        instance?.setProperties(patch);
        propertyRevision++;
        propertyRequest = message.propertyRequest;
      }
      else if (message.op === 'readProperties' && phase === 'ready') {
        if (!Number.isSafeInteger(message.propertyRequest) || message.propertyRequest <= 0) return;
        propertyRequest = message.propertyRequest;
      }
      else return;
      publish(propertyRequest);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', () => {
      cleanup();
    }, { once: true });
    timer = setInterval(() => { publish(); void checkFirstFrame(); }, 250);
    publish();
    void engine.then(library => {
      forgetEngine();
      if (released) return;
      if (!library) { fail(); return; }
      const source = library.httpSource(resourceBase);
      const readProject = source.project;
      source.project = async signal => {
        const project = await readProject(signal);
        return project && { ...project, type: 'scene' };
      };
      instance = library.createScene(document.getElementById('scene'), {
        fit: 'cover', fps, volume: 0, bake: false, localAssets: 'off',
        mountTimeoutMs: 0, media: null, audio: { snapshot: () => audioSnapshot },
        properties: authorProperties.values,
        onReady(info) {
          if (released || phase !== 'loading') return;
          firstFrame = info;
          const state = snapshot();
          if (!state.draws || !state.layers || !state.width || !state.height) { fail(); return; }
          phase = 'ready'; publish();
        },
        onError: fail,
      });
      return instance.load(source);
    }).catch(fail);
  }).catch(() => {
    forgetEngine();
    for (const restore of patches) restore();
    window.__cwbScene = Object.freeze({ phase: 'failed', reason: 'scene-bridge-config' });
  });
})();
