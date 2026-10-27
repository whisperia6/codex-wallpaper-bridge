/* Compatibility API on an independent readonly origin; no control API, disk paths, commands or Node. */
(() => {
  'use strict';
  const token = document.querySelector('meta[name="cwb-scene-session"]')?.content;
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) return;
  const callbacks = new Map();
  const lastMedia = new Map([['MediaStatus', { enabled: false }]]), pendingMedia = new Set();
  const directories = new Map(), randomRequests = new Set();
  window.wallpaperMediaIntegration = Object.freeze({ PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 });
  let controlSession = '', controlCommands = [], controlRequestId = 0;
  const controlRequests = new Map();
  // Explicit CWB extension, not an invented Wallpaper Engine official API.
  window.cwbMediaIntegration = Object.freeze({
    registerLyricsListener(callback) {
      if (phase === 'released' || phase === 'failed') return;
      if (typeof callback !== 'function') { callbacks.delete('Lyrics'); return; }
      callbacks.set('Lyrics', callback);
      void Promise.resolve().then(() => {
        if (callbacks.get('Lyrics') !== callback || !loaded || phase !== 'renderable') return;
        if (paused) pendingMedia.add('Lyrics'); else if (lastMedia.has('Lyrics')) invoke(callback, { ...lastMedia.get('Lyrics') });
      });
    },
    capabilities: () => ({ enabled: Boolean(controlSession && controlCommands.length), commands: controlCommands.slice() }),
    control(command) {
      if (!loaded || paused || phase !== 'renderable' || !controlCommands.includes(command) || !controlSession || controlRequests.size >= 4
        || controlRequestId >= Number.MAX_SAFE_INTEGER) return Promise.reject(Error('media_control_unavailable'));
      const requestId = ++controlRequestId;
      return new Promise((resolve, reject) => {
        const timer = nativeTimeout(() => { controlRequests.delete(requestId); reject(Error('media_control_timeout')); }, 6500);
        controlRequests.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({ source: 'cwb-web-media-control', channel: config.channel, requestId, command, sessionId: controlSession }, config.parentOrigin);
      });
    }
  });
  for (const name of ['Audio', 'MediaProperties', 'MediaThumbnail', 'MediaPlayback', 'MediaTimeline', 'MediaStatus']) {
    window[`wallpaperRegister${name}Listener`] = (callback) => {
      if (phase === 'released' || phase === 'failed') return;
      if (typeof callback === 'function') callbacks.set(name, callback); else callbacks.delete(name);
      if (name !== 'Audio' && typeof callback === 'function') void Promise.resolve().then(() => {
        if (callbacks.get(name) !== callback || !loaded || phase !== 'renderable') return;
        if (paused) { pendingMedia.add(name); return; }
        if (lastMedia.has(name)) invoke(callback, { ...lastMedia.get(name) });
      });
    };
  }
  let phase = 'loading', loaded = false, config = null, timer = null, sequence = 0;
  let properties = {}, propertyRevision = 0, paused = false, callbackErrors = 0, volume = 0, paintFrames = 0, animationFrames = 0;
  const nativeRaf = (window.requestAnimationFrame || requestAnimationFrame).bind(window);
  const nativeCancelRaf = window.cancelAnimationFrame?.bind(window);
  const nativeTimeout = window.setTimeout?.bind(window);
  const nativeClearTimeout = window.clearTimeout?.bind(window);
  const nativeInterval = (window.setInterval || setInterval).bind(window);
  const nativeClearInterval = (window.clearInterval || clearInterval).bind(window);
  const patches = [], frames = new Map(), tasks = new Map(), resumeMedia = new Set();
  if (typeof window.__cwbInstallResourceAliases === 'function' && typeof window.__cwbRewriteResourceUrl === 'function') {
    patches.push(...window.__cwbInstallResourceAliases(window, window.__cwbRewriteResourceUrl,
      () => config?.resourceBase ?? `${window.location?.origin}/${token}/files/project`));
  }
  let nextScheduleId = 0, pointerDown = false, pauseStarted = 0, pausedTime = 0, started = false;
  let webLoopHoldMs = 0, webLoopHoldTimer = null;
  let forceSingleLoop = false, singleLoopTimer = null;
  let singleLoopAttempts = 0;
  const propertyCall = (name, ...args) => {
    const listener = window.wallpaperPropertyListener;
    if (typeof listener?.[name] === 'function') invoke(() => listener[name](...args));
  };
  let propertyListener = window.wallpaperPropertyListener ?? null;
  Object.defineProperty(window, 'wallpaperPropertyListener', { configurable: true, enumerable: true,
    get: () => propertyListener,
    set(value) {
      const previous = propertyListener;
      propertyListener = value && typeof value === 'object' ? value : null;
      // First/null→listener registration only, and never in a React render.
      if (!propertyListener || previous) return;
      const next = propertyListener;
      void Promise.resolve().then(() => {
        if (propertyListener !== next || !loaded || !config || phase !== 'renderable') return;
        applyProperties(properties);
        propertyCall('applyGeneralProperties', { fps: [15, 30, 60].includes(config.fps) ? config.fps : 60, paused, audiovolume: Math.round(volume * 100) });
        propertyCall('setPaused', paused);
        for (const key of directories.keys()) notifyDirectory(key, true);
      });
    } });
  const mediaEvent = (name, value) => {
    // Producer snapshots are replayed at audio cadence. Do not repeatedly make
    // an author reload the same cover or clear the same empty media state.
    const previous = lastMedia.get(name), keys = Object.keys(value);
    if (previous && keys.length === Object.keys(previous).length
      && keys.every(key => Object.hasOwn(previous, key) && previous[key] === value[key])) return;
    lastMedia.set(name, { ...value });
    if (paused || !loaded || phase !== 'renderable') pendingMedia.add(name);
    else invoke(callbacks.get(name), { ...value });
  };
  const flushMedia = () => {
    if (paused || phase !== 'renderable') return;
    for (const name of pendingMedia) { pendingMedia.delete(name); invoke(callbacks.get(name), { ...lastMedia.get(name) }); }
  };
  const directoryStatus = () => [...directories.values()].some(record => record.failed) ? 'failed'
    : [...directories.values()].some(record => record.busy) ? 'loading'
    : [...directories].some(([key, record]) => config.authorProperties.schema[key]?.mode === 'fetchall'
      && JSON.stringify(record.files) !== JSON.stringify(record.notified)) ? 'pending' : 'ready';
  const notifyDirectory = (key, force = false) => {
    const record = directories.get(key);
    if (!record || record.busy || paused || !loaded || phase !== 'renderable') return;
    if (config.authorProperties.schema[key]?.mode !== 'fetchall') return;
    const previous = record.notified, next = record.files;
    const removed = previous.filter(file => !next.some(item => item.url === file.url)).map(file => file.url);
    const added = next.filter(file => force || !previous.some(item => item.url === file.url && item.version === file.version)).map(file => file.url);
    record.notified = next.map(file => ({ ...file }));
    if (removed.length) propertyCall('userDirectoryFilesRemoved', key, removed);
    if (added.length) propertyCall('userDirectoryFilesAddedOrChanged', key, added);
  };
  const flushRandom = () => {
    if (!loaded || paused || phase !== 'renderable') return;
    for (const request of [...randomRequests]) {
      const record = directories.get(request.key);
      if (record?.busy) continue;
      randomRequests.delete(request);
      const files = record?.failed ? [] : record?.files ?? [];
      invoke(() => request.callback(request.key, files.length ? files[Math.floor(Math.random() * files.length)].url : ''));
    }
  };
  window.wallpaperRequestRandomFileForProperty = (key, callback) => {
    if (typeof callback !== 'function' || typeof key !== 'string' || key.length > 128 || randomRequests.size >= 128
      || phase === 'released' || phase === 'failed') return;
    randomRequests.add({ key, callback }); void Promise.resolve().then(flushRandom);
  };
  const safeDirectoryFile = (file, spec) => {
    if (!file || Object.keys(file).length !== 2 || typeof file.version !== 'string' || !/^[a-f0-9]{64}$/.test(file.version)
      || typeof file.url !== 'string' || file.url.length > 2048 || !file.url.startsWith(config.resourceBase + '/')) return false;
    try {
      const url = new URL(file.url), relative = url.pathname.slice(new URL(config.resourceBase).pathname.length + 1);
      if (url.origin !== new URL(config.resourceBase).origin || url.search || url.hash || url.username || url.password
        || relative.split('/').some(part => { const decoded = decodeURIComponent(part); return !decoded || ['.', '..'].includes(decoded) || /[\\/\x00-\x1f:%?#]/.test(decoded); })) return false;
      return spec.extensions.some(ext => decodeURIComponent(url.pathname).toLowerCase().endsWith(ext));
    } catch { return false; }
  };
  const refreshDirectory = (key, value) => {
    const spec = config.authorProperties.schema[key];
    if (spec?.type !== 'directory') return null;
    let record = directories.get(key);
    if (!record) { record = { files: [], notified: [], version: 0 }; directories.set(key, record); }
    record.controller?.abort(); nativeClearTimeout?.(record.timeout);
    const version = ++record.version;
    record.value = value; record.files = []; record.failed = false; record.busy = value !== ''; record.checked = Date.now();
    if (value === '') { notifyDirectory(key); flushRandom(); return null; }
    const controller = record.controller = new AbortController();
    record.timeout = nativeTimeout?.(() => controller.abort(), 5000);
    record.pending = (async () => {
      try {
        const response = await fetch(`/${token}/author-directory/${encodeURIComponent(key)}?value=${encodeURIComponent(value)}`, { signal: controller.signal });
        if (!response.ok) throw Error();
        const catalog = await response.json();
        if (phase === 'released' || phase === 'failed' || record.version !== version || controller.signal.aborted) return;
        if (!catalog || Object.keys(catalog).length !== 1 || !Array.isArray(catalog.files) || catalog.files.length > 128
          || catalog.files.some(file => !safeDirectoryFile(file, spec)) || new Set(catalog.files.map(file => file.url)).size !== catalog.files.length
          || [...directories.values()].reduce((n, other) => n + (other === record ? 0 : other.files.length), catalog.files.length) > 512) throw Error();
        record.files = catalog.files.map(file => ({ url: file.url, version: file.version }));
      } catch {
        if (phase === 'released' || phase === 'failed' || record.version !== version) return;
        record.failed = true;
      } finally {
        if (record.version === version) {
          nativeClearTimeout?.(record.timeout); record.busy = false;
          notifyDirectory(key); flushRandom();
        }
      }
    })();
    return record.pending;
  };
  const refreshDirectories = values => Object.entries(values).map(([key, value]) => refreshDirectory(key, value)).filter(Boolean);
  const pollDirectories = () => {
    if (paused || phase !== 'renderable') return;
    for (const [key, record] of directories) if (!record.busy && record.value !== '' && !record.value.startsWith('cwb-author-directories/') && Date.now() - record.checked >= 5000) {
      void refreshDirectory(key, record.value)?.then(() => publish());
    }
  };
  function frameSchedule(record) {
    if (paused || phase === 'released' || phase === 'failed') return;
    const version = record.version = (record.version || 0) + 1;
    record.nativeId = nativeRaf(time => {
      if (version !== record.version || paused || phase === 'released') return;
      record.nativeId = null;
      if (!frames.delete(record.id)) return;
      try { record.callback(time - pausedTime); }
      finally { animationFrames = Math.min(1e9, animationFrames + 1); }
    });
  }
  const wrappedRaf = callback => {
    if (typeof callback !== 'function' || frames.size >= 4096) throw TypeError('web_animation_invalid');
    const record = { id: ++nextScheduleId, nativeId: null, callback };
    frames.set(record.id, record); frameSchedule(record); return record.id;
  };
  const wrappedCancelRaf = id => { const record = frames.get(id); if (record) { nativeCancelRaf?.(record.nativeId); frames.delete(id); } };
  window.requestAnimationFrame = wrappedRaf; window.cancelAnimationFrame = wrappedCancelRaf;
  patches.push(() => { if (window.requestAnimationFrame === wrappedRaf) window.requestAnimationFrame = nativeRaf;
    if (window.cancelAnimationFrame === wrappedCancelRaf) window.cancelAnimationFrame = nativeCancelRaf; });
  function taskSchedule(record) {
    if (paused || phase === 'released' || phase === 'failed') return;
    const version = record.version = (record.version || 0) + 1;
    record.due = Date.now() + record.remaining;
    record.nativeId = nativeTimeout(() => {
      if (version !== record.version || paused || phase === 'released') return;
      record.nativeId = null;
      if (!tasks.has(record.id) || paused || phase === 'released') return;
      if (!record.interval) tasks.delete(record.id);
      try { record.callback(...record.args); }
      finally { if (record.interval && tasks.has(record.id)) { record.remaining = record.delay; taskSchedule(record); } }
    }, record.remaining);
  }
  if (nativeTimeout && nativeClearTimeout) {
    const createTask = interval => (callback, delay = 0, ...args) => {
      // Legacy string timers keep browser semantics; no bridge eval is introduced.
      if (typeof callback !== 'function') return (interval ? nativeInterval : nativeTimeout)(callback, delay, ...args);
      if (tasks.size >= 4096) throw TypeError('web_timer_capacity');
      delay = Math.max(interval ? 1 : 0, Math.min(2147483647, Number(delay) || 0));
      const record = { id: ++nextScheduleId, callback, args, interval, delay, remaining: delay, nativeId: null };
      tasks.set(record.id, record); taskSchedule(record); return record.id;
    };
    const clearTask = id => { const record = tasks.get(id); if (record) { nativeClearTimeout(record.nativeId); tasks.delete(id); }
      else { nativeClearTimeout(id); nativeClearInterval(id); } };
    const timeout = createTask(false), interval = createTask(true);
    window.setTimeout = timeout; window.setInterval = interval;
    window.clearTimeout = clearTask; window.clearInterval = clearTask;
    patches.push(() => { if (window.setTimeout === timeout) window.setTimeout = nativeTimeout;
      if (window.setInterval === interval) window.setInterval = nativeInterval;
      if (window.clearTimeout === clearTask) window.clearTimeout = nativeClearTimeout;
      if (window.clearInterval === clearTask) window.clearInterval = nativeClearInterval; });
  }
  const mediaPrototype = window.HTMLMediaElement?.prototype;
  if (mediaPrototype?.play) {
    const original = mediaPrototype.play;
    const play = function (...args) {
      this.volume = volume; this.muted = volume === 0;
      if (paused) { if (resumeMedia.size < 128) resumeMedia.add(this); return Promise.resolve(); }
      return original.apply(this, args);
    };
    mediaPrototype.play = play;
    patches.push(() => { if (mediaPrototype.play === play) mediaPrototype.play = original; });
  }
  function playback(value) {
    if (paused === value) return;
    paused = value;
    if (paused) {
      pauseStarted = performance.now(); pointerDown = false;
      for (const record of frames.values()) { record.version++; nativeCancelRaf?.(record.nativeId); record.nativeId = null; }
      for (const record of tasks.values()) { record.version++; record.remaining = Math.max(0, record.due - Date.now()); nativeClearTimeout?.(record.nativeId); record.nativeId = null; }
      for (const media of document.querySelectorAll('audio,video')) { if (!media.paused && resumeMedia.size < 128) resumeMedia.add(media); media.pause(); media.muted = true; }
    } else {
      pausedTime += Math.max(0, performance.now() - pauseStarted);
      for (const record of frames.values()) frameSchedule(record);
      for (const record of tasks.values()) taskSchedule(record);
      for (const media of resumeMedia) { media.volume = volume; media.muted = volume === 0; void media.play()?.catch(() => {}); }
      resumeMedia.clear();
    }
  }
  // Optional dwell after a Web wallpaper's own single-loop clip ends. The page
  // must expose `body[data-playback-mode="single"]`; other pages are untouched.
  const onMediaEnded = (event) => {
    const media = event.target;
    if (media?.tagName !== 'VIDEO' || event.__cwbLoopHoldBypass === true || webLoopHoldMs <= 0
      || phase !== 'renderable' || document.body?.dataset.playbackMode !== 'single') return;
    event.stopImmediatePropagation();
    if (webLoopHoldTimer !== null) nativeClearTimeout(webLoopHoldTimer);
    webLoopHoldTimer = nativeTimeout(() => {
      webLoopHoldTimer = null;
      if (phase === 'released' || phase === 'failed') return;
      const replay = new Event('ended');
      Object.defineProperty(replay, '__cwbLoopHoldBypass', { value: true });
      media.dispatchEvent(replay);
    }, webLoopHoldMs);
  };
  window.addEventListener('ended', onMediaEnded, true);
  const enforceSingleLoop = () => {
    if (!forceSingleLoop || paused || phase !== 'renderable') return;
    if (document.body?.dataset.playbackMode === 'single') { singleLoopAttempts = 0; return; }
    const option = document.querySelector('[data-playback="single"]');
    if (!option || option.disabled || option.getAttribute('aria-disabled') === 'true') return;
    const button = document.getElementById('modeButton');
    if (button && button.getAttribute('aria-expanded') !== 'true') button.click();
    option.click();
    singleLoopAttempts++;
    if (singleLoopAttempts % 10 === 0 && document.body?.dataset.playbackMode !== 'single') {
      nativeClearInterval(singleLoopTimer); singleLoopTimer = null;
    }
  };
  const syncForceSingleLoop = () => {
    if (!forceSingleLoop) {
      if (singleLoopTimer !== null) { nativeClearInterval(singleLoopTimer); singleLoopTimer = null; }
      singleLoopAttempts = 0;
      return;
    }
    if (singleLoopTimer === null) singleLoopTimer = nativeInterval(enforceSingleLoop, 1000);
    nativeTimeout(enforceSingleLoop, 0);
  };
  const invoke = (callback, value) => { try { if (typeof callback === 'function') callback(value); } catch { callbackErrors = Math.min(1e6, callbackErrors + 1); } };
  const propertyInput = (values) => Object.fromEntries(Object.entries(
    typeof window.__cwbMapFileProperties === 'function'
      ? window.__cwbMapFileProperties(config.authorProperties.schema, values, config.resourceBase) : values
  ).filter(([key]) => config.authorProperties.schema[key]?.type !== 'directory' || config.authorProperties.schema[key].mode !== 'fetchall')
    .map(([key, value]) => [key, { value }]));
  const applyProperties = values => {
    const payload = propertyInput(values);
    if (Object.keys(payload).length) propertyCall('applyUserProperties', payload);
  };
  const publish = (propertyRequest) => {
    const message = { source: 'cwb-web', channel: config.channel, sequence: ++sequence, phase,
      width: Math.min(16384, Math.max(0, window.innerWidth || 0)), height: Math.min(16384, Math.max(0, window.innerHeight || 0)),
      properties: { ...properties }, webLoopHoldSeconds: webLoopHoldMs / 1000, forceSingleLoop, propertiesSupported: Object.values(config.authorProperties.schema).every(spec =>
        typeof window.wallpaperPropertyListener?.[spec.type === 'directory' && spec.mode === 'fetchall'
          ? 'userDirectoryFilesAddedOrChanged' : 'applyUserProperties'] === 'function'),
      propertyRevision, pausedRequested: paused, callbackErrors, paintFrames, animationFrames, volume, directoryStatus: directoryStatus() };
    if (Number.isSafeInteger(propertyRequest) && propertyRequest > 0) message.propertyRequest = propertyRequest;
    window.__cwbWeb = Object.freeze(message);
    if (config.parentOrigin && window.parent !== window) window.parent.postMessage(message, config.parentOrigin);
  };
  const start = () => {
    if (!loaded || !config || phase !== 'loading' || started) return;
    started = true;
    properties = { ...config.authorProperties.values };
    applyProperties(properties);
    propertyCall('applyGeneralProperties', { fps: [15, 30, 60].includes(config.fps) ? config.fps : 60, audiovolume: 0, paused: false });
    propertyCall('setPaused', false);
    void Promise.all(refreshDirectories(properties)).then(() => { if (phase === 'renderable') publish(); });
    nativeRaf(() => { paintFrames++; nativeRaf(() => {
      // Direct GPU uses this browser paint-opportunity gate, not a decoded-frame
      // claim. Live acceptance independently checks actual cropped host pixels.
      if (phase !== 'loading') return;
      paintFrames++; phase = 'renderable'; timer = nativeInterval(() => { pollDirectories(); publish(); }, 250);
      for (const [name, value] of lastMedia) invoke(callbacks.get(name), { ...value });
      for (const key of directories.keys()) notifyDirectory(key);
      flushRandom(); publish();
    }); });
  };
  const onLoad = () => { loaded = true; start(); };
  window.addEventListener('load', onLoad, { once: true });
  const cleanup = () => {
    for (const pending of controlRequests.values()) { nativeClearTimeout(pending.timer); pending.reject(Error('media_control_unavailable')); }
    controlRequests.clear(); controlSession = ''; controlCommands = [];
    nativeClearInterval(timer); callbacks.clear(); lastMedia.clear(); pendingMedia.clear(); randomRequests.clear();
    for (const record of directories.values()) { record.version++; record.controller?.abort(); nativeClearTimeout?.(record.timeout); }
    directories.clear();
    for (const record of frames.values()) nativeCancelRaf?.(record.nativeId);
    for (const record of tasks.values()) nativeClearTimeout?.(record.nativeId);
    frames.clear(); tasks.clear(); resumeMedia.clear();
    for (const restore of patches) restore();
    window.removeEventListener('message', onMessage); window.removeEventListener('load', onLoad);
    window.removeEventListener('ended', onMediaEnded, true);
    if (webLoopHoldTimer !== null) { nativeClearTimeout(webLoopHoldTimer); webLoopHoldTimer = null; }
    if (singleLoopTimer !== null) { nativeClearInterval(singleLoopTimer); singleLoopTimer = null; }
    for (const media of document.querySelectorAll('audio,video')) { media.pause(); media.removeAttribute('src'); media.load(); }
  };
  const onMessage = (event) => {
    const message = event.data;
    if (!config || event.origin !== config.parentOrigin || event.source !== window.parent
      || message?.source !== 'cwb-web-control' || message.channel !== config.channel || phase === 'released') return;
    if (message.op === 'release') { phase = 'released'; cleanup(); publish(); return; }
    if (message.op === 'mediaControlResult') {
      const pending = controlRequests.get(message.requestId);
      if (pending && typeof message.ok === 'boolean') {
        controlRequests.delete(message.requestId); nativeClearTimeout(pending.timer);
        if (message.ok) pending.resolve(true); else pending.reject(Error('media_control_rejected'));
      }
      return;
    }
    if (phase !== 'renderable') return;
    if (['properties', 'resetProperties'].includes(message.op)) {
      if (Object.hasOwn(message, 'propertyRequest') && (!Number.isSafeInteger(message.propertyRequest) || message.propertyRequest <= 0)) return;
      const patch = window.__cwbValidateProperties(config.authorProperties.schema,
        message.op === 'resetProperties' ? config.authorProperties.values : message.values);
      if (!patch) return;
      Object.assign(properties, patch); propertyRevision++;
      applyProperties(patch);
      const revision = propertyRevision, pending = refreshDirectories(patch);
      if (pending.length) {
        publish();
        void Promise.all(pending).then(() => { if (phase === 'renderable' && propertyRevision === revision) publish(message.propertyRequest); });
        return;
      }
    } else if (['pause', 'resume'].includes(message.op)) {
      playback(message.op === 'pause');
      propertyCall('applyGeneralProperties', { paused }); propertyCall('setPaused', paused);
      if (!paused) { flushMedia(); for (const key of directories.keys()) notifyDirectory(key); flushRandom(); }
      // Functional author timers/rAF and HTML media are suspended. Workers and
      // legacy string timers are not silently advertised as whole-process suspension.
    } else if (message.op === 'loopHold') {
      const seconds = Number(message.value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return;
      webLoopHoldMs = Math.round(seconds) * 1000;
      publish();
      return;
    } else if (message.op === 'forceSingleLoop') {
      forceSingleLoop = message.value === true;
      syncForceSingleLoop();
      publish();
      return;
    } else if (message.op === 'volume') {
      if (typeof message.value !== 'number' || !Number.isFinite(message.value) || message.value < 0 || message.value > 1) return;
      volume = message.value;
      for (const media of document.querySelectorAll('audio,video')) { media.volume = volume; media.muted = paused || volume === 0; }
      propertyCall('applyGeneralProperties', { audiovolume: Math.round(message.value * 100) });
    } else if (message.op === 'readProperties') {
      if (!Number.isSafeInteger(message.propertyRequest) || message.propertyRequest <= 0) return;
    } else if (message.op === 'pointer' || message.op === 'pointerLeave') {
      if (paused || typeof window.MouseEvent !== 'function') return;
      if (message.op === 'pointerLeave') { pointerDown = false; document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); }
      else {
        const { u, v, buttons = 0, mods = 0 } = message;
        if (![u, v].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || ![0, 1].includes(buttons) || !Number.isInteger(mods) || mods < 0 || mods > 15) return;
        const init = { bubbles: true, clientX: u * window.innerWidth, clientY: v * window.innerHeight, buttons,
          shiftKey: !!(mods & 1), ctrlKey: !!(mods & 2), altKey: !!(mods & 4), metaKey: !!(mods & 8) };
        const target = document.elementFromPoint(init.clientX, init.clientY) || document;
        target.dispatchEvent(new window.MouseEvent('mousemove', init));
        if (pointerDown !== (buttons === 1)) target.dispatchEvent(new window.MouseEvent(buttons === 1 ? 'mousedown' : 'mouseup', init));
        pointerDown = buttons === 1;
      }
    } else if (message.op === 'audio') {
      if (paused || !loaded || phase !== 'renderable') return;
      if (!Array.isArray(message.values) || message.values.length !== 128
        || Array.from(message.values).some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) return;
      invoke(callbacks.get('Audio'), message.values.slice());
    } else if (['media', 'mediaStatus', 'mediaThumbnail', 'lyrics', 'mediaCapabilities'].includes(message.op)) {
      let input;
      try { input = window.__cwbValidateWebInput({ op: message.op, value: message.value }); } catch { return; }
      const media = input.value;
      if (input.op === 'lyrics') mediaEvent('Lyrics', media);
      else if (input.op === 'mediaCapabilities') { controlSession = media.sessionId; controlCommands = media.commands.slice(); }
      else if (input.op === 'media') {
        mediaEvent('MediaProperties', { title: media.title, artist: media.artist, album: media.album,
          albumTitle: media.albumTitle ?? media.album, albumArtist: media.albumArtist ?? '', subTitle: media.subTitle ?? '', genres: media.genres ?? '',
          ...(Object.hasOwn(media, 'contentType') ? { contentType: media.contentType } : {}) });
        mediaEvent('MediaPlayback', { state: window.wallpaperMediaIntegration['PLAYBACK_' + media.state.toUpperCase()] });
        mediaEvent('MediaTimeline', { position: media.position, duration: media.duration });
      } else if (input.op === 'mediaThumbnail') mediaEvent('MediaThumbnail', media);
      else {
        mediaEvent('MediaStatus', media);
        if (!media.enabled) {
          controlSession = ''; controlCommands = []; mediaEvent('Lyrics', { text: '', next: '' });
          mediaEvent('MediaProperties', { title: '', artist: '', album: '', albumTitle: '', albumArtist: '', subTitle: '', genres: '' });
          mediaEvent('MediaThumbnail', { thumbnail: '' }); mediaEvent('MediaPlayback', { state: 0 });
          mediaEvent('MediaTimeline', { position: 0, duration: 0 });
        }
      }
    } else return;
    publish(message.propertyRequest);
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', () => { phase = 'released'; cleanup(); }, { once: true });
  void fetch(`/${token}/bridge-config.json`).then((r) => { if (!r.ok) throw Error(); return r.json(); })
    .then((value) => { if (phase === 'released') return; config = value; publish(); start(); })
    .catch(() => { if (phase === 'released') return; phase = 'failed'; cleanup(); window.__cwbWeb = Object.freeze({ phase: 'failed', reason: 'web_bridge_config' }); });
})();
