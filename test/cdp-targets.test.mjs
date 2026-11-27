import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuxiliaryTarget,
  scoreCodexTarget,
  selectCodexTargets,
  waitForCodexTarget,
} from "../src/cdp-client.mjs";

const currentTarget = {
  id: "current",
  type: "page",
  title: "Codex",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1/current",
};
const storeTarget = { ...currentTarget, id: "store-chatgpt", title: "ChatGPT" };
const splashProbe = { hasRoot: true, semanticHookCount: 0, composerHookCount: 0, descendantCount: 17 };

test('renderer wait stops on cancellation, including cancellation during inspection', async () => {
  const controller = new AbortController(); let queries = 0;
  await assert.rejects(waitForCodexTarget(9335, {
    signal: controller.signal,
    inspectTargets: async () => { queries++; controller.abort(); return [currentTarget]; },
    delayFn: async () => { throw Error('must not delay'); },
  }), { name: 'AbortError' });
  assert.equal(queries, 1);
  await assert.rejects(waitForCodexTarget(9335, {
    signal: controller.signal, inspectTargets: async () => { queries++; return []; },
  }), { name: 'AbortError' });
  assert.equal(queries, 1);
});

test("auxiliary avatar, pet, and overlay pages are excluded", () => {
  assert.equal(isAuxiliaryTarget({ ...currentTarget, url: "app://-/index.html?initialRoute=pet" }), true);
  assert.equal(isAuxiliaryTarget({ ...currentTarget, url: "app://-/index.html?initialRoute=overlay" }), true);
  assert.equal(isAuxiliaryTarget(currentTarget), false);
});

test("target scoring favors Codex semantic DOM instead of installation origin", () => {
  const currentScore = scoreCodexTarget(currentTarget, {
    hasRoot: true,
    semanticHookCount: 8,
    composerHookCount: 2,
    descendantCount: 1500,
  });
  const storeScore = scoreCodexTarget({
    ...currentTarget,
    id: "store",
    url: "app://codex/index.html",
  }, {
    hasRoot: true,
    semanticHookCount: 3,
    composerHookCount: 1,
    descendantCount: 900,
  });
  const unrelatedScore = scoreCodexTarget({
    ...currentTarget,
    id: "settings",
    title: "Settings",
    url: "app://settings/",
  }, {
    hasRoot: false,
    semanticHookCount: 0,
    composerHookCount: 0,
    descendantCount: 20,
  });

  assert.ok(currentScore > storeScore);
  assert.ok(storeScore >= 10);
  assert.ok(unrelatedScore < 10);
});

test("selectCodexTargets requires the Store renderer's main interface to mount", () => {
  for (const url of [storeTarget.url, "app://-/"]) {
    const target = { ...storeTarget, url };
    for (const probe of [splashProbe, { ...splashProbe, descendantCount: 199 }]) {
      assert.ok(scoreCodexTarget(target, probe) < 10);
      assert.deepEqual(selectCodexTargets([{ target, probe }]), []);
    }

    for (const readyProbe of [{ semanticHookCount: 1 }, { composerHookCount: 1 }, { descendantCount: 200 }]) {
      const probe = { ...splashProbe, ...readyProbe };
      const score = scoreCodexTarget(target, probe);
      assert.ok(score >= 10);
      assert.deepEqual(selectCodexTargets([{ target, probe }]), [{ target, probe, score }]);
    }
  }
});

test("settings pages and pages without a root are below the renderer selection threshold", () => {
  const probe = { ...splashProbe, semanticHookCount: 2, descendantCount: 200 };
  const settings = { ...storeTarget, url: "app://settings/", title: "ChatGPT Settings" };
  const rootlessProbe = { ...probe, hasRoot: false };

  assert.ok(scoreCodexTarget(settings, probe) < 10);
  assert.ok(scoreCodexTarget(storeTarget, rootlessProbe) < 10);
  assert.deepEqual(selectCodexTargets([
    { target: settings, probe },
    { target: storeTarget, probe: rootlessProbe },
  ]), []);
});

test("selectCodexTargets retains all renderer targets that pass the semantic threshold", () => {
  const targets = selectCodexTargets([
    { target: currentTarget, probe: { hasRoot: true, semanticHookCount: 6, composerHookCount: 1, descendantCount: 1000 } },
    {
      target: { ...currentTarget, id: "store", url: "app://codex/index.html" },
      probe: { hasRoot: true, semanticHookCount: 2, composerHookCount: 1, descendantCount: 800 },
    },
    {
      target: { ...currentTarget, id: "settings", title: "Settings", url: "app://settings/" },
      probe: { hasRoot: false, semanticHookCount: 0, composerHookCount: 0, descendantCount: 10 },
    },
  ]);

  assert.deepEqual(targets.map(({ target }) => target.id), ["current", "store"]);
});

test("waitForCodexTarget keeps polling the Store splash page until the main interface mounts", async () => {
  let attempts = 0;
  const readyProbe = { ...splashProbe, semanticHookCount: 2 };
  const targets = await waitForCodexTarget(9335, {
    timeoutMs: 1_000,
    intervalMs: 0,
    inspectTargets: async () => {
      attempts += 1;
      const probe = attempts < 3 ? splashProbe : readyProbe;
      return selectCodexTargets([{ target: storeTarget, probe }]);
    },
    delayFn: async () => {},
  });

  assert.equal(attempts, 3);
  assert.equal(targets[0].target.id, storeTarget.id);
  assert.equal(targets[0].probe, readyProbe);
});
