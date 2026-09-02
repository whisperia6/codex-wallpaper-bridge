import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import {
  buildBridgeArguments,
  invokeBridgeAction,
  parseControlUrl,
  resolveBridgeRoot,
  resolveBridgeUtilityPath,
  stripAnsi,
} from "../src/bridge-runner.mjs";

test("streaming injection is routed through the resident control service", () => {
  assert.throws(() => buildBridgeArguments("inject", 9335), /常驻壁纸面板/);
  assert.deepEqual(buildBridgeArguments("restore", 9446), [
    "restore",
    "--cdp-port",
    "9446",
  ]);
});

test("resident control actions use only a token-scoped loopback URL", async (context) => {
  const received = [];
  const token = "1234567890abcdef1234567890abcdef";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    const body = Buffer.from(JSON.stringify({ ok: true, message: "injected" }));
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const result = await invokeBridgeAction({
    controlUrl: `http://127.0.0.1:${port}/${token}/`,
    action: "inject",
  });
  assert.equal(result.message, "injected");
  assert.deepEqual(received, [{
    url: `/${token}/api/action`,
    body: { action: "inject" },
  }]);
  await assert.rejects(
    invokeBridgeAction({ controlUrl: `http://localhost:${port}/${token}/`, action: "inject" }),
    /受信任/,
  );
  await assert.rejects(
    invokeBridgeAction({ controlUrl: `http://127.0.0.1:${port}/${token}/?redirect=1`, action: "inject" }),
    /受信任/,
  );
});

test("preview URL is parsed from Chinese bridge output", () => {
  const output = "扫描完成：20 个项目\r\n控制与预览：http://127.0.0.1:43100/token/\r\n";
  assert.equal(parseControlUrl(output), "http://127.0.0.1:43100/token/");
});

test("ANSI status colors are removed before logs enter the renderer", () => {
  assert.equal(stripAnsi("\u001b[32m完成\u001b[0m"), "完成");
});

test("unsupported bridge commands are rejected", () => {
  assert.throws(() => buildBridgeArguments("remove", 9335), /不支持/);
});

test("packaged bridge resolves only the compiled worker outside ASAR", () => {
  const appPath = path.join("D:\\app", "resources", "app.asar");
  const resourcesPath = path.join("D:\\app", "resources");
  assert.equal(
    resolveBridgeRoot({ isPackaged: true, appPath, resourcesPath }),
    path.join(resourcesPath, "app.asar.unpacked", "dist", "bridge-runtime"),
  );
  assert.equal(
    resolveBridgeRoot({ isPackaged: false, appPath: "D:\\source" }),
    path.join("D:\\source", "bridge-runtime"),
  );
  assert.equal(
    resolveBridgeUtilityPath({
      isPackaged: true,
      compiledRoot: path.join(appPath, "dist"),
      resourcesPath,
    }),
    path.join(resourcesPath, "app.asar.unpacked", "dist", "bridge-utility-entry.mjs"),
  );
});
