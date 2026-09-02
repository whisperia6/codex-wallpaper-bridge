import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isCdpEndpointReady } from "./cdp-client.mjs";
import { validateCdpPort, validateExecutable } from "./installations.mjs";

const execFileAsync = promisify(execFile);
const CLOSE_TIMEOUT_MS = 12_000;
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

export async function closeCodexProcesses({
  installation,
  timeoutMs = CLOSE_TIMEOUT_MS,
  onLog = () => {},
  processRunner = execFileAsync,
  validateExecutableFn = validateExecutable,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("关闭 Codex 的等待时间必须在 1 到 30 秒之间");
  }
  const executablePath = await validateExecutableFn(installation?.path);
  onLog({ stream: "system", text: `正在关闭选中版本的 Codex（${installation?.processIds?.length || 0} 个已发现进程）…\n` });
  const { stdout } = await processRunner(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", CLOSE_CODEX_SCRIPT],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs + 5_000,
      windowsHide: true,
      env: {
        ...process.env,
        CWB_TARGET_EXE: executablePath,
        CWB_CLOSE_TIMEOUT_MS: String(timeoutMs),
      },
    },
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

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpEndpointReady(port)) return true;
    await delay(350);
  }
  return false;
}

export async function launchCodex({
  installation,
  port,
  profileRoot,
  timeoutMs = 25_000,
  onLog = () => {},
}) {
  const normalizedPort = validateCdpPort(port);
  if (await isCdpEndpointReady(normalizedPort)) {
    return { connected: true, alreadyListening: true, processId: null };
  }
  if (installation?.isRunning) {
    throw new Error("这个 Codex 已在普通模式运行。请保存输入并完全退出它，再由桌面版启动调试实例。");
  }
  const executablePath = await validateExecutable(installation?.path);
  const profilePath = path.join(profileRoot, profileDirectoryName(executablePath));
  await mkdir(profilePath, { recursive: true });
  const args = buildCodexArguments({ port: normalizedPort, profilePath });
  onLog({ stream: "system", text: `启动 ${executablePath}\n` });
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  if (!await waitForEndpoint(normalizedPort, timeoutMs)) {
    try {
      child.kill();
    } catch {}
    throw new Error(`Codex 已启动，但 ${timeoutMs / 1000} 秒内没有监听 CDP 端口 ${normalizedPort}`);
  }
  return {
    connected: true,
    alreadyListening: false,
    processId: child.pid,
    profilePath,
  };
}
