import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CdpWallpaperInjector } from "../bridge-runtime/src/cdp-injector.mjs";
import { buildInjectionPlan } from "../bridge-runtime/src/injection-plan.mjs";
import {
  buildApplyScript,
  buildBootstrapScript,
  buildRestoreScript,
} from "../bridge-runtime/src/injected-renderer.mjs";
import { createMediaServer } from "../bridge-runtime/src/media-server.mjs";

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = "1234567890abcdef1234567890abcdef";
const serverDescriptor = {
  origin: "http://127.0.0.1:43123",
  basePath: `/${token}`,
};

function videoInventory(id = "large-video") {
  return {
    projects: [{
      id,
      title: "Large video",
      type: "video",
      playable: true,
      previewUrl: `${serverDescriptor.basePath}/api/preview/${id}`,
      mediaUrl: `${serverDescriptor.basePath}/api/video/${id}`,
      webUrl: null,
    }],
  };
}

function injection(id = "large-video") {
  return buildInjectionPlan({
    server: serverDescriptor,
    config: { selectedId: id, effects: { brightness: 0.82 } },
    inventory: videoInventory(id),
  });
}

function fakeSession() {
  const calls = [];
  const session = {
    target: { id: "target-1" },
    newDocumentId: null,
    runtimeInstalled: false,
    socket: {
      async call(method, params = {}) {
        calls.push({ method, params });
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          return { identifier: "bootstrap-1" };
        }
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("runtime.apply")) {
            return {
              result: {
                value: {
                  ok: true,
                  runtimeReady: true,
                  domReady: true,
                  media: { state: "loading" },
                },
              },
            };
          }
          return { result: { value: { ok: true, ready: true, version: "0.3.0-stream" } } };
        }
        return {};
      },
    },
  };
  return { session, calls };
}

test("standalone runtime sync applies the one-second streaming overrides", async () => {
  for (const file of ["cdp-injector.mjs", "injected-renderer.mjs", "injection-plan.mjs"]) {
    const [generated, override] = await Promise.all([
      readFile(path.join(prototypeRoot, "bridge-runtime", "src", file), "utf8"),
      readFile(path.join(prototypeRoot, "bridge-overrides", "src", file), "utf8"),
    ]);
    assert.equal(generated, override, file);
  }
  const manifest = JSON.parse(await readFile(
    path.join(prototypeRoot, "bridge-runtime", "runtime-manifest.json"),
    "utf8",
  ));
  assert.ok(manifest.overrides.includes("one-second-range-streaming"));
  assert.ok(!manifest.overrides.includes("large-video-cdp-blob-transfer"));
});

test("bootstrap and apply payloads stay small and never contain media Base64", () => {
  const plan = injection();
  assert.ok(plan.metrics.bootstrapBytes < 100 * 1024, plan.metrics.bootstrapBytes);
  assert.ok(plan.metrics.applyBytes < 10 * 1024, plan.metrics.applyBytes);
  assert.doesNotMatch(plan.bootstrapScript, /data:video|;base64,/i);
  assert.doesNotMatch(plan.applyScript, /data:video|;base64,/i);
  assert.match(plan.applyScript, /http:\/\/127\.0\.0\.1/);
  assert.match(plan.bootstrapScript, /srcdoc/);
  assert.match(plan.bootstrapScript, /cwb-media-frame/);
  assert.doesNotMatch(plan.bootstrapScript, /WebSocket\(|Fetch\.enable|createObjectURL/i);
  assert.equal(Object.hasOwn(plan, "mediaRoute"), false);
});

test("media size metadata does not change the CDP payload", () => {
  const sizes = [1 * 1024 * 1024, 500 * 1024 * 1024, 10 * 1024 ** 3];
  const plans = sizes.map(() => injection());
  assert.deepEqual(plans.map((plan) => plan.metrics.bootstrapBytes), [
    plans[0].metrics.bootstrapBytes,
    plans[0].metrics.bootstrapBytes,
    plans[0].metrics.bootstrapBytes,
  ]);
  assert.deepEqual(plans.map((plan) => plan.metrics.applyBytes), [
    plans[0].metrics.applyBytes,
    plans[0].metrics.applyBytes,
    plans[0].metrics.applyBytes,
  ]);
});

test("injection plan accepts only its token-scoped loopback media URLs", () => {
  const unsafeInventory = videoInventory();
  unsafeInventory.projects[0].mediaUrl = "https://example.com/video.mp4";
  assert.throws(
    () => buildInjectionPlan({
      server: serverDescriptor,
      config: { selectedId: "large-video" },
      inventory: unsafeInventory,
    }),
    /不属于当前本机壁纸服务/,
  );
  assert.throws(
    () => buildInjectionPlan({
      server: { ...serverDescriptor, basePath: "/short" },
      config: { selectedId: "large-video" },
      inventory: videoInventory(),
    }),
    /不属于当前本机壁纸服务/,
  );
});

test("injector installs bootstrap once and applies lightweight config separately", async () => {
  const statuses = [];
  const injector = new CdpWallpaperInjector({ onStatus: (status) => statuses.push(status) });
  const { session, calls } = fakeSession();
  const plan = injection();

  await injector.installScript(session, plan);
  await injector.installScript(session, plan);

  assert.equal(calls.filter(({ method }) => method.startsWith("Fetch.")).length, 0);
  assert.equal(calls.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
  const evaluations = calls.filter(({ method }) => method === "Runtime.evaluate");
  assert.equal(evaluations.length, 3);
  assert.equal(evaluations.filter(({ params }) => params.expression.includes("runtime.apply")).length, 2);
  assert.equal(evaluations.filter(({ params }) => !params.expression.includes("runtime.apply")).length, 1);

  assert.ok(statuses.some(({ type }) => type === "injection-ready"));
});

test("renderer verification failures reject the injection instead of reporting success", async () => {
  const injector = new CdpWallpaperInjector({ installOnNewDocument: false });
  const { session } = fakeSession();
  const originalCall = session.socket.call;
  session.socket.call = async (method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("runtime.apply")) {
      return { result: { value: { ok: true, runtimeReady: true, domReady: false } } };
    }
    return originalCall(method, params);
  };
  await assert.rejects(injector.installScript(session, injection()), /DOM application verification failed/);
});

test("media server supports HEAD, byte ranges, and rejects invalid ranges", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cwb-range-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const mediaPath = path.join(temporaryRoot, "sample.mp4");
  const previewPath = path.join(temporaryRoot, "preview.jpg");
  await Promise.all([
    writeFile(mediaPath, Buffer.from("0123456789abcdef")),
    writeFile(previewPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  ]);
  const server = createMediaServer({
    token,
    projects: [{
      id: "range-video",
      title: "Range video",
      type: "video",
      rootPath: temporaryRoot,
      mediaPath,
      previewPath,
      playable: true,
    }],
  });
  await server.start();
  context.after(() => server.close());
  const mediaUrl = new URL("api/video/range-video", server.baseUrl);

  const head = await fetch(mediaUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-length"), "16");

  const partial = await fetch(mediaUrl, { headers: { Range: "bytes=4-7" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 4-7/16");
  assert.equal(await partial.text(), "4567");

  const invalid = await fetch(mediaUrl, { headers: { Range: "bytes=99-120" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */16");
});

test("resident action endpoint preserves renderer verification failures", async (context) => {
  const server = createMediaServer({
    token,
    projects: [],
    onAction: async () => {
      throw new Error("renderer verification failed");
    },
  });
  await server.start();
  context.after(() => server.close());

  const response = await fetch(new URL("api/action", server.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "inject" }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "renderer verification failed",
  });
});

test("restore removes the streaming runtime without Blob transfer cleanup", () => {
  const bootstrap = buildBootstrapScript();
  const apply = buildApplyScript({ wallpaper: null });
  const restore = buildRestoreScript();
  assert.match(bootstrap, /0\.3\.0-stream/);
  assert.match(apply, /runtime\.apply/);
  assert.match(restore, /runtime\?\.restore/);
  assert.doesNotMatch(`${bootstrap}\n${apply}\n${restore}`, /AssetTransfer|createObjectURL|;base64,|Fetch\.enable/i);
});
