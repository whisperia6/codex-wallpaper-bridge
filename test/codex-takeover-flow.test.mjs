import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodexTakeoverFlow } from '../src/codex-takeover-flow.mjs';

const ordinary = { processId: 42, commandLine: 'ChatGPT.exe', mainWindowHandle: 10 };
function fixture(overrides = {}) {
  const controller = new AbortController(), calls = [];
  const options = {
    installation: { id: 'local', path: 'C:/fixture/ChatGPT.exe' }, port: 9335, adaptive: true,
    expectedProcesses: [ordinary], signal: controller.signal, isCurrent: () => true,
    listProcesses: async () => [ordinary], isEndpointReady: async () => false,
    confirmClose: async () => { calls.push('confirm'); return true; },
    closeCodex: async (_, expected) => { calls.push('close'); assert.deepEqual(expected, [ordinary]); },
    launchCodex: async () => calls.push('launch'), waitForTarget: async () => calls.push('wait'),
    verifyOwner: async () => calls.push('verify'), injectOnce: async () => calls.push('inject'),
    ...overrides,
  };
  return { controller, calls, options, run: () => runCodexTakeoverFlow(options) };
}
test('takeover confirms, rechecks, closes only confirmed processes, then verifies before injecting', async () => {
  const f = fixture(); let checks = 0;
  f.options.listProcesses = async () => { checks++; return [ordinary]; };
  assert.deepEqual(await f.run(), { restored: true });
  assert.equal(checks, 2);
  assert.deepEqual(f.calls, ['confirm', 'close', 'launch', 'wait', 'verify', 'inject']);
});
test('confirmation and close use the fresh confirmed process count, not the original apply snapshot', async () => {
  const f = fixture(); f.options.installation.processIds = [];
  f.options.confirmClose = async installation => {
    assert.deepEqual(installation.processIds, [42]); assert.equal(installation.isRunning, true); return true;
  };
  f.options.closeCodex = async installation => { assert.deepEqual(installation.processIds, [42]); };
  assert.deepEqual(await f.run(), { restored: true });
  assert.deepEqual(f.options.installation.processIds, []);
});
for (const [name, overrides] of [
  ['existing endpoint', { isEndpointReady: async () => true }],
  ['debug instance on another port', { listProcesses: async () => [{ ...ordinary, commandLine: 'ChatGPT.exe --remote-debugging-port=9444' }] }],
  ['different PID', { listProcesses: async () => [{ ...ordinary, processId: 43 }] }],
  ['background process', { listProcesses: async () => [{ ...ordinary, mainWindowHandle: 0 }] }],
  ['additional instance', { listProcesses: async () => [ordinary, { ...ordinary, processId: 43 }] }],
]) test(`takeover skips ${name} without closing anything`, async () => {
  const f = fixture(overrides); assert.deepEqual(await f.run(), { skipped: true }); assert.deepEqual(f.calls, []);
});
test('canceling confirmation performs no close or launch', async () => {
  const f = fixture({ confirmClose: async () => false });
  assert.deepEqual(await f.run(), { canceled: true }); assert.deepEqual(f.calls, []);
});
test('process changes while confirmation is open cause a skip', async () => {
  const f = fixture(); let queries = 0;
  f.options.listProcesses = async () => ++queries === 1 ? [ordinary] : [];
  assert.deepEqual(await f.run(), { skipped: true }); assert.deepEqual(f.calls, ['confirm']);
});
for (const stage of ['listProcesses', 'closeCodex', 'launchCodex', 'waitForTarget', 'verifyOwner']) {
  test(`cancel during ${stage} prevents subsequent effects`, async () => {
    const f = fixture(); const original = f.options[stage];
    f.options[stage] = async (...args) => { const result = await original(...args); f.controller.abort(); return result; };
    await assert.rejects(f.run(), /取消/);
    assert.ok(!f.calls.includes('inject'));
    if (stage === 'closeCodex') assert.ok(!f.calls.includes('launch'));
    if (stage === 'listProcesses') assert.deepEqual(f.calls, []);
  });
}
test('cancellation does not wait for an open confirmation and its late acceptance is ignored', async () => {
  let confirm;
  const f = fixture({ confirmClose: () => new Promise(resolve => { confirm = resolve; }) });
  const running = f.run(); await new Promise(resolve => setImmediate(resolve));
  f.controller.abort(); await assert.rejects(running, /取消/);
  confirm(true); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.calls, []);
});
test('target identity change after an async query cancels before any side effect', async () => {
  const f = fixture(); let current = true; f.options.isCurrent = () => current;
  f.options.listProcesses = async () => { current = false; return [ordinary]; };
  await assert.rejects(f.run(), /取消/); assert.deepEqual(f.calls, []);
});
test('failed close never launches or injects', async () => {
  const f = fixture({ closeCodex: async () => { throw Error('close failed'); } });
  await assert.rejects(f.run(), /close failed/); assert.deepEqual(f.calls, ['confirm']);
});
