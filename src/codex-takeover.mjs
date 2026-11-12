import { classifyCodexProcesses } from "./codex-processes.mjs";

/**
 * Watches for a Codex window launched in ordinary (non-debug) mode while the
 * managed wallpaper is active. The caller owns closing/relaunching; this class
 * only debounces process observations and serializes takeover attempts.
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
} = {}) {
  if (typeof listProcesses !== "function") throw new TypeError("缺少 Codex 进程查询函数");
  if (typeof onTakeover !== "function") throw new TypeError("缺少自动接管函数");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("CDP 端口无效");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new TypeError("自动接管轮询间隔无效");
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 1) throw new TypeError("自动接管确认次数无效");

  let timer = null;
  let polling = false;
  let stopped = true;
  let consecutiveOrdinary = 0;
  let lastError = null;
  let takeovers = 0;
  const ignoredIds = new Set(ignoredProcessIds);

  async function poll() {
    if (stopped || polling || !isEnabled() || isBusy()) return { skipped: true };
    polling = true;
    try {
      const processes = await listProcesses();
      const { ordinary } = classifyCodexProcesses(processes, port);
      const newOrdinary = ordinary.filter((process) => !ignoredIds.has(Number(process.processId)));
      if (newOrdinary.length === 0) {
        consecutiveOrdinary = 0;
        return { ordinary: 0, pending: false };
      }
      consecutiveOrdinary += 1;
      if (consecutiveOrdinary < requiredConsecutive) {
        return { ordinary: newOrdinary.length, pending: true };
      }
      consecutiveOrdinary = 0;
      takeovers += 1;
      await onTakeover({ processes, ordinary: newOrdinary });
      lastError = null;
      return { ordinary: newOrdinary.length, takenOver: true };
    } catch (error) {
      consecutiveOrdinary = 0;
      lastError = error;
      try { onError(error); } catch {}
      return { error: error.message };
    } finally {
      polling = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void poll();
    timer = timerApi.setInterval(() => { void poll(); }, intervalMs);
  }

  function stop() {
    stopped = true;
    if (timer !== null) timerApi.clearInterval(timer);
    timer = null;
    consecutiveOrdinary = 0;
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
      lastError: lastError?.message || null,
    }),
  };
}