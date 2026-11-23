import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startCodexProcessMonitor } from "../src/codex-process-monitor.mjs";

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function snapshotLine(processes) {
  return Buffer.from(JSON.stringify({ type: "snapshot", processes }) + "\n");
}

function startMonitor(child, overrides = {}) {
  return startCodexProcessMonitor({
    executablePath: "C:\\fixture\\ChatGPT.exe",
    port: 9335,
    intervalMs: 1000,
    spawnImpl: () => child,
    ...overrides,
  });
}

test("long-lived process monitor reports sequenced, timestamped snapshots and stops its child", () => {
  const child = createChild();
  let clock = 1_234;
  const snapshots = [];
  const monitor = startMonitor(child, {
    now: () => clock,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  child.stdout.emit("data", snapshotLine([
    { ProcessId: 42, CommandLine: "ChatGPT.exe --remote-debugging-port=9335" },
  ]));
  clock = 2_345;
  child.stdout.emit("data", snapshotLine([]));
  assert.deepEqual(snapshots, [
    {
      sequence: 1,
      capturedAt: 1_234,
      processes: [{
        processId: 42,
        commandLine: "ChatGPT.exe --remote-debugging-port=9335",
        mainWindowHandle: 0,
        mainWindowTitle: "",
      }],
    },
    { sequence: 2, capturedAt: 2_345, processes: [] },
  ]);
  monitor.stop();
  assert.equal(child.killed, true);
});

test("monitor assembles snapshots split across chunks and with multiple lines", () => {
  const child = createChild();
  const snapshots = [];
  startMonitor(child, { onSnapshot: (snapshot) => snapshots.push(snapshot) });
  const first = JSON.stringify({
    type: "snapshot",
    processes: [{ ProcessId: 1, CommandLine: "ChatGPT.exe", MainWindowHandle: 10 }],
  });
  const second = JSON.stringify({
    type: "snapshot",
    processes: [{ ProcessId: 2, CommandLine: "ChatGPT.exe", MainWindowHandle: 20 }],
  });
  const text = `${first}\n${second}\n`;
  child.stdout.emit("data", Buffer.from(text.slice(0, 7)));
  child.stdout.emit("data", Buffer.from(text.slice(7, 31)));
  child.stdout.emit("data", Buffer.from(text.slice(31)));
  assert.deepEqual(snapshots.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(snapshots.map(({ processes }) => processes.map(({ processId }) => processId)), [[1], [2]]);
});

test("malformed lines are ignored without consuming sequence numbers", () => {
  const child = createChild();
  const snapshots = [];
  const errors = [];
  startMonitor(child, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.message),
  });
  child.stdout.emit("data", Buffer.from("not json\n\n"));
  child.stdout.emit("data", snapshotLine([]));
  assert.deepEqual(errors, []);
  assert.deepEqual(snapshots.map(({ sequence }) => sequence), [1]);
});

test("output and errors are ignored after stop", () => {
  const child = createChild();
  const snapshots = [];
  const errors = [];
  const monitor = startMonitor(child, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.message),
  });
  monitor.stop();
  assert.equal(child.killed, true);
  child.stdout.emit("data", snapshotLine([]));
  child.stderr.emit("data", Buffer.from("late stderr"));
  assert.deepEqual(snapshots, []);
  assert.deepEqual(errors, []);
});

test("stderr fails closed once and stops consuming output", () => {
  const child = createChild();
  const snapshots = [];
  const errors = [];
  startMonitor(child, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.message),
  });
  child.stderr.emit("data", Buffer.from("access denied"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /access denied/);
  assert.equal(child.killed, true);
  child.stdout.emit("data", snapshotLine([]));
  child.emit("exit", 0);
  assert.deepEqual(snapshots, []);
  assert.equal(errors.length, 1);
});

test("a child error event fails closed exactly once", () => {
  const child = createChild();
  const errors = [];
  const monitor = startMonitor(child, { onError: (error) => errors.push(error.message) });
  child.emit("error", new Error("spawn failed"));
  assert.deepEqual(errors, ["spawn failed"]);
  assert.equal(child.killed, true);
  monitor.stop();
  assert.equal(errors.length, 1);
});

test("an unexpected exit fails closed exactly once", () => {
  const child = createChild();
  const snapshots = [];
  const errors = [];
  startMonitor(child, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.message),
  });
  child.emit("exit", 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /已退出/);
  assert.equal(child.killed, true);
  child.stdout.emit("data", snapshotLine([]));
  assert.deepEqual(snapshots, []);
  assert.equal(errors.length, 1);
});

test("a synchronous spawn failure reports once and returns an inert monitor", () => {
  const errors = [];
  const monitor = startCodexProcessMonitor({
    executablePath: "C:\\fixture\\ChatGPT.exe",
    port: 9335,
    intervalMs: 1000,
    spawnImpl: () => { throw new Error("spawn boom"); },
    onError: (error) => errors.push(error.message),
  });
  assert.deepEqual(errors, ["spawn boom"]);
  monitor.stop();
  assert.deepEqual(errors, ["spawn boom"]);
});

test("a CIM failure message fails closed instead of masquerading as an empty snapshot", () => {
  const child = createChild();
  const snapshots = [];
  const errors = [];
  startMonitor(child, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error.message),
  });
  child.stdout.emit("data", Buffer.from(JSON.stringify({
    type: "error",
    message: "CIM unavailable",
  }) + "\n"));
  assert.deepEqual(snapshots, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CIM unavailable/);
  assert.equal(child.killed, true);
});

test("an unterminated line beyond the buffer limit fails closed", () => {
  const child = createChild();
  const errors = [];
  startMonitor(child, { onError: (error) => errors.push(error.message) });
  child.stdout.emit("data", Buffer.from("x".repeat(200 * 1024)));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /缓冲/);
  assert.equal(child.killed, true);
  child.stdout.emit("data", snapshotLine([]));
  assert.equal(errors.length, 1);
});
