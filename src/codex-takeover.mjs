import {
  classifyCodexProcesses,
  hasAnyCodexDebugPort,
} from "./codex-processes.mjs";

const DEFAULT_MAX_SNAPSHOT_AGE_MS = 7_000;

/**
 * Watches for a Codex window launched in ordinary (non-debug) mode while the
 * managed wallpaper is active. The caller owns closing/relaunching; this class
 * only debounces process observations and serializes takeover attempts.
 *
 * `listProcesses` must return the monitor snapshot object
 * `{ sequence, capturedAt, processes }` (or null). Bare process arrays are
 * rejected so duplicate or stale monitor output cannot masquerade as a fresh
 * observation.
 */
export function createCodexTakeoverWatcher({
  listProcesses,
  port,
  onTakeover,
  onError = () => {},
  isEnabled = () => true,
  isBusy = () => false,
  intervalMs = 2_500,
  requiredConsecutive = 2,
  ignoredProcessIds = [],
  timerApi = globalThis,
  now = Date.now,
  maxSnapshotAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS,
} = {}) {
  if (typeof listProcesses !== "function") throw new TypeError("缺少 Codex 进程查询函数");
  if (typeof onTakeover !== "function") throw new TypeError("缺少自动接管函数");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("CDP 端口无效");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new TypeError("自动接管轮询间隔无效");
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 1) throw new TypeError("自动接管确认次数无效");
  if (typeof now !== "function") throw new TypeError("自动接管时间函数无效");
  if (!Number.isFinite(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0) throw new TypeError("自动接管快照有效期无效");

  let timer = null;
  let polling = false;
  let stopped = true;
  let generation = 0;
  let consecutiveOrdinary = 0;
  let lastCandidateKey = null;
  let lastSequence = null;
  let lastError = null;
  let takeovers = 0;
  const ignoredIds = new Set(
    (Array.isArray(ignoredProcessIds) ? ignoredProcessIds : [])
      .map(Number)
      .filter((processId) => Number.isInteger(processId) && processId > 0),
  );

  function resetObservation() {
    consecutiveOrdinary = 0;
    lastCandidateKey = null;
  }

  function evaluateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return { reset: true, reason: "missing" };
    }
    const sequence = snapshot.sequence;
    if (!Number.isInteger(sequence) || sequence < 0) {
      return { reset: true, reason: "invalid-sequence" };
    }
    if (lastSequence !== null && sequence <= lastSequence) {
      return { reset: true, reason: "duplicate-sequence" };
    }
    const capturedAt = Number(snapshot.capturedAt);
    if (!Number.isFinite(capturedAt)) {
      return { reset: true, reason: "invalid-timestamp" };
    }
    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) {
      return { reset: true, reason: "invalid-clock" };
    }
    if (capturedAt > currentTime) {
      return { reset: true, reason: "future-timestamp" };
    }
    if (currentTime - capturedAt > maxSnapshotAgeMs) {
      return { reset: true, reason: "expired" };
    }
    // Only this freshly consumed sequence may contribute evidence.
    lastSequence = sequence;

    const processes = Array.isArray(snapshot.processes) ? snapshot.processes.filter(Boolean) : [];
    if (processes.length === 0) {
      return { reset: true, reason: "empty" };
    }
    const anyDebug = processes.some((process) => hasAnyCodexDebugPort(process.commandLine));
    if (anyDebug) {
      return { reset: true, reason: "debug" };
    }
    // Only windowed, non-baseline ordinary instances are candidates. A debug
    // parameter anywhere in the snapshot (including the managed port or a
    // different one) already returned above, so no close can hit an instance
    // whose ownership is ambiguous.
    const { ordinary } = classifyCodexProcesses(processes, port);
    const candidates = ordinary.filter((process) => {
      const processId = Number(process.processId);
      if (!Number.isInteger(processId) || processId <= 0) return false;
      if (ignoredIds.has(processId)) return false;
      return Number(process.mainWindowHandle) > 0;
    });
    if (candidates.length === 0) {
      return { reset: true, reason: "no-candidates" };
    }
    return { reset: false, ordinary: candidates };
  }

  async function poll() {
    if (stopped) return { skipped: true, reason: "stopped" };
    if (polling) return { skipped: true, reason: "polling" };
    polling = true;
    const generationAtStart = generation;
    let takeoverAttempted = false;
    try {
      if (!isEnabled()) {
        resetObservation();
        return { skipped: true, reason: "disabled" };
      }
      if (isBusy()) {
        resetObservation();
        return { skipped: true, reason: "busy" };
      }
      const snapshot = await listProcesses();
      // The caller may stop, restart, disable or become busy while the query
      // is in flight. Such results are stale and must not count as evidence.
      if (stopped || generation !== generationAtStart) {
        return { skipped: true, reason: "superseded" };
      }
      if (!isEnabled()) {
        resetObservation();
        return { skipped: true, reason: "disabled" };
      }
      if (isBusy()) {
        resetObservation();
        return { skipped: true, reason: "busy" };
      }

      const evaluation = evaluateSnapshot(snapshot);
      if (evaluation.reset) {
        resetObservation();
        return { skipped: true, reason: evaluation.reason };
      }

      const { ordinary } = evaluation;
      const candidateKey = ordinary
        .map((process) => Number(process.processId))
        .sort((left, right) => left - right)
        .join(",");
      if (candidateKey !== lastCandidateKey) {
        lastCandidateKey = candidateKey;
        consecutiveOrdinary = 1;
      } else {
        consecutiveOrdinary += 1;
      }
      if (consecutiveOrdinary < requiredConsecutive) {
        return { ordinary: ordinary.length, pending: true };
      }

      takeoverAttempted = true;
      await onTakeover({
        processes: Array.isArray(snapshot.processes) ? snapshot.processes : [],
        ordinary,
        sequence: snapshot.sequence,
        capturedAt: snapshot.capturedAt,
      });
      takeovers += 1;
      lastError = null;
      resetObservation();
      return { ordinary: ordinary.length, takenOver: true };
    } catch (error) {
      if (stopped || generation !== generationAtStart) {
        return { skipped: true, reason: "superseded" };
      }
      resetObservation();
      lastError = error;
      // A failing takeover must not be retried forever; stop the watcher and
      // surface the failure exactly once.
      if (takeoverAttempted) stop();
      try { onError(error); } catch {}
      return { error: error.message };
    } finally {
      polling = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    generation += 1;
    void poll();
    timer = timerApi.setInterval(() => { void poll(); }, intervalMs);
  }

  function stop() {
    stopped = true;
    generation += 1;
    if (timer !== null) timerApi.clearInterval(timer);
    timer = null;
    resetObservation();
  }

  return {
    start,
    stop,
    poll,
    status: () => ({
      running: !stopped,
      polling,
      consecutiveOrdinary,
      takeovers,
      lastSequence,
      lastError: lastError?.message || null,
    }),
  };
}
