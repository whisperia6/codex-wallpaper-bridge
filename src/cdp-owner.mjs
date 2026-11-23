import { execFile } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { validateCdpPort } from "./installations.mjs";
import { validateProcessCreation } from "./process-creation.mjs";
import { tryRunWinHelper } from "./win-helper.mjs";

const execFileAsync = promisify(execFile);

// Only listener identity, the debugging-port switch, and match booleans leave PowerShell. The
// native parser reads arguments one at a time and never returns the command line
// or unrelated argv (for example profile paths) to this process.
const CDP_OWNER_SCRIPT = String.raw`
$queryStage = 'initialize'
try {
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetPort = [int]$env:CWB_CDP_OWNER_PORT
$expectedProcess = $null
$expectedProfile = ''
$expectedCreationTicks = $null
if (-not [string]::IsNullOrEmpty($env:CWB_CDP_EXPECTED_PROCESS)) {
  $expectedProcess = $env:CWB_CDP_EXPECTED_PROCESS | ConvertFrom-Json
  $expectedProfile = [string]$expectedProcess.profile
  $expectedCreation = [DateTime]::ParseExact(
    [string]$expectedProcess.creation, 'o', [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind)
  $expectedCreationTicks = $expectedCreation.ToUniversalTime().Ticks
}

$queryStage = 'native-parser'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

public sealed class CwbDebugPortArguments {
  public int[] Ports { get; set; }
  public bool Invalid { get; set; }
  public bool ProfileMatches { get; set; }
}

public static class CwbDebugPortParser {
  private static bool IsAbsolutePath(string value) {
    return !String.IsNullOrEmpty(value) &&
      ((value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' &&
        (value[2] == '\\' || value[2] == '/')) || value.StartsWith(@"\\", StringComparison.Ordinal));
  }
  [DllImport("shell32.dll", SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW(
    [MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static CwbDebugPortArguments Parse(string commandLine, string expectedProfile) {
    var ports = new List<int>();
    int profileCount = 0;
    bool profileMatches = false;
    bool invalid = String.IsNullOrWhiteSpace(commandLine);
    if (invalid) return new CwbDebugPortArguments { Ports = ports.ToArray(), Invalid = true };
    int count;
    IntPtr memory = CommandLineToArgvW(commandLine, out count);
    if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments");
    try {
      for (int index = 1; index < count; index++) {
        string argument = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
        if (argument == "--") break;
        string value;
        if (argument.StartsWith("--remote-debugging-port=", StringComparison.Ordinal)) {
          value = argument.Substring("--remote-debugging-port=".Length);
        } else if (argument == "--remote-debugging-port") {
          if (++index >= count) { invalid = true; break; }
          value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
        } else if (!String.IsNullOrEmpty(expectedProfile) &&
          (argument.StartsWith("--user-data-dir=", StringComparison.Ordinal) || argument == "--user-data-dir")) {
          profileCount++;
          if (argument == "--user-data-dir") {
            if (++index >= count) { profileMatches = false; break; }
            value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size));
          } else {
            value = argument.Substring("--user-data-dir=".Length);
          }
          try {
            profileMatches = IsAbsolutePath(value) && String.Equals(
              Path.GetFullPath(value).TrimEnd('\\', '/'),
              Path.GetFullPath(expectedProfile).TrimEnd('\\', '/'),
              StringComparison.OrdinalIgnoreCase);
          } catch {
            profileMatches = false;
          }
          continue;
        } else {
          continue;
        }
        int port;
        if (Int32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out port)) {
          ports.Add(port);
        } else {
          invalid = true;
        }
      }
    } finally {
      LocalFree(memory);
    }
    return new CwbDebugPortArguments {
      Ports = ports.ToArray(), Invalid = invalid, ProfileMatches = profileCount == 1 && profileMatches
    };
  }
}
'@

$queryStage = 'listeners'
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $targetPort -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{
    localAddress = [string]$_.LocalAddress
    localPort = [int]$_.LocalPort
    owningProcess = [int]$_.OwningProcess
  }
})
$ownerIds = @($listeners | ForEach-Object { $_.owningProcess } | Sort-Object -Unique)
$owners = @()
$creationMatches = $false
$profileMatches = $false
foreach ($ownerIdValue in $ownerIds) {
  $ownerId = [int]$ownerIdValue
  $ownerProperties = @('ProcessId', 'ExecutablePath', 'CommandLine')
  if ($expectedProcess) { $ownerProperties += 'CreationDate' }
  $queryStage = 'owner'
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -Property $ownerProperties -ErrorAction Stop
  if (-not $owner) { throw 'Listener owner disappeared' }
  $debugArguments = [CwbDebugPortParser]::Parse([string]$owner.CommandLine, $expectedProfile)
  if ($expectedProcess -and $ownerId -eq [int]$expectedProcess.pid) {
    if ($owner.CreationDate -is [DateTime]) {
      $creationMatches = $owner.CreationDate.ToUniversalTime().Ticks -eq $expectedCreationTicks
    }
    $profileMatches = [bool]$debugArguments.ProfileMatches
  }
  $owners += [pscustomobject]@{
    processId = [int]$owner.ProcessId
    executablePath = [string]$owner.ExecutablePath
    remoteDebuggingPorts = @($debugArguments.Ports)
    hasInvalidRemoteDebuggingPort = [bool]$debugArguments.Invalid
  }
}
$evidence = [ordered]@{ listeners = $listeners; owners = $owners }
if ($expectedProcess) {
  $queryStage = 'ancestry'
  $ancestorIds = [Collections.Generic.HashSet[int]]::new()
  $cursor = [int]$PID
  $notQueryAncestor = $true
  $ancestorChainVerified = $false
  $childCreationTicks = $null
  for ($depth = 0; $depth -lt 32; $depth++) {
    if (-not $ancestorIds.Add($cursor)) { break }
    if ($cursor -eq [int]$expectedProcess.pid) { $notQueryAncestor = $false; break }
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop
    if (-not $ancestor -or [int]$ancestor.ProcessId -ne $cursor -or $null -eq $ancestor.ParentProcessId -or
      $ancestor.CreationDate -isnot [DateTime]) {
      throw 'Cannot verify query process ancestry'
    }
    $ancestorCreationTicks = $ancestor.CreationDate.ToUniversalTime().Ticks
    if ($null -ne $childCreationTicks -and $ancestorCreationTicks -gt $childCreationTicks) {
      throw 'Ancestor PID was reused'
    }
    # A verified ancestor that already existed before the target was created
    # cannot be descended from that target. This proves the boundary without
    # requiring Windows' long-exited Explorer parents to remain queryable.
    # Missing metadata, cycles and unproven orphan boundaries still fail closed.
    if ($ancestorCreationTicks -lt $expectedCreationTicks) {
      $ancestorChainVerified = $true
      break
    }
    $parentId = [int]$ancestor.ParentProcessId
    if ($parentId -eq 0) { $ancestorChainVerified = $true; break }
    if ($parentId -lt 0) { break }
    $childCreationTicks = $ancestorCreationTicks
    $cursor = $parentId
  }
  $evidence.independentIdentity = [pscustomobject]@{
    processIdMatches = [bool]($ownerIds.Count -eq 1 -and $ownerIds[0] -eq [int]$expectedProcess.pid)
    creationMatches = [bool]$creationMatches
    profileMatches = [bool]$profileMatches
    notQueryAncestor = [bool]$notQueryAncestor
    ancestorChainVerified = [bool]$ancestorChainVerified
  }
}
[pscustomobject]$evidence | ConvertTo-Json -Depth 5 -Compress
} catch {
  # Never return exception messages, command lines or paths. Only fixed stages,
  # a narrow failure class and a numeric CIM result are safe diagnostics.
  $cause = $_.Exception.GetBaseException()
  $queryKind = 'query'
  $nativeCode = $null
  if ($cause.GetType().FullName -eq 'Microsoft.Management.Infrastructure.CimException') {
    $queryKind = 'cim'
    $nativeCode = [int]$cause.NativeErrorCode
    if ($nativeCode -eq 2) { $queryKind = 'access' }
  } elseif ($cause -is [UnauthorizedAccessException]) {
    $queryKind = 'access'
  }
  [pscustomobject]@{ queryFailure = [pscustomobject]@{
    stage = $queryStage; kind = $queryKind; nativeCode = $nativeCode
  }} | ConvertTo-Json -Compress
}
`;

const QUERY_STAGES = Object.freeze({
  initialize: "初始化", "native-parser": "参数解析", listeners: "监听端口", owner: "进程所有者", ancestry: "祖先进程",
});
const QUERY_KINDS = Object.freeze({ query: "查询失败", cim: "CIM 查询失败", access: "访问被拒绝" });

function queryFailureError(failure) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)
    || typeof failure.stage !== "string" || typeof failure.kind !== "string"
    || !Object.hasOwn(QUERY_STAGES, failure.stage) || !Object.hasOwn(QUERY_KINDS, failure.kind)
    || (failure.nativeCode !== null && (!Number.isInteger(failure.nativeCode) || failure.nativeCode < 0 || failure.nativeCode > 65535))) {
    throw new Error("CDP 端口所有者核验结果无效");
  }
  const error = new Error(`无法核验 CDP 端口所有者：${QUERY_STAGES[failure.stage]}阶段${QUERY_KINDS[failure.kind]}`);
  error.code = "CWB_CDP_OWNER_QUERY_FAILED";
  error.queryStage = failure.stage;
  error.queryKind = failure.kind;
  error.nativeCode = failure.nativeCode;
  return error;
}

function normalizeExecutablePath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)
    || path.win32.extname(value).toLowerCase() !== ".exe") {
    throw new Error("无法核验 Codex 可执行文件路径");
  }
  return path.win32.normalize(value).toLowerCase();
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  if (isIP(value) === 4) return value.split(".")[0] === "127";
  return value.toLowerCase() === "::1" || value.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function parseOwnerEvidence(stdout) {
  let result;
  try {
    result = JSON.parse(String(stdout || "").replace(/^\uFEFF/, "").trim());
  } catch {
    throw new Error("CDP 端口所有者核验结果无效");
  }
  if (result && Object.hasOwn(result, "queryFailure")) throw queryFailureError(result.queryFailure);
  if (!result || !Array.isArray(result.listeners) || !Array.isArray(result.owners)) {
    throw new Error("CDP 端口所有者核验结果不完整");
  }
  return result;
}

function validateExpectedProcess(value) {
  if (value === undefined) return undefined;
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.join(",") !== "creation,pid,profile" || !Number.isSafeInteger(value.pid)
    || value.pid <= 0 || value.pid > 0xFFFFFFFF) {
    throw new Error("独立验收进程 metadata 无效：需要 positive PID、creation 和绝对 profile");
  }
  if (typeof value.profile !== "string" || value.profile.trim() !== value.profile
    || !path.win32.isAbsolute(value.profile) || path.win32.parse(value.profile).root === "\\"
    || /[\u0000-\u001f<>"|?*]/.test(value.profile)) {
    throw new Error("独立验收进程 profile 必须是完整绝对路径");
  }
  validateProcessCreation(value.creation);
  return { pid: value.pid, creation: value.creation, profile: value.profile };
}

/**
 * Read-only Windows verification; processRunner is an injectable async execFile.
 * expectedProcess optionally requires { pid, creation: CreationDate.ToString("o"), profile }.
 * Full command lines, profile values, and creation values never appear in the result.
 */
export async function verifyCdpEndpointOwner({
  installation,
  port,
  expectedProcess,
  processRunner,
  platform = process.platform,
}) {
  if (platform !== "win32") throw new Error("CDP 端口所有者核验仅支持 Windows");
  const normalizedPort = validateCdpPort(port);
  const expectedPath = normalizeExecutablePath(installation?.path);
  const expectedIdentity = validateExpectedProcess(expectedProcess);
  const execOptions = {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 12_000,
    windowsHide: true,
    env: {
      ...process.env,
      CWB_CDP_OWNER_PORT: String(normalizedPort),
      CWB_CDP_EXPECTED_PROCESS: expectedIdentity ? JSON.stringify(expectedIdentity) : "",
    },
  };
  let stdout;
  try {
    const helperResult = processRunner === undefined
      ? await tryRunWinHelper("verify-cdp-owner", execOptions, platform)
      : null;
    if (helperResult) {
      ({ stdout } = helperResult);
    } else {
      ({ stdout } = await (processRunner ?? execFileAsync)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", CDP_OWNER_SCRIPT],
        execOptions,
      ));
    }
  } catch (cause) {
    // execFile errors may contain the script, stderr, or process metadata.
    if (cause?.code === "ENOENT") throw new Error("无法核验 CDP 端口所有者：PowerShell 不可用");
    if (cause?.code === "EACCES" || cause?.code === "EPERM") throw new Error("无法核验 CDP 端口所有者：查询进程启动被拒绝");
    if (cause?.killed === true) throw new Error("无法核验 CDP 端口所有者：查询超时或被终止");
    throw new Error("无法核验 CDP 端口所有者：进程信息不可访问或查询失败");
  }
  const { listeners, owners, independentIdentity } = parseOwnerEvidence(stdout);
  if (listeners.length === 0) throw new Error("CDP 端口没有可核验的监听进程");
  for (const listener of listeners) {
    if (!isLoopbackAddress(listener?.localAddress)) {
      throw new Error("CDP 端口必须仅监听 loopback 地址");
    }
    if (listener.localPort !== normalizedPort || !Number.isInteger(listener.owningProcess)
      || listener.owningProcess <= 0) {
      throw new Error("CDP 端口监听信息与请求不一致");
    }
  }
  const processIds = [...new Set(listeners.map((listener) => listener.owningProcess))];
  if (processIds.length !== 1) throw new Error("CDP 端口由多个进程监听，无法确认所选 Codex");
  if (owners.length !== 1 || owners[0]?.processId !== processIds[0]) {
    throw new Error("CDP 端口进程所有者信息不一致");
  }
  const owner = owners[0];
  if (normalizeExecutablePath(owner.executablePath) !== expectedPath) {
    throw new Error("CDP 端口不属于所选 Codex 安装，请选择正确版本或另一个端口");
  }
  if (owner.hasInvalidRemoteDebuggingPort !== false || !Array.isArray(owner.remoteDebuggingPorts)
    || owner.remoteDebuggingPorts.length !== 1 || owner.remoteDebuggingPorts[0] !== normalizedPort) {
    throw new Error("CDP 所有者的实际 remote-debugging-port 参数与端口不一致或存在歧义");
  }
  if (expectedIdentity && (owner.processId !== expectedIdentity.pid || !independentIdentity
    || ["processIdMatches", "creationMatches", "profileMatches", "notQueryAncestor", "ancestorChainVerified"]
      .some((field) => independentIdentity[field] !== true))) {
    throw new Error("独立验收进程身份不匹配：PID、creation、profile 或宿主祖先保护未通过");
  }
  return {
    port: normalizedPort,
    processId: owner.processId,
    executablePath: owner.executablePath,
    listenerAddresses: [...new Set(listeners.map((listener) => listener.localAddress))],
  };
}
