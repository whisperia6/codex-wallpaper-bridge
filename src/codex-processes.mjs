import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tryRunWinHelper } from "./win-helper.mjs";

const execFileAsync = promisify(execFile);
const PROCESS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPath = [IO.Path]::GetFullPath($env:CWB_TARGET_EXE)
try {
  $items = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction Stop | Where-Object {
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
  })
} catch {
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 1
}
$items | ConvertTo-Json -Compress
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

// A debug flag only counts when it starts a new argument. This deliberately
// rejects look-alikes such as "--foo--remote-debugging-port=1" without trying
// to be a complete Windows command-line parser.
const DEBUG_PORT_FLAG = String.raw`--remote-debugging-port`;
const DEBUG_PORT_VALUE_PATTERN = new RegExp(
  String.raw`(?:^|[\s"'])${DEBUG_PORT_FLAG}(?:(?:\s*=\s*|\s+)(?:"(\d+)"|'(\d+)'|(\d+)))?(?=$|[\s"'])`,
  "gi",
);
const DEBUG_PORT_FLAG_PATTERN = new RegExp(
  String.raw`(?:^|[\s"'])${DEBUG_PORT_FLAG}(?=$|[\s"'=])`,
  "i",
);

function debugPorts(commandLine) {
  const text = String(commandLine || "");
  const ports = [];
  for (const match of text.matchAll(DEBUG_PORT_VALUE_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) {
      const port = Number(value);
      if (Number.isInteger(port)) ports.push(port);
    }
  }
  return ports;
}

export function hasCodexDebugPort(commandLine, port) {
  const expected = Number(port);
  if (!Number.isInteger(expected)) return false;
  return debugPorts(commandLine).includes(expected);
}

/**
 * True when the command line carries a remote debugging port argument,
 * regardless of which port it names. Callers use this to stay conservative
 * about instances they do not own.
 */
export function hasAnyCodexDebugPort(commandLine) {
  return DEBUG_PORT_FLAG_PATTERN.test(String(commandLine || ""));
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
  processRunner,
  timeoutMs = 4_000,
} = {}) {
  if (typeof executablePath !== "string" || !executablePath.trim()) {
    throw new Error("缺少 Codex 可执行文件路径");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP 端口无效");
  }
  const execOptions = {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      CWB_TARGET_EXE: executablePath,
      CWB_CDP_PORT: String(port),
    },
  };
  const helperResult = processRunner === undefined
    ? await tryRunWinHelper("list-codex-processes", execOptions)
    : null;
  const { stdout } = helperResult ?? await (processRunner ?? execFileAsync)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY_SCRIPT],
    execOptions,
  );
  return parseCodexProcessList(stdout);
}
