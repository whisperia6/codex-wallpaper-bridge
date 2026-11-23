import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexProcesses,
  hasAnyCodexDebugPort,
  hasCodexDebugPort,
  parseCodexProcessList,
} from "../src/codex-processes.mjs";

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

test("Codex debug-port detection accepts equals, space and quoted forms", () => {
  const forms = [
    "ChatGPT.exe --remote-debugging-port=9335",
    "ChatGPT.exe --remote-debugging-port 9335",
    'ChatGPT.exe --remote-debugging-port="9335"',
    "ChatGPT.exe --remote-debugging-port='9335'",
    'ChatGPT.exe --remote-debugging-port "9335"',
    '"C:\\fixture\\ChatGPT.exe" "--remote-debugging-port=9335"',
    "ChatGPT.exe --remote-debugging-port = 9335",
  ];
  for (const form of forms) {
    assert.equal(hasCodexDebugPort(form, 9335), true, form);
    assert.equal(hasAnyCodexDebugPort(form), true, form);
  }
});

test("Codex debug-port detection rejects numeric prefixes and look-alike flags", () => {
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=93350", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=9336", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --foo--remote-debugging-port=9335", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-portx=9335", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=abc", 9335), false);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=9335x", 9335), false);
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe --foo--remote-debugging-port=9335"), false);
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe --remote-debugging-portx=9335"), false);
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe"), false);
});

test("hasAnyCodexDebugPort detects other ports for conservative callers", () => {
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe --remote-debugging-port=9444"), true);
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe --remote-debugging-port 9444"), true);
  assert.equal(hasAnyCodexDebugPort("ChatGPT.exe --remote-debugging-port"), true);
  assert.equal(hasCodexDebugPort("ChatGPT.exe --remote-debugging-port=9444", 9335), false);
});

test("a command line with several debug flags is matched on the requested port", () => {
  const commandLine = "ChatGPT.exe --remote-debugging-port=9444 --remote-debugging-port=9335";
  assert.equal(hasCodexDebugPort(commandLine, 9335), true);
  assert.equal(hasCodexDebugPort(commandLine, 9444), true);
  assert.equal(hasAnyCodexDebugPort(commandLine), true);
});

test("Codex debug-port detection classifies top-level processes", () => {
  const result = classifyCodexProcesses([
    { processId: 1, commandLine: "", mainWindowHandle: 100 },
    { processId: 2, commandLine: "ChatGPT.exe --remote-debugging-port=9335", mainWindowHandle: 200 },
    { processId: 3, commandLine: "", mainWindowHandle: 0 },
    { processId: 4, commandLine: "ChatGPT.exe --remote-debugging-port=9444", mainWindowHandle: 300 },
  ], 9335);
  assert.deepEqual(result.ordinary.map(({ processId }) => processId), [1, 3, 4]);
  assert.deepEqual(result.debug.map(({ processId }) => processId), [2]);
});
