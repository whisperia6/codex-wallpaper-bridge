import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CdpWallpaperInjector } from "../bridge-runtime/src/cdp-injector.mjs";
import {
  buildInjectionScript,
  buildRestoreScript
} from "../bridge-runtime/src/injected-renderer.mjs";

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("standalone runtime sync applies the large-video overrides", async () => {
  const generated = await readFile(
    path.join(prototypeRoot, "bridge-runtime", "src", "cdp-injector.mjs"),
    "utf8"
  );
  const override = await readFile(
    path.join(prototypeRoot, "bridge-overrides", "src", "cdp-injector.mjs"),
    "utf8"
  );
  assert.equal(generated, override);
  assert.match(generated, /asset-transfer-complete/);
});

test("large assets use 8 MiB chunks with three CDP requests in flight", async () => {
  const calls = [];
  const statuses = [];
  const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
  let appendInFlight = 0;
  let maximumAppendInFlight = 0;
  const injector = new CdpWallpaperInjector({
    installOnNewDocument: false,
    onStatus: (status) => statuses.push(status)
  });
  const session = {
    newDocumentId: null,
    socket: {
      async call(method, params) {
        calls.push({ method, params });
        if (params.expression?.includes("cached?.url")) {
          return { result: { value: false } };
        }
        if (params.expression?.includes("size: blob.size")) {
          return { result: { value: { size: bytes.length } } };
        }
        if (params.expression?.includes("binary.charCodeAt")) {
          appendInFlight += 1;
          maximumAppendInFlight = Math.max(maximumAppendInFlight, appendInFlight);
          await new Promise((resolve) => setTimeout(resolve, 12));
          appendInFlight -= 1;
        }
        return { result: { value: true } };
      }
    }
  };

  await injector.installScript(session, {
    script: "(() => true)()",
    assets: [{
      key: "video:test",
      bytes,
      size: bytes.length,
      contentType: "video/mp4"
    }]
  });

  const expressions = calls.map((call) => call.params.expression || "");
  const appendCalls = expressions.filter((expression) => expression.includes("binary.charCodeAt"));
  assert.equal(appendCalls.length, 3);
  assert.equal(maximumAppendInFlight, 3);
  assert.match(appendCalls[0], /transfer\.parts\[0\]/);
  assert.match(appendCalls[1], /transfer\.parts\[1\]/);
  assert.match(appendCalls[2], /transfer\.parts\[2\]/);
  assert.match(expressions.at(-2), /new Blob/);
  assert.equal(expressions.at(-1), "(() => true)()");
  const started = statuses.find((status) => status.type === "asset-transfer-start");
  assert.equal(started.mode, "fast");
  assert.equal(started.chunkBytes, 8 * 1024 * 1024);
  assert.equal(started.concurrency, 3);
  const progress = statuses.filter((status) => status.type === "asset-transfer-progress");
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).transferred, bytes.length);
  assert.equal(progress.at(-1).percent, 100);
});

test("a failed fast transfer is cleaned up and retried in 2 MiB serial mode", async () => {
  const calls = [];
  const statuses = [];
  const bytes = Buffer.alloc(17 * 1024 * 1024, 3);
  let appendAttempts = 0;
  let transferGeneration = 0;
  let fastAppendInFlight = 0;
  let inFlightAtCleanup = null;
  const injector = new CdpWallpaperInjector({
    installOnNewDocument: false,
    onStatus: (status) => statuses.push(status)
  });
  const session = {
    newDocumentId: null,
    socket: {
      async call(method, params) {
        calls.push({ method, params });
        if (params.expression?.includes("cached?.url")) {
          return { result: { value: false } };
        }
        if (params.expression?.includes("parts: new Array")) {
          transferGeneration += 1;
        }
        if (params.expression?.includes("binary.charCodeAt")) {
          appendAttempts += 1;
          if (transferGeneration === 1) {
            const fastAttempt = appendAttempts;
            fastAppendInFlight += 1;
            await new Promise((resolve) => setTimeout(resolve, fastAttempt === 1 ? 50 : 90));
            fastAppendInFlight -= 1;
            if (fastAttempt === 1) {
              return { exceptionDetails: { text: "fast chunk rejected" } };
            }
          }
        }
        if (params.expression?.includes("delete globalThis") && inFlightAtCleanup === null) {
          inFlightAtCleanup = fastAppendInFlight;
        }
        if (params.expression?.includes("size: blob.size")) {
          return { result: { value: { size: bytes.length } } };
        }
        return { result: { value: true } };
      }
    }
  };

  await injector.installScript(session, {
    script: "(() => true)()",
    assets: [{
      key: "video:fallback",
      bytes,
      size: bytes.length,
      contentType: "video/mp4"
    }]
  });

  const expressions = calls.map((call) => call.params.expression || "");
  assert.equal(expressions.filter((expression) => expression.includes("binary.charCodeAt")).length, 12);
  assert.ok(expressions.filter((expression) => expression.includes("delete globalThis")).length >= 1);
  assert.equal(inFlightAtCleanup, 0);
  const fallback = statuses.find((status) => status.type === "asset-transfer-fallback");
  assert.equal(fallback.mode, "compatibility");
  assert.equal(fallback.chunkBytes, 2 * 1024 * 1024);
  assert.equal(fallback.concurrency, 1);
  assert.equal(statuses.at(-1).type, "asset-transfer-complete");
  assert.equal(statuses.at(-1).mode, "compatibility");
});

test("renderer resolves transferred Blob URLs and restore revokes them", () => {
  const injection = buildInjectionScript({
    wallpaper: {
      id: "large-video",
      type: "video",
      playable: "video",
      mediaAssetKey: "video:large",
      previewUrl: "data:image/jpeg;base64,AA=="
    }
  });
  const restore = buildRestoreScript();

  assert.match(injection, /mediaAssetKey/);
  assert.match(injection, /transferredUrl/);
  assert.match(injection, /URL\.revokeObjectURL/);
  assert.match(restore, /registry instanceof Map/);
  assert.match(restore, /URL\.revokeObjectURL/);
});

test("an existing renderer asset is reused without retransmitting chunks", async () => {
  const calls = [];
  const injector = new CdpWallpaperInjector({ installOnNewDocument: false });
  const session = {
    newDocumentId: null,
    socket: {
      async call(method, params) {
        calls.push({ method, params });
        if (params.expression?.includes("cached?.url")) {
          return { result: { value: true } };
        }
        return { result: { value: true } };
      }
    }
  };

  await injector.installScript(session, {
    script: "(() => true)()",
    assets: [{
      key: "video:cached",
      bytes: Buffer.from([1, 2, 3]),
      size: 3,
      contentType: "video/mp4"
    }]
  });

  assert.equal(calls.length, 2);
  assert.doesNotMatch(
    calls.map((call) => call.params.expression || "").join("\n"),
    /binary\.charCodeAt/
  );
});

test("renderer transfer exceptions fail the injection instead of reporting success", async () => {
  const injector = new CdpWallpaperInjector({ installOnNewDocument: false });
  const session = {
    newDocumentId: null,
    socket: {
      async call(method, params) {
        if (params.expression?.includes("cached?.url")) {
          return { result: { value: false } };
        }
        if (params.expression?.includes("binary.charCodeAt")) {
          return { exceptionDetails: { text: "chunk rejected" } };
        }
        return { result: { value: true } };
      }
    }
  };

  await assert.rejects(
    injector.installScript(session, {
      script: "(() => true)()",
      assets: [{
        key: "video:broken",
        bytes: Buffer.from([1, 2, 3]),
        size: 3,
        contentType: "video/mp4"
      }]
    }),
    /chunk rejected/
  );
});
