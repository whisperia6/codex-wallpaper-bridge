import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexArguments,
  closeCodexProcesses,
  profileDirectoryName,
} from "../src/codex-launcher.mjs";

test("Codex launches CDP on loopback with an isolated profile", () => {
  assert.deepEqual(buildCodexArguments({ port: 9336, profilePath: "C:\\Temp\\Codex Store" }), [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9336",
    "--user-data-dir=C:\\Temp\\Codex Store",
  ]);
});

test("profile directory names are stable, safe, and distinct by executable path", () => {
  const store = profileDirectoryName("C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe");
  const local = profileDirectoryName("D:\\Work\\Codex\\ChatGPT.exe");

  assert.match(store, /^codex-[a-f0-9]{12}$/);
  assert.notEqual(store, local);
  assert.equal(store, profileDirectoryName("c:\\PROGRAM FILES\\WindowsApps\\OpenAI.Codex\\app\\chatgpt.exe"));
});

test("closing Codex passes the selected executable through the environment and verifies no processes remain", async () => {
  const executablePath = "D:\\Portable Apps\\Codex\\ChatGPT.exe";
  const calls = [];
  const result = await closeCodexProcesses({
    installation: {
      path: executablePath,
      isRunning: true,
      processIds: [4100, 4200],
    },
    processRunner: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({ matchedProcessIds: [4100, 4200], remainingProcessIds: [] }),
      };
    },
    validateExecutableFn: async (value) => value,
  });

  assert.equal(result.closedCount, 2);
  assert.deepEqual(result.processIds, [4100, 4200]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.env.CWB_TARGET_EXE, executablePath);
  assert.doesNotMatch(calls[0].args.join(" "), /D:\\\\Portable Apps\\\\Codex/);
});

test("closing Codex fails when the selected executable still has running processes", async () => {
  await assert.rejects(() => closeCodexProcesses({
    installation: {
      path: "D:\\Work\\Codex\\ChatGPT.exe",
      isRunning: true,
      processIds: [5100],
    },
    processRunner: async () => ({
      stdout: JSON.stringify({ matchedProcessIds: [5100], remainingProcessIds: [5100] }),
    }),
    validateExecutableFn: async (value) => value,
  }), /仍有 1 个进程/);
});
