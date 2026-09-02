import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInstallations,
  parsePowerShellJson,
  validateCdpPort,
} from "../src/installations.mjs";

test("parsePowerShellJson normalizes empty, single, and array output", () => {
  assert.deepEqual(parsePowerShellJson(""), []);
  assert.deepEqual(parsePowerShellJson('{"Name":"OpenAI.Codex"}'), [{ Name: "OpenAI.Codex" }]);
  assert.deepEqual(parsePowerShellJson('[{"Name":"one"},{"Name":"two"}]'), [
    { Name: "one" },
    { Name: "two" },
  ]);
});

test("normalizeInstallations merges a running Store executable and keeps a local build", () => {
  const installations = normalizeInstallations({
    storePackages: [{
      Name: "OpenAI.Codex",
      Version: "151.0.8000.10",
      InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_151",
    }],
    runningProcesses: [
      {
        ExecutablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_151\\app\\ChatGPT.exe",
        ProcessId: 1200,
      },
      {
        ExecutablePath: "D:\\Work\\Codex\\ChatGPT.exe",
        ProcessId: 2200,
      },
    ],
  });

  assert.equal(installations.length, 2);
  assert.deepEqual(installations[0], {
    id: "store:openai.codex",
    kind: "store",
    label: "Microsoft Store 版",
    path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_151\\app\\ChatGPT.exe",
    version: "151.0.8000.10",
    isRunning: true,
    processIds: [1200],
  });
  assert.equal(installations[1].kind, "local");
  assert.equal(installations[1].path, "D:\\Work\\Codex\\ChatGPT.exe");
  assert.deepEqual(installations[1].processIds, [2200]);
});

test("normalizeInstallations accepts and de-duplicates manually selected executables", () => {
  const installations = normalizeInstallations({
    manualExecutables: [
      "D:\\Apps\\Codex\\ChatGPT.exe",
      "d:\\apps\\codex\\CHATGPT.EXE",
    ],
  });

  assert.equal(installations.length, 1);
  assert.equal(installations[0].kind, "local");
  assert.equal(installations[0].isRunning, false);
});

test("validateCdpPort accepts the supported range and rejects unsafe values", () => {
  assert.equal(validateCdpPort(9335), 9335);
  assert.equal(validateCdpPort("9446"), 9446);
  assert.throws(() => validateCdpPort(80), /1024/);
  assert.throws(() => validateCdpPort(65536), /65535/);
  assert.throws(() => validateCdpPort("9335;Remove-Item"), /整数/);
});
