import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodexProcesses, hasCodexDebugPort, parseCodexProcessList } from "../src/codex-processes.mjs";

test("Codex process parsing accepts one object, arrays, BOM and invalid rows", () => {
  const parsed = parseCodexProcessList("\uFEFF" + JSON.stringify([
    { ProcessId: 12, CommandLine: "ChatGPT.exe --type=renderer", MainWindowHandle: 0 },
    { ProcessId: 34, CommandLine: "ChatGPT.exe --remote-debugging-port=9335", MainWindowHandle: 123 },
    { ProcessId: "bad", CommandLine: "ChatGPT.exe" },
  ]));
  assert.deepEqual(parsed, [
    { processId: 12, commandLine: "ChatGPT.exe --type=renderer", mainWindowHandle: 0, mainWindowTitle: "" },
    { processId: 34, commandLine: "ChatGPT.exe --remote-debugging-port=9335", mainWindowHandle: 123, mainWindowTitle: "" },
  ]);
  assert.deepEqual(parseCodexProcessList(""), []);
  assert.deepEqual(parseCodexProcessList("not json"), []);
});

test("Codex debug-port detection is exact and classifies all top-level processes", () => {
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=9335 --user-data-dir=x", 9335), true);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=93350", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=9336", 9335), false);
  const result = classifyCodexProcesses([
    { processId: 1, commandLine: "", mainWindowHandle: 100 },
    { processId: 2, commandLine: "ChatGPT.exe --remote-debugging-port=9335", mainWindowHandle: 200 },
    { processId: 3, commandLine: "", mainWindowHandle: 0 },
  ], 9335);
  assert.deepEqual(result.ordinary.map(({ processId }) => processId), [1, 3]);
  assert.deepEqual(result.debug.map(({ processId }) => processId), [2]);
});