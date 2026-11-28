export { resolvePlayback } from './playback-policy.mjs';
/** WAAPI transitions shared by preview and injected renderer; self-contained for CDP. */
export function runMediaTransition(next, before, options = {}) {
  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const document = globalThis.document;
  const kinds = ['cut', 'fade', 'push', 'wipe', 'iris', 'zoom', 'stripes'];
  const kind = !kinds.includes(options.transition) || options.reduceMotion || motion?.matches || document?.hidden
    ? 'cut' : options.transition;
  next.node.dataset.cwbTransition = kind;
  if (kind === 'cut' || !next.node.animate) return null;
  const direction = ['left', 'right', 'up', 'down'].includes(options.transitionDirection) ? options.transitionDirection : 'left';
  const duration = Math.min(3000, Math.max(100, Number(options.transitionDurationMs) || 600));
  const timing = { duration, easing: 'ease-in-out', fill: 'both' };
  const opacity = Number(globalThis.getComputedStyle?.(next.node)?.opacity ?? 1);
  const animations = [];
  const animate = (node, frames) => animations.push(node.animate(frames, timing));
  const offset = { left: ['100% 0', '-100% 0'], right: ['-100% 0', '100% 0'], up: ['0 100%', '0 -100%'], down: ['0 -100%', '0 100%'] }[direction];
  const edge = { left: '0 0 0 100%', right: '0 100% 0 0', up: '100% 0 0 0', down: '0 0 100% 0' }[direction];
  const origin = { left: '100% 50%', right: '0% 50%', up: '50% 100%', down: '50% 0%' }[direction];
  if (kind === 'fade') animate(next.node, [{ opacity: 0 }, { opacity }]);
  if (kind === 'push') {
    // Individual translate/scale properties compose with the existing crop/zoom/mirror transform.
    animate(next.node, [{ translate: offset[0] }, { translate: '0 0' }]);
    animate(before.node, [{ translate: '0 0' }, { translate: offset[1] }]);
  }
  if (kind === 'wipe') animate(next.node, [{ clipPath: `inset(${edge})` }, { clipPath: 'inset(0 0 0 0)' }]);
  if (kind === 'iris') animate(next.node, [{ clipPath: `circle(0% at ${origin})` }, { clipPath: `circle(150% at ${origin})` }]);
  if (kind === 'zoom') animate(next.node, [{ scale: '.86', opacity: 0 }, { scale: '1', opacity }]);
  if (kind === 'stripes') {
    const horizontal = direction === 'up' || direction === 'down';
    const reverse = direction === 'right' || direction === 'down';
    const polygon = (progress) => {
      const points = [];
      for (let i = 0; i < 8; i++) {
        const start = i * 12.5, end = (i + 1) * 12.5;
        const a = reverse ? end - 12.5 * progress : start;
        const b = reverse ? end : start + 12.5 * progress;
        const rectangle = horizontal ? [[0, a], [100, a], [100, b], [0, b], [0, a]]
          : [[a, 0], [b, 0], [b, 100], [a, 100], [a, 0]];
        points.push(...rectangle.map(([x, y]) => `${x}% ${y}%`));
      }
      return `polygon(evenodd, ${points.join(', ')})`;
    };
    animate(next.node, [{ clipPath: polygon(0) }, { clipPath: polygon(1) }]);
  }
  let interrupted, cancelled = false;
  const interruption = new Promise((resolve) => { interrupted = resolve; });
  const cleanup = () => {
    motion?.removeEventListener?.('change', onMotion);
    document?.removeEventListener?.('visibilitychange', onVisibility);
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true; cleanup(); interrupted();
    for (const animation of animations) animation.cancel();
  };
  const onMotion = (event) => { if (event.matches) cancel(); };
  const onVisibility = () => { if (document.hidden) cancel(); };
  motion?.addEventListener?.('change', onMotion);
  document?.addEventListener?.('visibilitychange', onVisibility);
  // Hidden documents may suspend WAAPI indefinitely. Complete the transition
  // without changing playback intent or bypassing the candidate's ready gate.
  return { finished: Promise.race([Promise.all(animations.map((animation) => animation.finished)), interruption]).finally(cleanup), cancel };
}

/** Shared prepare/commit/cancel state machine. Self-contained for CDP serialization. */
export function createMediaSwitcher({ create, commit, dispose, transition = null, timeoutMs = 5000, maxLoadTimeoutMs = 90000 }) {
  let revision = 0;
  let active = null;
  let pending = null;
  let retired = null;
  let animation = null;
  let closed = false;
  let state = 'idle';
  let error = null;
  const finishAnimation = () => {
    animation?.cancel?.();
    animation = null;
    if (retired) dispose(retired);
    retired = null;
  };
  const cancel = () => {
    revision++;
    if (pending) {
      clearTimeout(pending.timer);
      pending.abort();
      dispose(pending.slot);
      pending = null;
    }
    finishAnimation();
    state = active ? 'ready' : 'idle';
  };
  const prepare = (value, identity, { force = false, loadTimeoutMs } = {}) => {
    if (closed) throw new Error('Media switcher is closed');
    if (active?.identity === identity && !force) {
      cancel();
      active.update?.(value);
      return { identity, reused: true, ready: Promise.resolve({ ok: true, reused: true }) };
    }
    // A previously prepared candidate is the actual next scene. Keep its
    // iframe/context and first-frame promise instead of cancelling/reloading.
    if (pending?.identity === identity && !force) {
      pending.slot.update?.(value);
      return pending;
    }
    cancel();
    error = null;
    state = 'preparing';
    const handle = { revision, identity, slot: null, timer: null, abort: null };
    let abort;
    const interrupted = new Promise((resolve) => { abort = () => resolve({ cancelled: true }); });
    handle.abort = abort;
    // Register pending before creating media: synchronous factory errors cannot leak state.
    pending = handle;
    try {
      handle.slot = create(value, { revision, initial: !active });
      handle.slot.identity = identity;
    } catch (failure) {
      pending = null;
      state = active ? 'ready' : 'error';
      error = failure?.message || 'Media preparation failed';
      handle.ready = Promise.resolve({ ok: false, error });
      return handle;
    }
    const timeout = new Promise((resolve) => {
      const duration = Number.isFinite(loadTimeoutMs) && loadTimeoutMs > 0 && loadTimeoutMs <= maxLoadTimeoutMs ? loadTimeoutMs : timeoutMs;
      handle.timer = setTimeout(() => resolve({ error: 'Media load timed out' }), duration);
    });
    const loaded = Promise.resolve(handle.slot.ready).then(() => ({ ok: true }),
      () => ({ error: 'Media failed to load or decode' }));
    handle.ready = Promise.race([loaded, interrupted, timeout]).then((result) => {
      clearTimeout(handle.timer);
      if (result.cancelled || pending !== handle || revision !== handle.revision) return { ok: false, cancelled: true };
      if (!result.ok) {
        pending = null;
        dispose(handle.slot);
        error = result.error;
        state = active ? 'ready' : 'error';
        return { ok: false, error };
      }
      return result;
    });
    return handle;
  };
  const commitPrepared = async (handle, options) => {
    const result = await handle.ready;
    if (!result.ok || handle.reused) return result;
    if (!closed && handle.committed && active === handle.slot) return { ok: true, identity: handle.identity, reused: true };
    if (closed || pending !== handle || revision !== handle.revision) return { ok: false, cancelled: true };
    const before = active;
    try { commit(handle.slot, before); }
    catch {
      pending = null;
      dispose(handle.slot);
      error = 'Media commit failed';
      state = active ? 'ready' : 'error';
      return { ok: false, error };
    }
    active = handle.slot;
    handle.committed = true;
    pending = null;
    state = 'ready';
    if (before && transition) {
      retired = before;
      try { animation = transition(active, before, options); }
      catch { animation = null; }
      if (animation?.finished) {
        const run = animation;
        Promise.resolve(run.finished).catch(() => {}).then(() => {
          if (animation === run) finishAnimation();
        });
      } else finishAnimation();
    } else if (before) dispose(before);
    return { ok: true, identity: handle.identity };
  };
  return {
    prepare,
    commit: commitPrepared,
    cancel,
    switchTo: (value, identity, options) => commitPrepared(prepare(value, identity, options), options),
    update: (value) => { active?.update?.(value); pending?.slot?.update?.(value); },
    finishTransition: finishAnimation,
    clear: () => { cancel(); if (active) dispose(active); active = null; state = 'idle'; error = null; },
    close() { this.clear(); closed = true; },
    status: () => ({ state, error, revision, identity: active?.identity ?? null,
      requestedIdentity: pending?.identity ?? null, transitioning: Boolean(animation), slots: Number(Boolean(active)) + Number(Boolean(pending)) + Number(Boolean(retired)) }),
  };
}
