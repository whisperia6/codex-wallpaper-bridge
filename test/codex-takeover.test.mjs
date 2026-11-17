import test from "node:test";
import assert from "node:assert/strict";
import { createCodexTakeoverWatcher } from "../src/codex-takeover.mjs";

function ordinaryProcess(id = 1) {
  return { processId: id, commandLine: "ChatGPT.exe", mainWindowHandle: 100, mainWindowTitle: "ChatGPT" };
}

test("takeover waits for consecutive ordinary Codex observations", async () => {
  let takeoverCount = 0;
  let intervalCleared = false;
  const timerApi = {
    setInterval: () => 7,
    clearInterval: () => { intervalCleared = true; },
  };
  const watcher = createCodexTakeoverWatcher({
    port: 9335,
    intervalMs: 250,
    timerApi,
    listProcesses: async () => [ordinaryProcess()],
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(takeoverCount, 0);
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();
  assert.equal(intervalCleared, true);
});

test("a debug instance alone never triggers takeover", async () => {
  let takeoverCount = 0;
  const watcher = createCodexTakeoverWatcher({
    port: 9335,
    intervalMs: 250,
    timerApi: { setInterval: () => 8, clearInterval: () => {} },
    listProcesses: async () => [{
      processId: 2,
      commandLine: "ChatGPT.exe --remote-debugging-port=9335",
      mainWindowHandle: 200,
      mainWindowTitle: "ChatGPT",
    }],
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await watcher.poll();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  watcher.stop();
});

test("busy or disabled watcher does not query or take over", async () => {
  let queries = 0;
  const watcher = createCodexTakeoverWatcher({
    port: 9335,
    intervalMs: 250,
    timerApi: { setInterval: () => 9, clearInterval: () => {} },
    isEnabled: () => false,
    listProcesses: async () => { queries += 1; return [ordinaryProcess()]; },
    onTakeover: async () => { throw new Error("should not run"); },
  });
  watcher.start();
  await watcher.poll();
  assert.equal(queries, 0);
  watcher.stop();
  const busyWatcher = createCodexTakeoverWatcher({
    port: 9335,
    intervalMs: 250,
    timerApi: { setInterval: () => 10, clearInterval: () => {} },
    isBusy: () => true,
    listProcesses: async () => { queries += 1; return [ordinaryProcess()]; },
    onTakeover: async () => { throw new Error("should not run"); },
  });
  busyWatcher.start();
  await busyWatcher.poll();
  assert.equal(queries, 0);
  busyWatcher.stop();
});
test("pre-existing ordinary processes are ignored by the baseline", async () => {
  let takeoverCount = 0;
  const watcher = createCodexTakeoverWatcher({
    port: 9335,
    intervalMs: 250,
    ignoredProcessIds: [1],
    timerApi: { setInterval: () => 11, clearInterval: () => {} },
    listProcesses: async () => [ordinaryProcess(1)],
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await watcher.poll();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  watcher.stop();
});
