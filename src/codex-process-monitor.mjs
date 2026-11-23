import { spawn } from "node:child_process";
import { parseCodexProcessList } from "./codex-processes.mjs";

const MAX_OUTPUT_BUFFER = 128 * 1024;

const MONITOR_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPath = [IO.Path]::GetFullPath($env:CWB_TARGET_EXE)
$targetName = [IO.Path]::GetFileName($targetPath)
$wqlName = $targetName.Replace('\', '\\').Replace("'", "\'")
$intervalMs = [Math]::Max(500, [int]$env:CWB_PROCESS_POLL_MS)
while ($true) {
  try {
    $items = @(Get-CimInstance Win32_Process -Filter "Name = '$wqlName'" -ErrorAction Stop | Where-Object {
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
  } catch {
    [pscustomobject]@{ type = 'error'; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress
    [Console]::Out.Flush()
    exit 1
  }
  [pscustomobject]@{ type = 'snapshot'; processes = $items } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $intervalMs
}
`;

/**
 * A single long-lived PowerShell process avoids spawning a new shell on every
 * process-watch tick. Snapshots are line-delimited JSON and are intentionally
 * limited to process IDs and command lines.
 *
 * Snapshots carry a monitor-local increasing sequence and a capture timestamp
 * so consumers can reject duplicate or stale observations instead of treating
 * repeated data as new evidence.
 */
export function startCodexProcessMonitor({
  executablePath,
  port,
  intervalMs = 3_000,
  onSnapshot = () => {},
  onError = () => {},
  spawnImpl = spawn,
  now = Date.now,
} = {}) {
  if (typeof executablePath !== "string" || !executablePath.trim()) throw new TypeError("缺少 Codex 可执行文件路径");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("CDP 端口无效");
  if (!Number.isFinite(intervalMs) || intervalMs < 500) throw new TypeError("进程监控间隔无效");
  if (typeof now !== "function") throw new TypeError("进程监控时间函数无效");

  let stopped = false;
  let buffer = "";
  let sequence = 0;
  let reportedError = null;
  let child = null;

  const failClosed = (error) => {
    if (stopped || reportedError) return;
    reportedError = error instanceof Error ? error : new Error(String(error || "Codex 进程监控失败"));
    stopped = true;
    buffer = "";
    try { child?.kill?.(); } catch {}
    try { onError(reportedError); } catch {}
  };

  try {
    child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", MONITOR_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CWB_TARGET_EXE: executablePath,
        CWB_CDP_PORT: String(port),
        CWB_PROCESS_POLL_MS: String(Math.round(intervalMs)),
      },
    });
  } catch (error) {
    reportedError = error instanceof Error ? error : new Error(String(error));
    try { onError(reportedError); } catch {}
    return { stop() {} };
  }

  const consumeLine = (line) => {
    if (stopped) return;
    const text = String(line || "").trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message?.type === "error") {
      const detail = String(message.message || "").trim().slice(0, 300);
      failClosed(new Error(`Codex 进程查询失败${detail ? `：${detail}` : ""}`));
      return;
    }
    if (message?.type !== "snapshot") return;
    const entries = Array.isArray(message.processes) ? message.processes : [];
    let processes;
    try {
      processes = parseCodexProcessList(JSON.stringify(entries));
    } catch (error) {
      failClosed(error);
      return;
    }
    sequence += 1;
    let capturedAt;
    try {
      capturedAt = now();
    } catch (error) {
      failClosed(error);
      return;
    }
    if (!Number.isFinite(capturedAt)) {
      failClosed(new Error("Codex 进程监控时间戳无效"));
      return;
    }
    const snapshot = { sequence, capturedAt, processes };
    try {
      onSnapshot(snapshot);
    } catch (error) {
      failClosed(error);
    }
  };

  child.stdout?.on("data", (chunk) => {
    if (stopped) return;
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
      if (stopped) return;
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_OUTPUT_BUFFER) {
      failClosed(new Error("Codex 进程监控输出缓冲超出上限，已停止监控"));
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (stopped) return;
    const detail = String(chunk || "").trim().slice(0, 300);
    failClosed(new Error(detail || "Codex 进程监控写入错误输出"));
  });
  child.on?.("error", (error) => {
    if (stopped) return;
    failClosed(error);
  });
  child.on?.("exit", (code, signal) => {
    if (stopped) return;
    const reason = code ?? signal ?? "unknown";
    failClosed(new Error(`Codex 进程监控已退出（${reason}）`));
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      buffer = "";
      try { child?.kill?.(); } catch {}
    },
  };
}
