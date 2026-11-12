import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startCodexProcessMonitor } from "../src/codex-process-monitor.mjs";

test("long-lived process monitor parses line-delimited snapshots and stops its child", () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const snapshots = [];
  const monitor = startCodexProcessMonitor({
    executablePath: "C:\\fixture\\ChatGPT.exe",
    port: 9335,
    intervalMs: 1000,
    spawnImpl: () => child,
    onSnapshot: (processes) => snapshots.push(processes),
  });
  child.stdout.emit("data", Buffer.from(JSON.stringify({
    type: "snapshot",
    processes: [{ ProcessId: 42, CommandLine: "ChatGPT.exe --remote-debugging-port=9335" }],
  }) + "\n"));
  assert.deepEqual(snapshots, [[{
    processId: 42,
    commandLine: "ChatGPT.exe --remote-debugging-port=9335",
    mainWindowHandle: 0,
    mainWindowTitle: "",
  }]]);
  monitor.stop();
  assert.equal(killed, true);
});