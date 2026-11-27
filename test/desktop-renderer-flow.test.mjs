import assert from "node:assert/strict";
import test from "node:test";
import { controlUrl, desktopRendererHarness as harness } from "../test-support/desktop-ui.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("trusted target changes recall independent ports and applying Antigravity keeps the iframe", async (context) => {
  const renderer = await harness(context, { desktopState: {
    installations: [{ id: "codex" }, { id: "ag", hostType: "antigravity" }],
    selectedId: "codex", port: 12345, portsByHost: { codex: 12345 }, adaptive: true,
  } });
  const originalUrl = renderer.frame.src;
  renderer.emit({ type: "target-change", installationId: "codex", port: 23335 });
  renderer.emit({ type: "target-change", installationId: "ag" });
  assert.equal(renderer.snapshot().port, 9336);
  renderer.emit({ type: "target-change", installationId: "ag", port: 23336 });
  renderer.emit({ type: "target-change", installationId: "codex" });
  assert.equal(renderer.snapshot().port, 23335);
  const apply = renderer.execute("apply", { installationId: "ag" });
  await turn();
  renderer.completeFlush(true);
  await apply;
  assert.equal(renderer.calls.apply[0].port, 23336);
  assert.equal(renderer.calls.open, 1);
  assert.equal(renderer.frame.src, originalUrl);
});

test("desktop rejects another installation on an occupied port before the config save handshake", async (context) => {
  const occupied = { installationId: "codex", hostType: "codex", port: 12345 };
  const renderer = await harness(context, { desktopState: {
    installations: [{ id: "codex" }, { id: "codex-store" }, { id: "ag", hostType: "antigravity" }],
    selectedId: "codex", port: 12345,
  }, applyResult: { promise: Promise.resolve({ ok: true, activeInjectionTargets: [occupied] }) } });
  const firstApply = renderer.execute("apply", { installationId: "codex", port: 12345 });
  await turn();
  renderer.completeFlush(true);
  await firstApply;
  assert.deepEqual(renderer.snapshot().activeInjectionTargets, [occupied]);
  for (const installationId of ["ag", "codex-store"]) {
    const result = await renderer.execute("apply", { installationId, port: 12345 });
    assert.equal(result.ok, false);
    assert.match(result.message, /12345.*Codex.*不同的端口/);
    assert.equal(renderer.flushes().length, 1);
    assert.equal(renderer.calls.apply.length, 1);
    assert.equal(renderer.snapshot().selectedId, "codex");
  }
});

test("desktop forwards another installation's apply to IPC after restore leaves the port pending reconciliation", async (context) => {
  const port = 12345;
  const occupied = { installationId: "codex", hostType: "codex", port };
  const pending = { ...occupied, reconcilePending: true };
  const active = { installationId: "ag", hostType: "antigravity", port };
  const renderer = await harness(context, {
    desktopState: {
      installations: [{ id: "codex" }, { id: "ag", hostType: "antigravity" }],
      selectedId: "codex", port, activeInjectionTargets: [occupied],
    },
    restoreResult: { promise: Promise.resolve({ ok: false, message: "restore response timed out", activeInjectionTargets: [pending] }) },
    applyResult: { promise: Promise.resolve({ ok: true, activeInjectionTargets: [active] }) },
  });
  assert.equal((await renderer.execute("restore", { installationId: "codex", port })).ok, false);
  assert.deepEqual(renderer.snapshot().activeInjectionTargets, [pending]);
  const apply = renderer.execute("apply", { installationId: "ag", port });
  await turn();
  renderer.completeFlush(true);
  assert.equal((await apply).ok, true);
  assert.deepEqual(renderer.calls.apply, [{ installationId: "ag", port, adaptive: true }]);
  assert.deepEqual(renderer.snapshot().activeInjectionTargets, [active]);
});

test("apply remains busy until both the delayed save handshake and apply IPC finish", async (context) => {
  const applyResult = deferred();
  const renderer = await harness(context, { applyResult });
  const operation = renderer.execute("apply");
  await turn();
  assert.equal(renderer.flushes().length, 1);
  assert.equal(renderer.calls.apply.length, 0, "apply must wait for the save response");
  assert.equal(renderer.snapshot().busy, true, "save handshake must retain the busy guard");

  renderer.completeFlush(true);
  await turn();
  assert.deepEqual(renderer.calls.apply, [{ installationId: "isolated-codex", port: 12345, adaptive: true }]);
  assert.equal(renderer.snapshot().busy, true, "in-flight apply IPC must retain the busy guard");
  applyResult.resolve({ ok: true, message: "applied" });
  assert.deepEqual(copy(await operation), { ok: true, message: "applied" });
  assert.equal(renderer.snapshot().busy, false);
  assert.equal(renderer.snapshot().feedbackTone, "success");
});

test('workbench theme persists in the stable desktop origin across bridge port changes without apply IPC', async context => {
  const storage = new Map();
  const first = await harness(context, { storage });
  const messagesBefore = first.messages.length;
  first.emit({ type:'workbench-theme', theme:'light' });
  assert.equal(first.snapshot().workbenchTheme, 'light');
  assert.equal(storage.get('cwb.workbench.theme'), 'light');
  assert.equal(first.calls.apply.length + first.calls.restore.length, 0);
  assert.equal(first.messages.length, messagesBefore, 'changing the theme must not redraw or reset unsaved controls');
  const restarted = await harness(context, { storage, url:'http://127.0.0.1:23456/new-bridge/' });
  assert.equal(new URL(restarted.frame.src).searchParams.get('workbenchTheme'), 'light');
  assert.equal(restarted.snapshot().workbenchTheme, 'light');
});

test('theme messages reject unknown values, foreign origins and non-control sources', async context => {
  const renderer = await harness(context);
  renderer.emit({ type:'workbench-theme', theme:'invalid' });
  renderer.emitFrom({}, new URL(controlUrl).origin, { type:'workbench-theme', theme:'light' });
  renderer.emitFrom(renderer.frame.contentWindow, 'http://127.0.0.1:12346', { type:'workbench-theme', theme:'light' });
  assert.equal(renderer.snapshot().workbenchTheme, 'dark');
  assert.equal(renderer.storage.get('cwb.workbench.theme'), 'dark');
  assert.equal(renderer.flushes().length, 0);
});

test("failed save handshake returns structured failure and never invokes apply IPC", async (context) => {
  const renderer = await harness(context);
  // Capture either outcome immediately so the old rejection is a test failure,
  // not an unhandled promise rejection outside the runtime under test.
  const operation = renderer.execute("apply").then(
    (value) => ({ status: "resolved", value: copy(value) }),
    (error) => ({ status: "rejected", message: error.message }),
  );
  await turn();
  renderer.completeFlush(false, "save failed");
  assert.deepEqual(await operation, { status: "resolved", value: { ok: false, message: "save failed" } });
  assert.equal(renderer.calls.apply.length, 0);
  assert.equal(renderer.snapshot().busy, false);
  assert.equal(renderer.snapshot().feedback, "save failed");
  assert.equal(renderer.snapshot().feedbackTone, "error");
});

test("duplicate apply and restore requests are rejected throughout save and apply IPC", async (context) => {
  const applyResult = deferred();
  const renderer = await harness(context, { applyResult });
  const operation = renderer.execute("apply");
  await turn();
  const duplicate = renderer.execute("apply");
  await turn();
  assert.equal(renderer.flushes().length, 1, "a duplicate must not begin a second save handshake");
  assert.deepEqual(copy(await duplicate), { ok: false, message: "当前操作尚未完成，请稍候" });

  renderer.completeFlush(true);
  await turn();
  assert.deepEqual(copy(await renderer.execute("restore")), { ok: false, message: "当前操作尚未完成，请稍候" });
  assert.equal(renderer.calls.restore.length, 0);
  assert.equal(renderer.calls.apply.length, 1);
  applyResult.resolve({ ok: true });
  await operation;
  assert.equal(renderer.snapshot().busy, false);
});

test("restore keeps the busy guard until its asynchronous IPC has finished", async (context) => {
  const restoreResult = deferred();
  const renderer = await harness(context, { restoreResult });
  const operation = renderer.execute("restore");
  await turn();
  assert.deepEqual(renderer.calls.restore, [{ installationId: "isolated-codex", port: 12345 }]);
  assert.equal(renderer.snapshot().busy, true);
  restoreResult.resolve({ ok: true });
  assert.deepEqual(copy(await operation), { ok: true });
  assert.equal(renderer.snapshot().busy, false);
  assert.equal(renderer.snapshot().feedbackTone, "success");
});

test("restore IPC rejection is caught and returns a recoverable structured failure", async (context) => {
  const restoreResult = deferred();
  const renderer = await harness(context, { restoreResult });
  const operation = renderer.execute("restore").then(
    (value) => ({ status: "resolved", value: copy(value) }),
    (error) => ({ status: "rejected", message: error.message }),
  );
  restoreResult.reject(new Error("restore failed"));
  assert.deepEqual(await operation, { status: "resolved", value: { ok: false, message: "restore failed" } });
  assert.equal(renderer.snapshot().busy, false);
  assert.equal(renderer.snapshot().feedback, "restore failed");
  assert.equal(renderer.snapshot().feedbackTone, "error");
});

test("restore passes an explicitly selected installation and port to its IPC", async (context) => {
  const renderer = await harness(context);
  assert.deepEqual(copy(await renderer.execute("restore", { installationId: "other-isolated-codex", port: 12346 })), { ok: true });
  assert.deepEqual(renderer.calls.restore, [{ installationId: "other-isolated-codex", port: 12346 }]);
});

test("apply displays the specific cancellation reason without claiming that injection succeeded", async (context) => {
  const applyResult = deferred();
  const renderer = await harness(context, { applyResult });
  const operation = renderer.execute("apply");
  await turn();
  renderer.completeFlush(true);
  const message = "已取消，未启动另一版本，原有 Codex 窗口保持不变";
  applyResult.resolve({ ok: true, canceled: true, message });
  assert.deepEqual(copy(await operation), { ok: true, canceled: true, message });
  assert.equal(renderer.snapshot().feedback, message);
  assert.equal(renderer.snapshot().feedbackTone, "idle");
  assert.equal(renderer.snapshot().busy, false);
});
