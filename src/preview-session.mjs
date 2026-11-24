const processStates = new WeakMap();
const DEFAULT_EXIT_TIMEOUT_MS = 15000;

function processError(error) {
  return error instanceof Error
    ? error
    : new Error(error?.report || error?.type || "壁纸控制进程异常");
}

function observeProcess(child) {
  if (!child || typeof child.once !== "function" || typeof child.on !== "function") {
    throw new Error("壁纸控制进程句柄无效");
  }
  let state = processStates.get(child);
  if (state) return state;
  state = { exited: false, exit: null, exits: new Set(), errors: new Set(), stopping: null };
  processStates.set(child, state);
  const onError = (error) => {
    for (const notify of [...state.errors]) notify(processError(error));
  };
  const onExit = (code, signal = null) => {
    state.exited = true;
    state.exit = { code, signal };
    child.removeListener("error", onError);
    for (const notify of [...state.exits]) notify(state.exit);
  };
  // killed only means a signal was sent, and does not exist on UtilityProcess.
  if (child.exitCode != null || child.signalCode != null) {
    onExit(child.exitCode ?? null, child.signalCode ?? null);
  } else {
    child.once("exit", onExit);
    child.on("error", onError);
  }
  return state;
}

function watchExit(state, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("壁纸控制进程退出等待时间必须为正数");
  }
  if (state.exited) return { promise: Promise.resolve(state.exit), cancel: () => {} };
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.exits.delete(onExit);
      state.errors.delete(onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = (result) => finish(null, result);
    const onError = (error) => finish(error);
    cancel = onError;
    state.exits.add(onExit);
    state.errors.add(onError);
    timer = setTimeout(() => finish(new Error(`壁纸控制进程退出等待超时（${timeoutMs} ms）`)), timeoutMs);
  });
  return { promise, cancel };
}

export function waitForPreviewExit(child, { timeoutMs = DEFAULT_EXIT_TIMEOUT_MS } = {}) {
  return watchExit(observeProcess(child), timeoutMs).promise;
}

export function stopPreviewProcess(child, { timeoutMs = DEFAULT_EXIT_TIMEOUT_MS } = {}) {
  const state = observeProcess(child);
  if (state.exited) return Promise.resolve(state.exit);
  if (state.stopping) return state.stopping;
  const waiter = watchExit(state, timeoutMs);
  const graceful = typeof child.postMessage === "function";
  // Install the exit waiter before requesting shutdown, because the adapter may
  // emit exit synchronously. UtilityProcess.kill can forcibly terminate Windows
  // workers and bypass CLI cleanup, so use its controlled parent message instead.
  try {
    if (graceful) {
      child.postMessage({ channel: "cwb-utility", action: "shutdown" });
    } else {
      if (typeof child.kill !== "function") throw new Error("壁纸控制进程不支持停止");
      if (child.kill() === false && !state.exited) {
        waiter.cancel(new Error("壁纸控制进程拒绝停止请求"));
      }
    }
  } catch (error) {
    waiter.cancel(processError(error));
  }
  state.stopping = waiter.promise.then((exit) => {
    if (graceful && exit.code !== 0) {
      const error = new Error(`壁纸控制进程清理失败（退出码 ${exit.code}）`);
      error.exit = exit;
      throw error;
    }
    return exit;
  }).finally(() => { state.stopping = null; });
  return state.stopping;
}

function shutdownError() {
  return new Error("应用正在退出，壁纸控制会话已关闭");
}

/**
 * start(port, { onChild }) must report its child synchronously after spawning.
 * That lets failed/unfinished starts be cleaned up and observes UtilityProcess
 * exits before its startup Promise settles. Returning { child, url } alone is
 * supported, but cannot reveal an earlier exit on a process without exitCode.
 * An injected stop(child) must resolve only after the process has emitted exit.
 */
export function createPreviewSession({
  start,
  stop = stopPreviewProcess,
  validateUrl,
  onDisconnected = () => {},
}) {
  if (typeof start !== "function" || typeof stop !== "function" || typeof validateUrl !== "function") {
    throw new Error("壁纸控制会话需要 start、stop 和 validateUrl 函数");
  }
  let current = null;
  let sealed = false;
  let pendingCloses = 0;
  let queue = Promise.resolve();
  const owned = new Map();

  const enqueue = (operation) => {
    const result = queue.then(operation);
    // A rejected operation must not poison retries or queued cleanup.
    queue = result.catch(() => {});
    return result;
  };

  function forget(record) {
    owned.delete(record.child);
    record.child.removeListener("exit", record.onExit);
    if (current === record) current = null;
  }

  function own(child, port) {
    const previous = owned.get(child);
    if (previous) return previous;
    const state = observeProcess(child);
    const record = { child, port, state, url: null, active: false, intentional: false, onExit: null };
    record.onExit = (code, signal = null) => {
      const disconnected = current === record && record.active && !record.intentional && !sealed && pendingCloses === 0;
      forget(record);
      if (disconnected) {
        // Notifications do not own process lifecycle and cannot break cleanup.
        try {
          Promise.resolve(onDisconnected({ port: record.port, url: record.url, code, signal })).catch(() => {});
        } catch {}
      }
    };
    if (!state.exited) {
      owned.set(child, record);
      child.once("exit", record.onExit);
    }
    return record;
  }

  async function releaseOwned() {
    current = null;
    for (const record of [...owned.values()]) {
      record.intentional = true;
      if (!record.state.exited) await stop(record.child);
      if (!record.state.exited) throw new Error("壁纸控制进程尚未确认退出，保留句柄以便重试清理");
      forget(record);
    }
  }

  async function ensureAtPort(port) {
    if (sealed) throw shutdownError();
    if (current && !current.state.exited && current.port === port) {
      return { url: current.url, reused: true };
    }
    // A timed-out/failed stop remains owned. No replacement can start until
    // its actual exit is observed or a later cleanup succeeds.
    await releaseOwned();
    if (sealed) throw shutdownError();
    let reported = null;
    try {
      const preview = await start(port, {
        onChild: (child) => {
          const record = own(child, port);
          if (reported && reported.child !== child) throw new Error("壁纸控制启动报告了多个进程");
          reported = record;
        },
      });
      const record = own(preview?.child, port);
      if (reported && reported.child !== record.child) throw new Error("壁纸控制启动返回了不同进程");
      const url = await validateUrl(preview.url);
      if (typeof url !== "string" || !url) throw new Error("壁纸控制页地址无效");
      if (sealed) throw shutdownError();
      if (record.state.exited) throw new Error("壁纸控制进程在启动完成前已退出");
      record.url = url;
      record.active = true;
      current = record;
      return { url, reused: false };
    } catch (error) {
      try {
        await releaseOwned();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}；壁纸控制进程清理失败：${cleanupError.message}`);
      }
      throw error;
    }
  }

  return {
    ensure(port) {
      if (sealed) return Promise.reject(shutdownError());
      const normalized = Number(port);
      if (!Number.isInteger(normalized) || normalized < 1024 || normalized > 65535) {
        return Promise.reject(new Error("CDP 端口必须在 1024 到 65535 之间"));
      }
      return enqueue(() => ensureAtPort(normalized));
    },
    close() {
      // Suppress reconnect requests as soon as an intentional close is queued,
      // including an exit between this call and its cleanup operation.
      pendingCloses += 1;
      return enqueue(async () => {
        try {
          await releaseOwned();
        } finally {
          pendingCloses -= 1;
        }
      });
    },
    shutdown() {
      // Sealing happens at submission, not when shutdown reaches the queue.
      sealed = true;
      return enqueue(releaseOwned);
    },
  };
}
