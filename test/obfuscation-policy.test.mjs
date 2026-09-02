import assert from "node:assert/strict";
import test from "node:test";
import JavaScriptObfuscator from "javascript-obfuscator";
import { createObfuscationOptions } from "../scripts/obfuscation-policy.mjs";

test("bridge obfuscation keeps serialized renderer functions self-contained", () => {
  const source = `
    function rendererBootstrap(payload) {
      return payload.prefix + ":" + payload.value;
    }
    const serialized = "(" + rendererBootstrap.toString() + ")({prefix:'ok',value:42})";
    globalThis.__cwbSerializedResult = (0, eval)(serialized);
  `;
  const protectedSource = JavaScriptObfuscator.obfuscate(source, createObfuscationOptions({
    sourceType: "script",
    target: "node",
    preserveSerializedFunctions: true,
  })).getObfuscatedCode();

  const execute = new Function(protectedSource);
  execute();
  assert.equal(globalThis.__cwbSerializedResult, "ok:42");
  delete globalThis.__cwbSerializedResult;
});
