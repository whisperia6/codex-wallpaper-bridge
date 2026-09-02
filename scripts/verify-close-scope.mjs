import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeCodexProcesses } from "../src/codex-launcher.mjs";
import { detectInstallations } from "../src/installations.mjs";
import { assertChildPath } from "../src/package-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const outputRoot = path.join(prototypeRoot, "out");
const scratchRoot = assertChildPath(outputRoot, path.join(outputRoot, "close-scope-test"));
const dummyExecutable = path.join(scratchRoot, "ChatGPT.exe");
const pingExecutable = path.join(process.env.WINDIR || "C:\\Windows", "System32", "PING.EXE");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

await mkdir(outputRoot, { recursive: true });
await rm(scratchRoot, { recursive: true, force: true });
await mkdir(scratchRoot);
await copyFile(pingExecutable, dummyExecutable);

const before = await detectInstallations();
const originalProcessIds = before
  .filter(({ isRunning, path: executablePath }) => isRunning
    && path.win32.normalize(executablePath).toLowerCase()
      !== path.win32.normalize(dummyExecutable).toLowerCase())
  .flatMap(({ processIds }) => processIds);
const dummy = spawn(dummyExecutable, ["127.0.0.1", "-t"], {
  detached: false,
  stdio: "ignore",
  windowsHide: true,
});

try {
  await delay(500);
  assert.equal(isProcessAlive(dummy.pid), true, "临时 ChatGPT.exe 未能启动");
  const result = await closeCodexProcesses({
    installation: {
      path: dummyExecutable,
      isRunning: true,
      processIds: [dummy.pid],
    },
  });
  await delay(250);
  assert.equal(isProcessAlive(dummy.pid), false, "临时 ChatGPT.exe 仍在运行");
  if (originalProcessIds.length > 0) {
    assert.equal(
      originalProcessIds.some((processId) => isProcessAlive(processId)),
      true,
      "真实 Codex 进程不应被临时路径关闭测试影响",
    );
  }
  process.stdout.write(`${JSON.stringify({
    dummyClosed: result.closedCount,
    dummyRemaining: 0,
    originalProcessesObserved: originalProcessIds.length,
    originalProcessStillRunning: originalProcessIds.some((processId) => isProcessAlive(processId)),
  })}\n`);
} finally {
  if (isProcessAlive(dummy.pid)) dummy.kill();
  await rm(scratchRoot, { recursive: true, force: true });
}
