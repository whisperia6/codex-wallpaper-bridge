import test from "node:test";
import assert from "node:assert/strict";
import { createCodexTakeoverWatcher } from "../src/codex-takeover.mjs";

const PORT = 9335;
const NOW = 10_000;

function ordinaryProcess(id = 1, mainWindowHandle = 100) {
  return {
    processId: id,
    commandLine: "C:\\fixture\\ChatGPT.exe",
    mainWindowHandle,
    mainWindowTitle: "ChatGPT",
  };
}

function debugProcess(id = 9, port = PORT, mainWindowHandle = 100) {
  return {
    processId: id,
    commandLine: `C:\\fixture\\ChatGPT.exe --remote-debugging-port=${port}`,
    mainWindowHandle,
    mainWindowTitle: "ChatGPT",
  };
}

function snapshot(sequence, processes, capturedAt = NOW) {
  return { sequence, capturedAt, processes };
}

function queuedSnapshots(items) {
  let index = 0;
  return async () => items[Math.min(index++, items.length - 1)];
}

function timerApi() {
  let cleared = false;
  return {
    setInterval: () => 1,
    clearInterval: () => { cleared = true; },
    wasCleared: () => cleared,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a rejected query from a stopped generation cannot report an error into its replacement', async () => {
  let rejectQuery, errors = 0;
  const watcher = createWatcher({
    listProcesses: () => new Promise((_, reject) => { rejectQuery = reject; }),
    onError: () => { errors++; },
  });
  watcher.start(); watcher.stop(); watcher.start();
  rejectQuery(new Error('old query failed')); await flush();
  assert.equal(errors, 0); assert.equal(watcher.status().running, true);
  watcher.stop();
});

function createWatcher(options) {
  return createCodexTakeoverWatcher({
    port: PORT,
    intervalMs: 250,
    now: () => NOW,
    timerApi: timerApi(),
    onTakeover: async () => {},
    ...options,
  });
}

test("takeover waits for consecutive fresh observations", async () => {
  let takeoverCount = 0;
  const timers = timerApi();
  const watcher = createWatcher({
    timerApi: timers,
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()]),
      snapshot(2, [ordinaryProcess()]),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  assert.equal(takeoverCount, 0);
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();
  assert.equal(timers.wasCleared(), true);
});

test("duplicate sequence numbers do not accumulate consecutive observations", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()]),
      snapshot(1, [ordinaryProcess()]),
      snapshot(1, [ordinaryProcess()]),
      snapshot(2, [ordinaryProcess()]),
      snapshot(3, [ordinaryProcess()]),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  await watcher.poll();
  assert.equal(takeoverCount, 0, "the first fresh observation after duplicates only starts the streak");
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();
});

test("expired and future snapshots reset the consecutive observation", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()], NOW),
      snapshot(2, [ordinaryProcess()], NOW - 7_001),
      snapshot(3, [ordinaryProcess()], NOW),
      snapshot(4, [ordinaryProcess()], NOW),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  await watcher.poll();
  assert.equal(takeoverCount, 0, "an expired snapshot must not complete the streak");
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();

  let futureTakeovers = 0;
  const futureWatcher = createWatcher({
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()], NOW + 1),
      snapshot(2, [ordinaryProcess()], NOW),
      snapshot(3, [ordinaryProcess()], NOW),
    ]),
    onTakeover: async () => { futureTakeovers += 1; },
  });
  futureWatcher.start();
  await flush();
  await futureWatcher.poll();
  assert.equal(futureTakeovers, 0, "a future-captured snapshot is not fresh evidence");
  await futureWatcher.poll();
  assert.equal(futureTakeovers, 1);
  futureWatcher.stop();
});

test("a snapshot exactly at the age limit is still accepted", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()], NOW - 7_000),
      snapshot(2, [ordinaryProcess()], NOW - 7_000),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();
});

test("busy or disabled intervals reset consecutive observations", async () => {
  let busy = false;
  let enabled = true;
  let queries = 0;
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 2,
    isEnabled: () => enabled,
    isBusy: () => busy,
    listProcesses: async () => {
      queries += 1;
      return snapshot(queries, [ordinaryProcess()]);
    },
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  assert.equal(queries, 1);
  busy = true;
  await watcher.poll();
  assert.equal(queries, 1, "a busy interval must not query");
  busy = false;
  await watcher.poll();
  assert.equal(takeoverCount, 0, "the busy interval reset the streak");
  await watcher.poll();
  assert.equal(takeoverCount, 1);

  enabled = false;
  await watcher.poll();
  assert.equal(queries, 3);
  enabled = true;
  await watcher.poll();
  assert.equal(takeoverCount, 1, "disabled intervals also reset the streak");
  await watcher.poll();
  assert.equal(takeoverCount, 2);
  watcher.stop();
});

test("visibility is re-checked after the process query resolves", async () => {
  let release;
  let enabled = true;
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    isEnabled: () => enabled,
    listProcesses: () => new Promise((resolve) => { release = resolve; }),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  enabled = false;
  release(snapshot(1, [ordinaryProcess()]));
  await flush();
  assert.equal(takeoverCount, 0);
  assert.equal(watcher.status().consecutiveOrdinary, 0);
  watcher.stop();
});

test("busy state is re-checked after the process query resolves", async () => {
  let release;
  let busy = false;
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    isBusy: () => busy,
    listProcesses: () => new Promise((resolve) => { release = resolve; }),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  busy = true;
  release(snapshot(1, [ordinaryProcess()]));
  await flush();
  assert.equal(takeoverCount, 0);
  assert.equal(watcher.status().consecutiveOrdinary, 0);
  watcher.stop();
});

test("a stop during an in-flight query discards the result", async () => {
  let release;
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: () => new Promise((resolve) => { release = resolve; }),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  watcher.stop();
  release(snapshot(1, [ordinaryProcess()]));
  await flush();
  assert.equal(takeoverCount, 0);
  assert.equal(watcher.status().running, false);
});

test("stop/start generations discard results from the previous run", async () => {
  const releases = [];
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: () => new Promise((resolve) => { releases.push(resolve); }),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  assert.equal(releases.length, 1);
  watcher.stop();
  watcher.start();
  await flush();
  releases[0](snapshot(1, [ordinaryProcess()]));
  await flush();
  assert.equal(takeoverCount, 0, "the pre-restart result must not take over");
  const pendingPoll = watcher.poll();
  await flush();
  assert.equal(releases.length, 2);
  releases[1](snapshot(2, [ordinaryProcess()]));
  await pendingPoll;
  assert.equal(takeoverCount, 1);
  watcher.stop();
});

test("a failed takeover stops the watcher and is not retried", async () => {
  let attempts = 0;
  const errors = [];
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess()]),
      snapshot(2, [ordinaryProcess()]),
    ]),
    onTakeover: async () => {
      attempts += 1;
      throw new Error("takeover boom");
    },
    onError: (error) => errors.push(error.message),
  });
  watcher.start();
  await flush();
  assert.equal(attempts, 1);
  assert.deepEqual(errors, ["takeover boom"]);
  assert.equal(watcher.status().running, false);
  await watcher.poll();
  await flush();
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
});

test("only windowed, non-baseline ordinary instances are candidates", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    ignoredProcessIds: [2],
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess(1, 0), ordinaryProcess(2, 100)]),
      snapshot(2, [ordinaryProcess(1, 0), ordinaryProcess(2, 100)]),
      snapshot(3, [ordinaryProcess(3, 100)]),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  await watcher.poll();
  assert.equal(takeoverCount, 1);
  watcher.stop();
});

test("consecutive observations must share the same candidate PID set", async () => {
  const takenOverWith = [];
  const watcher = createWatcher({
    requiredConsecutive: 2,
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess(1)]),
      snapshot(2, [ordinaryProcess(1), ordinaryProcess(2)]),
      snapshot(3, [ordinaryProcess(1), ordinaryProcess(2)]),
    ]),
    onTakeover: async ({ ordinary }) => { takenOverWith.push(ordinary.map(({ processId }) => processId)); },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takenOverWith.length, 0, "a changing PID set restarts the streak");
  await watcher.poll();
  assert.deepEqual(takenOverWith, [[1, 2]]);
  watcher.stop();
});

test("mixed debug and ordinary instances are skipped conservatively, including other ports", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess(1), debugProcess(9, 9444)]),
      snapshot(2, [ordinaryProcess(1), debugProcess(9, 9444)]),
      snapshot(3, [ordinaryProcess(1)]),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 0, "a foreign debug instance must block an automatic close");
  await watcher.poll();
  assert.equal(takeoverCount, 1, "the watcher recovers once the foreign debug instance disappears");
  watcher.stop();
});

test("a debug instance on the managed port also blocks takeover", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: queuedSnapshots([
      snapshot(1, [ordinaryProcess(1), debugProcess(9, PORT)]),
      snapshot(2, [ordinaryProcess(1), debugProcess(9, PORT)]),
      snapshot(3, [ordinaryProcess(1)]),
    ]),
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 0, "any debug parameter must block an automatic close");
  await watcher.poll();
  assert.equal(takeoverCount, 1, "the watcher recovers once the debug instance disappears");
  watcher.stop();
});

test("bare arrays are not accepted as monitor snapshots", async () => {
  let takeoverCount = 0;
  const watcher = createWatcher({
    requiredConsecutive: 1,
    listProcesses: async () => [ordinaryProcess()],
    onTakeover: async () => { takeoverCount += 1; },
  });
  watcher.start();
  await flush();
  await watcher.poll();
  assert.equal(takeoverCount, 0);
  watcher.stop();
});
