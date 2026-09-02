import assert from "node:assert/strict";
import test from "node:test";
import { runLaunchAndInjectFlow } from "../src/launch-flow.mjs";

function installation(overrides = {}) {
  return {
    id: "local:test",
    path: "D:\\Work\\Codex\\ChatGPT.exe",
    isRunning: true,
    processIds: [6100, 6200],
    ...overrides,
  };
}

test("a running ordinary Codex is left untouched when the user cancels", async () => {
  const calls = [];
  const result = await runLaunchAndInjectFlow({
    installation: installation(),
    port: 9335,
    adaptive: true,
    isEndpointReady: async () => false,
    confirmClose: async () => {
      calls.push("confirm");
      return false;
    },
    closeCodex: async () => calls.push("close"),
    launchCodex: async () => calls.push("launch"),
    waitForTarget: async () => calls.push("wait"),
    injectOnce: async () => calls.push("inject"),
  });

  assert.deepEqual(calls, ["confirm"]);
  assert.equal(result.canceled, true);
});

test("confirmation closes the selected Codex before launching and injecting", async () => {
  const calls = [];
  const result = await runLaunchAndInjectFlow({
    installation: installation(),
    port: 9447,
    adaptive: false,
    isEndpointReady: async () => false,
    confirmClose: async () => {
      calls.push("confirm");
      return true;
    },
    closeCodex: async () => {
      calls.push("close");
      return { closedCount: 2 };
    },
    launchCodex: async ({ installation: selected, port }) => {
      calls.push("launch");
      assert.equal(selected.isRunning, false);
      assert.deepEqual(selected.processIds, []);
      assert.equal(port, 9447);
      return { connected: true };
    },
    waitForTarget: async () => {
      calls.push("wait");
      return [{ target: { id: "codex" } }];
    },
    injectOnce: async ({ port, adaptive }) => {
      calls.push("inject");
      assert.equal(port, 9447);
      assert.equal(adaptive, false);
      return { compatibility: [{ ok: true }] };
    },
  });

  assert.deepEqual(calls, ["confirm", "close", "launch", "wait", "inject"]);
  assert.equal(result.canceled, false);
  assert.equal(result.closed.closedCount, 2);
  assert.equal(result.launch.connected, true);
});

test("an already-debuggable Codex skips the close prompt and is injected", async () => {
  const calls = [];
  await runLaunchAndInjectFlow({
    installation: installation(),
    port: 9335,
    adaptive: true,
    isEndpointReady: async () => true,
    confirmClose: async () => calls.push("confirm"),
    closeCodex: async () => calls.push("close"),
    launchCodex: async () => {
      calls.push("launch");
      return { connected: true, alreadyListening: true };
    },
    waitForTarget: async () => calls.push("wait"),
    injectOnce: async () => {
      calls.push("inject");
      return { compatibility: [] };
    },
  });

  assert.deepEqual(calls, ["launch", "wait", "inject"]);
});

test("a close failure stops launch and injection", async () => {
  const calls = [];
  await assert.rejects(() => runLaunchAndInjectFlow({
    installation: installation(),
    port: 9335,
    adaptive: true,
    isEndpointReady: async () => false,
    confirmClose: async () => true,
    closeCodex: async () => {
      calls.push("close");
      throw new Error("关闭失败");
    },
    launchCodex: async () => calls.push("launch"),
    waitForTarget: async () => calls.push("wait"),
    injectOnce: async () => calls.push("inject"),
  }), /关闭失败/);

  assert.deepEqual(calls, ["close"]);
});

test("renderer readiness failure stops automatic injection", async () => {
  const calls = [];
  await assert.rejects(() => runLaunchAndInjectFlow({
    installation: installation({ isRunning: false, processIds: [] }),
    port: 9335,
    adaptive: true,
    isEndpointReady: async () => false,
    confirmClose: async () => calls.push("confirm"),
    closeCodex: async () => calls.push("close"),
    launchCodex: async () => {
      calls.push("launch");
      return { connected: true };
    },
    waitForTarget: async () => {
      calls.push("wait");
      throw new Error("renderer 未就绪");
    },
    injectOnce: async () => calls.push("inject"),
  }), /renderer 未就绪/);

  assert.deepEqual(calls, ["launch", "wait"]);
});
