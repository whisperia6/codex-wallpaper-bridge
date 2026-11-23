import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isCdpEndpointReady } from "./cdp-client.mjs";
import { validateCdpPort, validateExecutable } from "./installations.mjs";
import { tryRunWinHelper } from "./win-helper.mjs";

const execFileAsync = promisify(execFile);
const CLOSE_TIMEOUT_MS = 12_000;
const STORE_AUMID_PATTERN = /^[A-Za-z0-9._-]{1,128}![A-Za-z0-9._-]{1,64}$/;
const ACTIVATE_STORE_APP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$aumid = [string]$env:CWB_STORE_AUMID
$arguments = [string]$env:CWB_STORE_ARGS
if ([string]::IsNullOrWhiteSpace($aumid)) { throw 'Missing Store AUMID' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public enum CwbActivateOptions { None = 0 }

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICwbApplicationActivationManager {
  int ActivateApplication(
    [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
    [In] CwbActivateOptions options,
    [Out] out uint processId
  );
}

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class CwbApplicationActivationManager {}

public static class CwbStoreActivator {
  public static uint Activate(string aumid, string arguments) {
    var manager = (ICwbApplicationActivationManager)(new CwbApplicationActivationManager());
    uint pid;
    int hr = manager.ActivateApplication(aumid, arguments ?? "", CwbActivateOptions.None, out pid);
    if (hr != 0) throw new COMException("ActivateApplication failed", hr);
    return pid;
  }
}
'@

$launchedPid = [CwbStoreActivator]::Activate($aumid, $arguments)
[pscustomobject]@{ processId = [int]$launchedPid } | ConvertTo-Json -Compress
`;
const CLOSE_CODEX_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPath = [IO.Path]::GetFullPath($env:CWB_TARGET_EXE)
$closeTimeoutMs = [Math]::Max(1000, [int]$env:CWB_CLOSE_TIMEOUT_MS)

function Find-TargetCodexProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    try {
      return [string]::Equals(
        [IO.Path]::GetFullPath($_.ExecutablePath),
        $targetPath,
        [StringComparison]::OrdinalIgnoreCase
      )
    } catch {
      return $false
    }
  })
}

$matched = @(Find-TargetCodexProcesses)
if ($env:CWB_EXPECTED_PROCESSES) {
  $expected = @($env:CWB_EXPECTED_PROCESSES | ConvertFrom-Json)
  $roots = @($matched | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })
  if ($roots.Count -ne $expected.Count) { throw 'Codex process set changed; takeover canceled' }
  foreach ($entry in $expected) {
    $found = @($roots | Where-Object { $_.ProcessId -eq $entry.processId -and $_.CommandLine -ceq $entry.commandLine })
    if ($found.Count -ne 1 -or $found[0].CommandLine -match '--remote-debugging-port') {
      throw 'Codex process identity changed; takeover canceled'
    }
  }
  # Automatic takeover closes only the explicitly confirmed parent PIDs.
  $matched = $roots
}
$matchedProcessIds = @($matched | ForEach-Object { [int]$_.ProcessId })
foreach ($processIdentifier in $matchedProcessIds) {
  Stop-Process -Id $processIdentifier -Force -ErrorAction SilentlyContinue
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($closeTimeoutMs)
do {
  $remaining = @(Find-TargetCodexProcesses)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)

$remainingProcessIds = @($remaining | ForEach-Object { [int]$_.ProcessId })
[pscustomobject]@{
  matchedProcessIds = $matchedProcessIds
  remainingProcessIds = $remainingProcessIds
} | ConvertTo-Json -Compress
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeProcessIds(value) {
  const values = value === null || value === undefined
    ? []
    : Array.isArray(value) ? value : [value];
  return values
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function parseCloseResult(output) {
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("关闭 Codex 后没有收到进程校验结果");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("关闭 Codex 后的进程校验结果无效");
  }
  return {
    matchedProcessIds: normalizeProcessIds(parsed?.matchedProcessIds),
    remainingProcessIds: normalizeProcessIds(parsed?.remainingProcessIds),
  };
}

export function profileDirectoryName(executablePath) {
  const normalizedPath = path.win32.normalize(String(executablePath || "")).toLowerCase();
  const digest = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
  return `codex-${digest}`;
}

export function buildCodexArguments({ port, profilePath }) {
  const normalizedPort = validateCdpPort(port);
  if (!profilePath) throw new Error("缺少 Codex 独立 profile 路径");
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${normalizedPort}`,
    `--user-data-dir=${profilePath}`,
  ];
}

export function formatWindowsArgumentLine(args) {
  return (Array.isArray(args) ? args : []).map((value) => {
    const text = String(value);
    if (!/[\s"]/.test(text)) return text;
    return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }).join(" ");
}

async function activateStoreCodex({
  appUserModelId,
  args,
  signal,
  processRunner,
}) {
  signal?.throwIfAborted();
  if (typeof appUserModelId !== "string" || !STORE_AUMID_PATTERN.test(appUserModelId)) {
    throw new Error("无效的 Store 应用标识");
  }
  const execOptions = {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 15_000,
    windowsHide: true,
    signal,
    env: {
      ...process.env,
      CWB_STORE_AUMID: appUserModelId,
      CWB_STORE_ARGS: formatWindowsArgumentLine(args),
    },
  };
  const helperResult = processRunner === undefined
    ? await tryRunWinHelper("activate-store-app", execOptions)
    : null;
  const { stdout } = helperResult ?? await (processRunner ?? execFileAsync)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ACTIVATE_STORE_APP_SCRIPT],
    execOptions,
  );
  const parsed = JSON.parse(String(stdout || "").replace(/^\uFEFF/, "").trim());
  const processId = Number(parsed?.processId);
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error("Store 激活未返回有效进程 ID");
  }
  return { processId };
}

export async function closeCodexProcesses({
  installation,
  expectedProcesses,
  signal,
  timeoutMs = CLOSE_TIMEOUT_MS,
  onLog = () => {},
  processRunner,
  validateExecutableFn = validateExecutable,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("关闭 Codex 的等待时间必须在 1 到 30 秒之间");
  }
  signal?.throwIfAborted();
  if (expectedProcesses !== undefined && (!Array.isArray(expectedProcesses) || !expectedProcesses.length
    || expectedProcesses.some(p => !Number.isInteger(p?.processId) || p.processId <= 0
      || typeof p.commandLine !== 'string' || !p.commandLine || p.commandLine.includes('--remote-debugging-port')))) {
    throw new Error('自动接管进程清单无效');
  }
  const executablePath = await validateExecutableFn(installation?.path);
  signal?.throwIfAborted();
  onLog({ stream: "system", text: `正在关闭选中版本的 Codex（${expectedProcesses?.length ?? installation?.processIds?.length ?? 0} 个已发现进程）…\n` });
  const execOptions = {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs + 5_000,
    windowsHide: true,
    env: {
      ...process.env,
      CWB_TARGET_EXE: executablePath,
      CWB_CLOSE_TIMEOUT_MS: String(timeoutMs),
      CWB_EXPECTED_PROCESSES: expectedProcesses === undefined ? '' : JSON.stringify(
        expectedProcesses.map(({ processId, commandLine }) => ({ processId, commandLine }))),
    },
  };
  const helperResult = processRunner === undefined
    ? await tryRunWinHelper("close-codex-processes", execOptions)
    : null;
  const { stdout } = helperResult ?? await (processRunner ?? execFileAsync)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", CLOSE_CODEX_SCRIPT],
    execOptions,
  );
  const result = parseCloseResult(stdout);
  if (result.remainingProcessIds.length > 0) {
    throw new Error(`关闭超时：选中版本仍有 ${result.remainingProcessIds.length} 个进程在运行`);
  }
  onLog({ stream: "system", text: `已关闭选中版本的 ${result.matchedProcessIds.length} 个 Codex 进程。\n` });
  return {
    closedCount: result.matchedProcessIds.length,
    processIds: result.matchedProcessIds,
  };
}

async function waitForEndpoint(port, timeoutMs, signal, isEndpointReady) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const ready = await isEndpointReady(port);
    signal?.throwIfAborted();
    if (ready) return true;
    await delay(120);
  }
  return false;
}

export async function launchCodex({
  installation,
  port,
  profileRoot,
  timeoutMs = 25_000,
  onLog = () => {},
  signal,
  isEndpointReady = isCdpEndpointReady,
  validateExecutableFn = validateExecutable,
  mkdirFn = mkdir,
  spawnImpl = spawn,
  activateStoreApp = activateStoreCodex,
  killProcessFn = (pid) => process.kill(pid),
}) {
  signal?.throwIfAborted();
  const normalizedPort = validateCdpPort(port);
  const ready = await isEndpointReady(normalizedPort);
  signal?.throwIfAborted();
  if (ready) {
    return { connected: true, alreadyListening: true, processId: null };
  }
  if (installation?.isRunning) {
    throw new Error("这个 Codex 已在普通模式运行。请保存输入并完全退出它，再由桌面版启动调试实例。");
  }
  const executablePath = await validateExecutableFn(installation?.path);
  signal?.throwIfAborted();
  const profilePath = path.join(profileRoot, profileDirectoryName(executablePath));
  await mkdirFn(profilePath, { recursive: true });
  signal?.throwIfAborted();
  const args = buildCodexArguments({ port: normalizedPort, profilePath });
  let launchedPid = null;
  let cleanupLaunched = () => {};

  if (installation?.kind === "store" && typeof installation.appUserModelId === "string"
    && STORE_AUMID_PATTERN.test(installation.appUserModelId) && typeof activateStoreApp === "function") {
    try {
      onLog({ stream: "system", text: `通过 Microsoft Store 身份启动 ${installation.appUserModelId}\n` });
      const activated = await activateStoreApp({
        appUserModelId: installation.appUserModelId,
        args,
        signal,
      });
      launchedPid = activated.processId;
      cleanupLaunched = () => {
        try { killProcessFn(launchedPid); } catch {}
      };
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      onLog({ stream: "system", text: `Store 身份启动未完成，回退为直接启动可执行文件：${error.message}\n` });
    }
  }

  if (launchedPid === null) {
    onLog({ stream: "system", text: `启动 ${executablePath}\n` });
    const child = spawnImpl(executablePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    launchedPid = child.pid;
    cleanupLaunched = () => {
      try { child.kill(); } catch {}
    };
  }

  try {
    if (!await waitForEndpoint(normalizedPort, timeoutMs, signal, isEndpointReady)) {
      throw new Error(`Codex 已启动，但 ${timeoutMs / 1000} 秒内没有监听 CDP 端口 ${normalizedPort}`);
    }
  } catch (error) {
    // Only our newly launched, not-yet-ready process is cleaned up. Never kill
    // an existing endpoint reused above or another same-path instance.
    cleanupLaunched();
    throw error;
  }
  return {
    connected: true,
    alreadyListening: false,
    processId: launchedPid,
    profilePath,
  };
}
