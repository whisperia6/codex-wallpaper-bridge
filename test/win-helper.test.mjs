import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { clearWinHelperPathCache, queryWindowOcclusion, resolveWinHelperPath, tryRunWinHelper } from "../src/win-helper.mjs";

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

test("window occlusion validates PID arguments, helper output and fails open", async () => {
  const calls = [];
  const runWinHelper = async (...args) => {
    calls.push(args);
    return { stdout: '{"ok":true,"occluded":true,"targetCount":2}' };
  };
  assert.deepEqual(await queryWindowOcclusion([42, 42, 86], { platform: "win32", runWinHelper }),
    { occluded: true, targetCount: 2 });
  assert.equal(calls[0][0], "window-occlusion");
  assert.deepEqual(calls[0][1].args, ["42", "86"]);
  assert.equal(calls[0][1].timeout, 1200);
  for (const [pids, platform] of [[[42], "linux"], [["42&dir"], "win32"], [[0], "win32"], [[], "win32"]]) {
    assert.deepEqual(await queryWindowOcclusion(pids, { platform, runWinHelper }), { occluded: false });
  }
  assert.equal(calls.length, 1);
  for (const fail of [async () => null, async () => ({ stdout: "invalid" }), async () => { throw Error("timeout"); }]) {
    assert.deepEqual(await queryWindowOcclusion([42], { platform: "win32", runWinHelper: fail }), { occluded: false });
  }
  assert.deepEqual(await queryWindowOcclusion([42], { platform: "win32", runWinHelper: async () => ({
    stdout: '{"ok":true,"occluded":true,"targetCount":0}',
  }) }), { occluded: false, targetCount: 0 });
});

test("compiled window-occlusion helper returns no target for an unassigned PID", windowsOnly, async (t) => {
  if (!resolveWinHelperPath()) return t.skip("cwb-win-helper.exe has not been compiled yet");
  const result = await tryRunWinHelper("window-occlusion", { args: ["4294967295"], timeout: 8000 });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, occluded: false, targetCount: 0 });
  await assert.rejects(tryRunWinHelper("window-occlusion", { args: ["1&dir"], timeout: 8000 }), /Invalid target process ID/);
});

test("native rectangle coverage handles joint covers, holes, negative coordinates and work limits", windowsOnly, async (t) => {
  const helper = resolveWinHelperPath();
  if (!helper) return t.skip("cwb-win-helper.exe has not been compiled yet");
  const script = `
    $ErrorActionPreference = 'Stop'
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($env:CWB_TEST_OCCLUSION_HELPER))
    $type = $assembly.GetType('CwbWinHelper.WindowOcclusion', $true)
    $rect = $type.GetNestedType('Rect', [Reflection.BindingFlags]::NonPublic)
    $list = [Collections.Generic.List[Object]].GetGenericTypeDefinition().MakeGenericType($rect)
    $covered = $type.GetMethod('IsCovered', [Reflection.BindingFlags]'NonPublic, Static')
    function NewRect([int]$l, [int]$t, [int]$r, [int]$b) {
      [Activator]::CreateInstance($rect, [object[]]@($l, $t, $r, $b))
    }
    $target = NewRect -100 0 0 200
    $covers = [Activator]::CreateInstance($list)
    $covers.Add((NewRect -120 -10 -50 210))
    $partial = $covered.Invoke($null, @($target, $covers))
    $covers.Add((NewRect -50 -10 10 210))
    $complete = $covered.Invoke($null, @($target, $covers))
    $covers.Clear()
    $covers.Add((NewRect -120 -10 -51 210))
    $covers.Add((NewRect -50 -10 10 210))
    $gap = $covered.Invoke($null, @($target, $covers))
    $target = NewRect 0 0 40 40
    $covers.Clear()
    for ($i = 1; $i -le 29; $i += 2) {
      $covers.Add((NewRect $i 0 ($i + 1) 40))
      $covers.Add((NewRect 0 $i 40 ($i + 1)))
    }
    $covers.Add($target)
    $atFragmentLimit = $covered.Invoke($null, @($target, $covers))
    $covers.Insert(30, (NewRect 0 31 40 32))
    $overFragmentLimit = $covered.Invoke($null, @($target, $covers))

    $covers.Clear()
    $outside = NewRect 50 50 60 60
    for ($i = 0; $i -lt 4095; $i++) { $covers.Add($outside) }
    $covers.Add($target)
    $atOperationLimit = $covered.Invoke($null, @($target, $covers))
    $covers.Insert(0, $outside)
    $overOperationLimit = $covered.Invoke($null, @($target, $covers))
    @{
      partial = $partial; complete = $complete; gap = $gap
      atFragmentLimit = $atFragmentLimit; overFragmentLimit = $overFragmentLimit
      atOperationLimit = $atOperationLimit; overOperationLimit = $overOperationLimit
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 8000, windowsHide: true, env: { ...process.env, CWB_TEST_OCCLUSION_HELPER: helper },
  });
  assert.deepEqual(JSON.parse(stdout), {
    partial: false, complete: true, gap: false,
    atFragmentLimit: true, overFragmentLimit: false,
    atOperationLimit: true, overOperationLimit: false,
  });
});

test("native layered window rules keep alpha-250 targets visible without treating them as opaque covers", windowsOnly, async (t) => {
  const helper = resolveWinHelperPath();
  if (!helper) return t.skip("cwb-win-helper.exe has not been compiled yet");
  const script = `
    $ErrorActionPreference = 'Stop'
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($env:CWB_TEST_OCCLUSION_HELPER))
    $type = $assembly.GetType('CwbWinHelper.WindowOcclusion', $true)
    $qualifies = $type.GetMethod('LayeredWindowQualifies', [Reflection.BindingFlags]'NonPublic, Static')
    @{
      semiTransparentTarget = $qualifies.Invoke($null, @($true, $true, [byte]250, [uint32]2))
      semiTransparentCover = $qualifies.Invoke($null, @($false, $true, [byte]250, [uint32]2))
      transparentTarget = $qualifies.Invoke($null, @($true, $true, [byte]0, [uint32]2))
      opaqueCover = $qualifies.Invoke($null, @($false, $true, [byte]255, [uint32]2))
      colorKeyCover = $qualifies.Invoke($null, @($false, $true, [byte]255, [uint32]3))
      perPixelTarget = $qualifies.Invoke($null, @($true, $false, [byte]0, [uint32]0))
      perPixelCover = $qualifies.Invoke($null, @($false, $false, [byte]0, [uint32]0))
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 8000, windowsHide: true, env: { ...process.env, CWB_TEST_OCCLUSION_HELPER: helper },
  });
  assert.deepEqual(JSON.parse(stdout), {
    semiTransparentTarget: true, semiTransparentCover: false, transparentTarget: false,
    opaqueCover: true, colorKeyCover: false, perPixelTarget: true, perPixelCover: false,
  });
});
