import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createMediaServer } from "../bridge-runtime/src/media-server.mjs";
import { invokeBridgeAction } from "../src/bridge-runner.mjs";

const token = "1234567890abcdef1234567890abcdef";

test("resident HTTP action carries validated per-target compatibility back to desktop", async (context) => {
  const server = createMediaServer({
    token,
    onAction: async (action, body) => {
      assert.equal(action, "inject");
      assert.equal(body.adaptive, false);
      return {
        ok: true,
        message: "injected",
        status: "injected:12",
        compatibility: [{ targetId: "main", value: { ok: true, adaptive: false } }],
      };
    },
  });
  await server.start();
  context.after(() => server.close());
  const result = await invokeBridgeAction({ controlUrl: server.baseUrl, action: "inject", adaptive: false });
  assert.deepEqual(result, {
    ok: true,
    message: "injected",
    status: "injected:12",
    compatibility: [{ targetId: "main", value: { ok: true, adaptive: false } }],
  });
});

test("compatibility result keeps only bounded diagnostic fields, not scripts or target content", async (context) => {
  const server = createMediaServer({
    token,
    onAction: async () => ({
      ok: true,
      privatePath: "private-path",
      compatibility: [
        null,
        { targetId: 42, value: { ok: true, adaptive: true } },
        { targetId: "no-status", value: { adaptive: true } },
        { targetId: "main", value: { ok: true, adaptive: false, content: "private-content", script: "private-script" } },
        { targetId: "safe", value: { ok: false, adaptive: "false" } },
        { targetId: "x".repeat(800), value: { ok: true, adaptive: true } },
      ],
    }),
  });
  await server.start();
  context.after(() => server.close());
  const result = await invokeBridgeAction({ controlUrl: server.baseUrl, action: "inject" });
  assert.deepEqual(result, {
    ok: true,
    compatibility: [
      { targetId: "main", value: { ok: true, adaptive: false } },
      { targetId: "safe", value: { ok: false } },
      { targetId: "x".repeat(512), value: { ok: true, adaptive: true } },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("action without compatibility retains its original response shape", async (context) => {
  const server = createMediaServer({ token, onAction: async () => ({ ok: true, status: "restored" }) });
  await server.start();
  context.after(() => server.close());
  assert.deepEqual(await invokeBridgeAction({ controlUrl: server.baseUrl, action: "restore" }), {
    ok: true, status: "restored",
  });
});

test("only authorized apply and retry responses outlive the server idle budget, and verification failures still propagate", async (context) => {
  const originalCreateServer = http.createServer;
  const originalSetTimeout = http.ServerResponse.prototype.setTimeout;
  const deadlines = [];
  let httpServer, injections = 0;
  const factory = context.mock.method(http, "createServer", (...args) => {
    httpServer = originalCreateServer(...args);
    return httpServer;
  });
  syncBuiltinESMExports();
  context.mock.method(http.ServerResponse.prototype, "setTimeout", function (milliseconds, ...args) {
    deadlines.push(milliseconds);
    return originalSetTimeout.call(this, milliseconds, ...args);
  });
  const server = createMediaServer({ token, onAction: async (action) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (action === "inject" && ++injections === 2) throw new Error("renderer verification failed");
    return { ok: true, status: action };
  } });
  try { await server.start(); }
  finally { factory.mock.restore(); syncBuiltinESMExports(); }
  context.after(() => server.close());
  assert.equal(httpServer.timeout, 30_000);
  assert.equal(httpServer.headersTimeout, 10_000);
  assert.equal(httpServer.requestTimeout, 0);
  httpServer.timeout = 20;
  assert.deepEqual(await invokeBridgeAction({ controlUrl: server.baseUrl, action: "inject" }),
    { ok: true, status: "inject" });
  assert.deepEqual(deadlines, [160_000]);
  assert.equal(httpServer.timeout, 20);
  await assert.rejects(invokeBridgeAction({ controlUrl: server.baseUrl, action: "restore" }), /fetch failed/);
  await assert.rejects(invokeBridgeAction({ controlUrl: server.baseUrl, action: "inject" }), /renderer verification failed/);
  assert.deepEqual(await invokeBridgeAction({ controlUrl: server.baseUrl, action: "retry-engine" }),
    { ok: true, status: "retry-engine" });
  const url = new URL("api/action", server.baseUrl);
  const unauthorized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://unrelated.example" }, body: JSON.stringify({ action: "inject" }) });
  assert.equal(unauthorized.status, 403);
  const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: 42 }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(url)).status, 405);
  assert.deepEqual(deadlines, [160_000, 160_000, 160_000]);
});
