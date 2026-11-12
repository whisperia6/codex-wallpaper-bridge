import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPath = [IO.Path]::GetFullPath($env:CWB_TARGET_EXE)
$port = [int]$env:CWB_CDP_PORT
@(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
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
    MainWindowTitle = if ($process) { [string]$process.MainWindowTitle } else { '' }
  }
}) | ConvertTo-Json -Compress
`;

export function parseCodexProcessList(output) {
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
    const processId = Number(entry?.ProcessId);
    if (!Number.isInteger(processId) || processId <= 0) return [];
    return [{
      processId,
      commandLine: String(entry?.CommandLine || ""),
      mainWindowHandle: Number(entry?.MainWindowHandle) > 0 ? Number(entry.MainWindowHandle) : 0,
      mainWindowTitle: String(entry?.MainWindowTitle || ""),
    }];
  });
}

export function hasCodexDebugPort(commandLine, port) {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`--remote-debugging-port=${escapedPort}(?:\\s|$)`).test(String(commandLine || ""));
}

export function classifyCodexProcesses(processes, port) {
  const debug = [];
  const ordinary = [];
  for (const process of processes || []) {
    if (!process) continue;
    (hasCodexDebugPort(process.commandLine, port) ? debug : ordinary).push(process);
  }
  return { debug, ordinary };
}

export async function listCodexProcesses({
  executablePath,
  port,
  processRunner = execFileAsync,
  timeoutMs = 4_000,
} = {}) {
  if (typeof executablePath !== "string" || !executablePath.trim()) {
    throw new Error("缺少 Codex 可执行文件路径");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP 端口无效");
  }
  const { stdout } = await processRunner(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY_SCRIPT],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        CWB_TARGET_EXE: executablePath,
        CWB_CDP_PORT: String(port),
      },
    },
  );
  return parseCodexProcessList(stdout);
}