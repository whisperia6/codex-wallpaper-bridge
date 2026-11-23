import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInstallations,
  parsePowerShellJson,
  selectInstallationId,
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

test("normalizeInstallations includes a registered local build without manual selection", () => {
  const installations = normalizeInstallations({
    localInstallations: [{
      ExecutablePath: "D:\\codex\\ChatGPT.exe",
      ProductVersion: "151.0.7922.170",
    }],
  });

  assert.equal(installations.length, 1);
  assert.equal(installations[0].kind, "local");
  assert.equal(installations[0].label, "本地 EXE 版（自动发现）");
  assert.equal(installations[0].path, "D:\\codex\\ChatGPT.exe");
  assert.equal(installations[0].version, "151.0.7922.170");
  assert.equal(installations[0].isRunning, false);
});

test("a running process is merged into an automatically discovered local build", () => {
  const installations = normalizeInstallations({
    localInstallations: [{
      ExecutablePath: "D:\\codex\\ChatGPT.exe",
      ProductVersion: "151.0.7922.170",
    }],
    runningProcesses: [{
      ExecutablePath: "d:\\CODEX\\chatgpt.exe",
      ProductVersion: "151.0.7922.170",
      ProcessId: 4242,
    }],
    manualExecutables: ["D:\\Codex\\ChatGPT.exe"],
  });

  assert.equal(installations.length, 1);
  assert.equal(installations[0].label, "本地 EXE 版（自动发现）");
  assert.equal(installations[0].isRunning, true);
  assert.deepEqual(installations[0].processIds, [4242]);
});

test("validateCdpPort accepts the supported range and rejects unsafe values", () => {
  assert.equal(validateCdpPort(9335), 9335);
  assert.equal(validateCdpPort("9446"), 9446);
  assert.throws(() => validateCdpPort(80), /1024/);
  assert.throws(() => validateCdpPort(65536), /65535/);
  assert.throws(() => validateCdpPort("9335;Remove-Item"), /整数/);
});

test("default selection prefers a running local installation over a stopped Store installation", () => {
  const choices = [{ id: "store", isRunning: false }, { id: "local", isRunning: true }];
  assert.equal(selectInstallationId(choices, null), "local");
  assert.equal(selectInstallationId(choices, "removed"), "local");
  assert.deepEqual(choices.map(({ id }) => id), ["store", "local"], "selection must not reorder discovery results");
});

test("a valid remembered selection is never silently changed to another running installation", () => {
  const choices = [{ id: "store", isRunning: false }, { id: "local", isRunning: true }];
  assert.equal(selectInstallationId(choices, "store"), "store");
  assert.equal(selectInstallationId(choices, "local"), "local");
});

test("selection has deterministic fallbacks for no running installations, multiple running installations, and no installations", () => {
  assert.equal(selectInstallationId([{ id: "store", isRunning: false }, { id: "local", isRunning: false }], null), "store");
  assert.equal(selectInstallationId([{ id: "store", isRunning: true }, { id: "local", isRunning: true }], null), "store");
  assert.equal(selectInstallationId([], "removed"), null);
});

test("normalizeInstallations exposes validated Store appUserModelId when PackageFamilyName is present", () => {
  const installations = normalizeInstallations({
    storePackages: [{
      Name: "OpenAI.Codex",
      Version: "26.1117.4957.0",
      InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26",
      PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      ApplicationId: "App",
    }],
  });
  assert.equal(installations[0].appUserModelId, "OpenAI.Codex_2p2nqsd0c76g0!App");

  const unsafe = normalizeInstallations({
    storePackages: [{
      Name: "OpenAI.Codex",
      Version: "26.1117.4957.0",
      InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26",
      PackageFamilyName: "bad family;name",
    }],
  });
  assert.equal("appUserModelId" in unsafe[0], false);
});
