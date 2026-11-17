import { spawn } from "node:child_process";
import { parseCodexProcessList } from "./codex-processes.mjs";

const MONITOR_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPath = [IO.Path]::GetFullPath($env:CWB_TARGET_EXE)
$intervalMs = [Math]::Max(500, [int]$env:CWB_PROCESS_POLL_MS)
while ($true) {
  $items = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
    if (-not $_.ExecutablePath -or -not $_.CommandLine) { return $false }
    try {
      $pathMatch = [string]::Equals(
        [IO.Path]::GetFullPath($_.ExecutablePath),
        $targetPath,
        [StringComparison]::OrdinalIgnoreCase
      )
    } catch {
      $pathMatch = $false
    }
    $pathMatch -and $_.CommandLine -notmatch '--type='
  } | ForEach-Object {
    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      CommandLine = [string]$_.CommandLine
      MainWindowHandle = if ($process) { [int64]$process.MainWindowHandle } else { [int64]0 }
    }
  })
  [pscustomobject]@{ type = 'snapshot'; processes = $items } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $intervalMs
}
`;

/**
 * A single long-lived PowerShell process avoids spawning a new shell on every
 * process-watch tick. Snapshots are line-delimited JSON and are intentionally
 * limited to process IDs and command lines.
 */
export function startCodexProcessMonitor({
  executablePath,
  port,
  intervalMs = 3_000,
  onSnapshot = () => {},
  onError = () => {},
  spawnImpl = spawn,
} = {}) {
  if (typeof executablePath !== "string" || !executablePath.trim()) throw new TypeError("缺少 Codex 可执行文件路径");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("CDP 端口无效");
  if (!Number.isFinite(intervalMs) || intervalMs < 500) throw new TypeError("进程监控间隔无效");
  let stopped = false;
  let buffer = "";
  let reportedError = null;
  const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", MONITOR_SCRIPT], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CWB_TARGET_EXE: executablePath,
      CWB_CDP_PORT: String(port),
      CWB_PROCESS_POLL_MS: String(Math.round(intervalMs)),
    },
  });
  const reportError = (error) => {
    if (stopped || reportedError) return;
    reportedError = error;
    try { onError(error); } catch {}
  };
  const consumeLine = (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.type !== "snapshot") return;
    onSnapshot(parseCodexProcessList(JSON.stringify(message.processes || [])));
  };
  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk) => reportError(new Error(String(chunk).trim().slice(0, 300))));
  child.on?.("error", reportError);
  child.on?.("exit", (code) => {
    if (!stopped) reportError(new Error(`Codex 进程监控已退出（${code ?? "unknown"}）`));
  });
  return {
    stop() {
      stopped = true;
      try { child.kill(); } catch {}
    },
  };
}