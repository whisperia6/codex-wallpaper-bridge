import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildBridgeArguments,
  parseControlUrl,
  resolveBridgeRoot,
  resolveBridgeUtilityPath,
  stripAnsi,
} from "../src/bridge-runner.mjs";

test("one-shot bridge arguments preserve the existing CLI contract", () => {
  assert.deepEqual(buildBridgeArguments("inject", 9335), [
    "inject",
    "--cdp-port",
    "9335",
    "--once",
    "--no-open",
  ]);
  assert.deepEqual(buildBridgeArguments("restore", 9446), [
    "restore",
    "--cdp-port",
    "9446",
  ]);
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
