import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaServer } from '../bridge-runtime/src/media-server.mjs';
import { invokeBridgeAction } from '../src/bridge-runner.mjs';

test('GPU engine status preserves bounded renderer metrics without private capabilities or author data', async t => {
  const server = createMediaServer({ onAction: async () => ({ ok: true, sceneRenderer: 'direct-gpu',
    engine: [{ id: 'scene', renderer: 'direct-gpu', requestedFps: 60, failed: false, privatePath: 'secret',
      targets: [{ active: true, preloaded: false, width: 1920, height: 1080, fps: 59, renderCompletions: 1234,
        origin: 'http://private', channel: 'secret', title: 'secret' }] }] }) });
  await server.start(); t.after(() => server.close());
  const result = await invokeBridgeAction({ controlUrl: server.baseUrl, action: 'engine-status' });
  assert.equal(result.sceneRenderer, 'direct-gpu');
  assert.deepEqual(result.engine, [{ id: 'scene', renderer: 'direct-gpu', requestedFps: 60, failed: false,
    targets: [{ active: true, preloaded: false, width: 1920, height: 1080, fps: 59, renderCompletions: 1234,
      pointerReceived: 0, pointerForwarded: 0, pointerBlocked: 'none' }] }]);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|channel|origin|title/);
});
test('GPU diagnostics cannot export unbounded target lists or nonfinite dimensions/counters', async t => {
  const server = createMediaServer({ onAction: async () => ({ ok: true, sceneRenderer: 'script:secret',
    engine: [{ id: 'scene', renderer: 'direct-gpu', requestedFps: 999, failed: true,
      targets: Array.from({ length: 200 }, () => ({ active: 'yes', width: Infinity, height: -5, fps: 'secret', renderCompletions: 1e30,
        pointerReceived: Infinity, pointerForwarded: 'secret', pointerBlocked: 'private-message' })) }] }) });
  await server.start(); t.after(() => server.close());
  const result = await invokeBridgeAction({ controlUrl: server.baseUrl, action: 'engine-status' });
  assert.equal(result.sceneRenderer, undefined); assert.equal(result.engine[0].targets.length, 16);
  assert.equal(result.engine[0].requestedFps, 0);
  assert.deepEqual(result.engine[0].targets[0], { active: false, preloaded: false, width: 0, height: 0, fps: 0, renderCompletions: 0,
    pointerReceived: 0, pointerForwarded: 0, pointerBlocked: 'none' });
});

test('HTTP action responses carry both hosts and sanitize cleanup state and diagnostics', async (t) => {
  const activeHosts = [{ hostType: 'codex', port: 9335 }, { hostType: 'antigravity', port: 9336 }];
  const server = createMediaServer({ onAction: async (action) => {
    if (action === 'inject') throw Object.assign(new Error('inject failed'), { registeredHosts: [{ ...activeHosts[1], path: 'secret' }] });
    return { ok: true, activeHosts: activeHosts.map((entry) => ({ ...entry, path: 'secret' })), injectorActive: true,
      engine: activeHosts.flatMap((endpoint) => ['scene', 'preload'].map((id) => ({ ...endpoint, id, renderer: 'direct-gpu' }))) };
  } });
  await server.start();
  t.after(() => server.close());
  const invoke = (action) => invokeBridgeAction({ controlUrl: server.baseUrl, action });
  const result = await invoke('engine-status');
  assert.deepEqual(result.activeHosts, activeHosts);
  assert.equal(result.injectorActive, true);
  assert.deepEqual(result.engine.map(({ hostType, port }) => ({ hostType, port })), [
    activeHosts[0], activeHosts[0], activeHosts[1], activeHosts[1],
  ]);
  await assert.rejects(invoke('inject'), (error) => {
    assert.equal(error.message, 'inject failed');
    assert.deepEqual(error.registeredHosts, [activeHosts[1]]);
    return true;
  });
});
