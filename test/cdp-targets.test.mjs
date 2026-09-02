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

test("waitForCodexTarget waits until a semantic renderer is ready", async () => {
  let attempts = 0;
  const targets = await waitForCodexTarget(9335, {
    timeoutMs: 1_000,
    intervalMs: 0,
    inspectTargets: async () => {
      attempts += 1;
      return attempts < 3 ? [] : [{ target: currentTarget }];
    },
    delayFn: async () => {},
  });

  assert.equal(attempts, 3);
  assert.equal(targets[0].target.id, "current");
});
