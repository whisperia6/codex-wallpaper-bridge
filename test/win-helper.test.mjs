import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { clearWinHelperPathCache, resolveWinHelperPath, tryRunWinHelper } from "../src/win-helper.mjs";

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" };

test("resolveWinHelperPath returns null on non-Windows platforms", () => {
  assert.equal(resolveWinHelperPath("linux"), null);
  assert.equal(resolveWinHelperPath("darwin"), null);
});

test("compiled cwb-win-helper.exe verifies a live loopback TCP listener and returns narrow owner evidence", windowsOnly, async (t) => {
  clearWinHelperPathCache();
  const builtHelper = resolveWinHelperPath("win32");
  if (!builtHelper) {
    t.skip("cwb-win-helper.exe has not been compiled yet");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cwb-win-helper-test-"));
  const runnableHelper = path.join(tempDir, "cwb-win-helper.exe");
  await copyFile(builtHelper, runnableHelper);

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  try {
    const { stdout } = await execFileAsync(runnableHelper, ["verify-cdp-owner"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
      env: {
        ...process.env,
        CWB_CDP_OWNER_PORT: String(port),
        CWB_CDP_EXPECTED_PROCESS: "",
      },
    });
    const evidence = JSON.parse(stdout.trim());
    assert.ok(Array.isArray(evidence.listeners));
    assert.equal(evidence.listeners.length, 1);
    assert.equal(evidence.listeners[0].localAddress, "127.0.0.1");
    assert.equal(evidence.listeners[0].localPort, port);
    assert.equal(evidence.listeners[0].owningProcess, process.pid);
    assert.equal(evidence.owners.length, 1);
    assert.equal(evidence.owners[0].processId, process.pid);
    assert.equal(path.win32.normalize(evidence.owners[0].executablePath).toLowerCase(),
      path.win32.normalize(await realpath(process.execPath)).toLowerCase());
    assert.ok(Array.isArray(evidence.owners[0].remoteDebuggingPorts));
    assert.equal(typeof evidence.owners[0].hasInvalidRemoteDebuggingPort, "boolean");
    // Raw command line must never leak in stdout
    assert.equal("commandLine" in evidence.owners[0], false);
    assert.equal("CommandLine" in evidence.owners[0], false);

    // Unused port returns empty listeners/owners quickly without WMI
    const empty = await execFileAsync(runnableHelper, ["verify-cdp-owner"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
      env: {
        ...process.env,
        CWB_CDP_OWNER_PORT: "59993",
        CWB_CDP_EXPECTED_PROCESS: "",
      },
    });
    assert.deepEqual(JSON.parse(empty.stdout.trim()), { listeners: [], owners: [] });

    // Running Codex listing returns valid JSON array
    const running = await execFileAsync(runnableHelper, ["list-running-codex"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
    });
    assert.ok(Array.isArray(JSON.parse(running.stdout.trim())));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tryRunWinHelper returns null cleanly on non-Windows", async () => {
  const result = await tryRunWinHelper("list-running-codex", {}, "linux");
  assert.equal(result, null);
});
