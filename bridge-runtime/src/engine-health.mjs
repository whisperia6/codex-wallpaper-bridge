export const SCENE_MAX_FIRST_FRAME_TIMEOUT_MS = 120_000;
export const SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS = SCENE_MAX_FIRST_FRAME_TIMEOUT_MS + 5_000;
export const SCENE_SERVER_START_TIMEOUT_MS = 15_000;
export const NATIVE_SCENE_READY_TIMEOUT_MS = SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS + SCENE_SERVER_START_TIMEOUT_MS + 5_000;
export const NATIVE_SCENE_APPLY_TIMEOUT_MS = NATIVE_SCENE_READY_TIMEOUT_MS + 5_000;
export const WALLPAPER_APPLY_REQUEST_TIMEOUT_MS = NATIVE_SCENE_APPLY_TIMEOUT_MS + 10_000;
const REASONS = new Set(['first_frame_timeout', 'heartbeat_timeout', 'engine_failed', 'context_lost', 'transport_failed']);

/** Session-scoped bounded failures. A user retry, not an automatic load loop, clears an entry. */
export class EngineFailureMemory {
  #entries = new Map();
  #capacity;
  constructor(capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new TypeError('invalid failure capacity');
    this.#capacity = capacity;
  }
  get(identity) { const value = this.#entries.get(identity); return value ? { ...value } : null; }
  remember(identity, reason) {
    if (typeof identity !== 'string' || !identity || identity.length > 256) throw new TypeError('invalid engine identity');
    this.#entries.delete(identity);
    this.#entries.set(identity, { reason: REASONS.has(reason) ? reason : 'engine_failed' });
    if (this.#entries.size > this.#capacity) this.#entries.delete(this.#entries.keys().next().value);
  }
  retry(identity) { this.#entries.delete(identity); }
}

/** Readiness adapter only; selection/commit/cancel remains the existing M1 media switcher. */
export function createEngineHealthGate({ identity, origin, source, channel, messageSource = 'cwb-scene', now = Date.now,
  firstFrameTimeoutMs = 15000, heartbeatTimeoutMs = 2500, failures = new EngineFailureMemory(), onRelease = () => {} }) {
  const firstFrameLimit = messageSource === 'cwb-scene' ? SCENE_OWNER_FIRST_FRAME_TIMEOUT_MS : 90_000;
  if (typeof identity !== 'string' || !identity || identity.length > 256 || typeof channel !== 'string' || !channel
    || !source || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !['cwb-scene', 'cwb-web'].includes(messageSource)
    || !Number.isFinite(firstFrameTimeoutMs) || firstFrameTimeoutMs <= 0 || firstFrameTimeoutMs > firstFrameLimit
    || !Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0 || heartbeatTimeoutMs > 90_000) throw new TypeError('invalid engine health context');
  const started = now();
  let phase = 'loading', reason = null, sequence = 0, frameSequence = 0, lastHeartbeat = started;
  let engineReady = false, actualFrame = false, released = false, settled = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Cancellation may precede the consumer attaching to a pending candidate.
  ready.catch(() => {});
  const releaseResources = () => { if (!released) { released = true; onRelease(); } };
  const fail = (code) => {
    if (phase === 'failed' || phase === 'released') return;
    reason = REASONS.has(code) ? code : 'engine_failed'; phase = 'failed'; failures.remember(identity, reason);
    if (!settled) { settled = true; rejectReady(new Error(reason)); }
    releaseResources();
  };
  const maybeReady = () => {
    if (phase === 'loading' && engineReady && actualFrame) { phase = 'ready'; settled = true; resolveReady(); }
  };
  const cached = failures.get(identity);
  if (cached) fail(cached.reason);
  return {
    ready,
    receive(event) {
      if (phase === 'failed' || phase === 'released' || event?.origin !== origin || event.source !== source) return false;
      const message = event.data;
      if (message?.source !== messageSource || message.channel !== channel
        || !Number.isSafeInteger(message.sequence) || message.sequence <= sequence
        || !['loading', 'ready', 'renderable', 'failed', 'released'].includes(message.phase)) return false;
      sequence = message.sequence; lastHeartbeat = now();
      if (message.phase === 'failed') fail('engine_failed');
      else if (message.phase === 'released') fail('context_lost');
      else { engineReady = ['ready', 'renderable'].includes(message.phase); maybeReady(); }
      return true;
    },
    // Only the trusted capture/decoder invokes this. Author postMessage is never a frame proof.
    frame(frame) {
      if (phase === 'failed' || phase === 'released' || frame?.decoded !== true
        || ![frame.width, frame.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
        || !Number.isSafeInteger(frame.sequence) || frame.sequence <= frameSequence) return false;
      frameSequence = frame.sequence; actualFrame = true; maybeReady(); return true;
    },
    check() {
      if (phase === 'loading' && now() - started > firstFrameTimeoutMs) fail('first_frame_timeout');
      else if (phase === 'ready' && now() - lastHeartbeat > heartbeatTimeoutMs) fail('heartbeat_timeout');
    },
    fail,
    release() {
      if (phase === 'released') return;
      if (!settled) { settled = true; rejectReady(new Error('engine_cancelled')); }
      phase = 'released'; releaseResources();
    },
    status: () => ({ phase, reason, sequence, frameSequence, actualFrame }),
  };
}

/** Descriptors are supplied by trusted resource lookup; this does not authorize paths or URLs. */
export function selectEngineFallback({ embeddedVideo, actualFrame, customStatic, preview } = {}) {
  for (const [reason, value] of [['embedded_video', embeddedVideo], ['actual_frame', actualFrame],
    ['custom_static', customStatic], ['preview', preview]]) if (value) return { reason, value };
  return { reason: 'empty', value: null };
}
