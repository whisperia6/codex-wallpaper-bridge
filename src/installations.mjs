import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { tryRunWinHelper } from "./win-helper.mjs";

const execFileAsync = promisify(execFile);
const STORE_PACKAGE_NAME = "OpenAI.Codex";
const STATIC_DISCOVERY_TTL_MS = 60_000;
let staticDiscoveryCache = null;
const STATIC_INSTALLATION_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$storePackages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | ForEach-Object {
  $appId = 'App'
  $executable = ''
  try {
    $m = Join-Path $_.InstallLocation 'AppxManifest.xml'
    if (Test-Path -LiteralPath $m -PathType Leaf) {
      [xml]$xml = Get-Content -LiteralPath $m -Raw
      $node = @($xml.Package.Applications.Application | Where-Object { $_.Executable -match '(?i)(^|[\\/])(ChatGPT|Codex)\.exe$' }) | Select-Object -First 1
      if ($node -and $node.Id) { $appId = [string]$node.Id }
      if ($node -and $node.Executable) { $executable = [string]$node.Executable }
    }
  } catch {}
  [pscustomobject]@{
    Name = $_.Name
    Version = $_.Version
    InstallLocation = $_.InstallLocation
    PackageFamilyName = $_.PackageFamilyName
    ApplicationId = $appId
    Executable = $executable
    SignatureKind = $_.SignatureKind
  }
})

$candidatePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Add-CodexCandidate([string]$candidatePath) {
  if ([string]::IsNullOrWhiteSpace($candidatePath)) { return }
  $expandedPath = [Environment]::ExpandEnvironmentVariables($candidatePath.Trim().Trim('"'))
  $fileName = [IO.Path]::GetFileName($expandedPath)
  if ($fileName -ieq 'Codex.exe') {
    $chatGptPath = Join-Path ([IO.Path]::GetDirectoryName($expandedPath)) 'ChatGPT.exe'
    if (Test-Path -LiteralPath $chatGptPath -PathType Leaf) { $expandedPath = $chatGptPath; $fileName = 'ChatGPT.exe' }
  }
  if ($fileName -ine 'ChatGPT.exe' -and $fileName -ine 'Codex.exe') { return }
  if (Test-Path -LiteralPath $expandedPath -PathType Leaf) {
    [void]$candidatePaths.Add([IO.Path]::GetFullPath($expandedPath))
  }
}

function Add-InstallLocation([string]$installLocation) {
  if ([string]::IsNullOrWhiteSpace($installLocation)) { return }
  $dir = $installLocation.Trim().Trim('"')
  $chatGpt = Join-Path $dir 'ChatGPT.exe'
  if (Test-Path -LiteralPath $chatGpt -PathType Leaf) {
    Add-CodexCandidate $chatGpt
    return
  }
  Add-CodexCandidate (Join-Path $dir 'Codex.exe')
}

$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty -Path $uninstallRoots | Where-Object {
  [string]$_.DisplayName -match '^(OpenAI\s+)?Codex(?:\s+(Desktop|App))?$'
} | ForEach-Object {
  Add-InstallLocation ([string]$_.InstallLocation)
  $displayIcon = ([string]$_.DisplayIcon).Trim()
  if ($displayIcon -match '^"([^"]+\.exe)"') {
    Add-CodexCandidate $Matches[1]
  } elseif ($displayIcon -match '^(.+?\.exe)(?:,\d+)?$') {
    Add-CodexCandidate $Matches[1]
  }
}

$knownDirectories = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Codex'),
  (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI Codex'),
  (Join-Path $env:LOCALAPPDATA 'Codex'),
  (Join-Path $env:ProgramFiles 'Codex'),
  (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Codex')
)
$knownDirectories | ForEach-Object { Add-InstallLocation $_ }

$startMenuRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch {}
if ($shell) {
  Get-ChildItem -Path $startMenuRoots -Filter '*Codex*.lnk' -File -Recurse | ForEach-Object {
    try { Add-CodexCandidate $shell.CreateShortcut($_.FullName).TargetPath } catch {}
  }
}

$localInstallations = @($candidatePaths | ForEach-Object {
  $item = Get-Item -LiteralPath $_
  $identity = "$($item.VersionInfo.ProductName) $($item.VersionInfo.FileDescription)"
  if ($identity -match '(?i)\bCodex\b') {
    [pscustomobject]@{
      ExecutablePath = $item.FullName
      ProductVersion = $item.VersionInfo.ProductVersion
    }
  }
})

[pscustomobject]@{
  storePackages = $storePackages
  localInstallations = $localInstallations
} | ConvertTo-Json -Depth 4 -Compress
`;

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizedPathKey(value) {
  return path.win32.normalize(String(value || "")).toLowerCase();
}

function localInstallationId(executablePath) {
  const digest = createHash("sha256").update(normalizedPathKey(executablePath)).digest("hex").slice(0, 12);
  return `local:${digest}`;
}

function storeExecutablePath(storePackage) {
  if (!storePackage?.InstallLocation) return null;
  const installRoot = path.win32.resolve(String(storePackage.InstallLocation));
  const declared = String(storePackage?.Executable || "").trim();
  if (declared && !path.win32.isAbsolute(declared)) {
    const resolved = path.win32.resolve(installRoot, declared);
    const relative = path.win32.relative(installRoot, resolved);
    if (relative && !relative.startsWith("..") && !path.win32.isAbsolute(relative)
      && path.win32.extname(resolved).toLowerCase() === ".exe") {
      return resolved;
    }
  }
  return path.win32.join(installRoot, "app", "ChatGPT.exe");
}

function storeAppUserModelId(storePackage) {
  const familyName = String(storePackage?.PackageFamilyName || "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(familyName)) return null;
  const applicationId = String(storePackage?.ApplicationId || "App").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(applicationId)) return null;
  return `${familyName}!${applicationId}`;
}

export function parsePowerShellJson(output) {
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  return asArray(JSON.parse(text));
}

export function validateCdpPort(value) {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new Error("CDP 端口必须是整数");
  }
  const port = Number(value);
  if (!Number.isInteger(port)) throw new Error("CDP 端口必须是整数");
  if (port < 1024 || port > 65535) throw new Error("CDP 端口必须在 1024 到 65535 之间");
  return port;
}

export function selectInstallationId(installations, selectedId) {
  if (installations.some(({ id }) => id === selectedId)) return selectedId;
  return installations.find(({ isRunning }) => isRunning)?.id || installations[0]?.id || null;
}

export function normalizeInstallations({
  storePackages = [],
  localInstallations = [],
  runningProcesses = [],
  manualExecutables = [],
} = {}) {
  const installations = new Map();

  for (const storePackage of asArray(storePackages)) {
    const executablePath = storeExecutablePath(storePackage);
    if (!executablePath) continue;
    const appUserModelId = storeAppUserModelId(storePackage);
    installations.set(normalizedPathKey(executablePath), {
      id: `store:${String(storePackage.Name || STORE_PACKAGE_NAME).toLowerCase()}`,
      kind: "store",
      label: "Microsoft Store 版",
      path: executablePath,
      version: String(storePackage.Version || "未知"),
      ...(appUserModelId ? { appUserModelId } : {}),
      isRunning: false,
      processIds: [],
    });
  }

  for (const localInstallation of asArray(localInstallations)) {
    const executablePath = String(localInstallation?.ExecutablePath || "").trim();
    if (!executablePath) continue;
    const key = normalizedPathKey(executablePath);
    if (installations.has(key)) continue;
    installations.set(key, {
      id: localInstallationId(executablePath),
      kind: "local",
      label: "本地 EXE 版（自动发现）",
      path: executablePath,
      version: String(localInstallation.ProductVersion || "未知"),
      isRunning: false,
      processIds: [],
    });
  }

  for (const processInfo of asArray(runningProcesses)) {
    const executablePath = String(processInfo?.ExecutablePath || "").trim();
    if (!executablePath) continue;
    const key = normalizedPathKey(executablePath);
    const existing = installations.get(key) || {
      id: localInstallationId(executablePath),
      kind: "local",
      label: "本地 EXE 版",
      path: executablePath,
      version: String(processInfo.ProductVersion || "未知"),
      isRunning: false,
      processIds: [],
    };
    const processId = Number(processInfo.ProcessId);
    if (Number.isInteger(processId) && !existing.processIds.includes(processId)) {
      existing.processIds.push(processId);
    }
    existing.isRunning = existing.processIds.length > 0;
    installations.set(key, existing);
  }

  for (const manualPath of asArray(manualExecutables)) {
    const executablePath = String(manualPath || "").trim();
    if (!executablePath) continue;
    const key = normalizedPathKey(executablePath);
    if (installations.has(key)) continue;
    installations.set(key, {
      id: localInstallationId(executablePath),
      kind: "local",
      label: "本地 EXE 版",
      path: executablePath,
      version: "未知",
      isRunning: false,
      processIds: [],
    });
  }

  return [...installations.values()].map((installation) => ({
    ...installation,
    processIds: installation.processIds.sort((left, right) => left - right),
  }));
}

async function runPowerShellJson(script, env = undefined) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 12_000,
      windowsHide: true,
      ...(env ? { env } : {}),
    },
  );
  return parsePowerShellJson(stdout);
}

export async function validateExecutable(executablePath) {
  const resolvedPath = path.win32.resolve(String(executablePath || ""));
  if (path.win32.extname(resolvedPath).toLowerCase() !== ".exe") {
    throw new Error("请选择 .exe 可执行文件");
  }
  await access(resolvedPath);
  return resolvedPath;
}

export function clearInstallationDiscoveryCache() {
  staticDiscoveryCache = null;
}

function isStaticDiscoveryCacheFresh() {
  if (!staticDiscoveryCache) return false;
  if (Date.now() - staticDiscoveryCache.at >= STATIC_DISCOVERY_TTL_MS) return false;
  for (const pkg of staticDiscoveryCache.storePackages) {
    const exePath = storeExecutablePath(pkg);
    if (exePath && !existsSync(exePath)) return false;
  }
  for (const local of staticDiscoveryCache.localInstallations) {
    const exePath = String(local?.ExecutablePath || "").trim();
    if (exePath && !existsSync(exePath)) return false;
  }
  return true;
}

async function discoverStaticInstallations({ forceRefresh = false } = {}) {
  if (!forceRefresh && isStaticDiscoveryCacheFresh()) {
    return staticDiscoveryCache;
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", STATIC_INSTALLATION_SCRIPT],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 12_000,
      windowsHide: true,
    },
  );
  const text = String(stdout || "").replace(/^\uFEFF/, "").trim();
  const parsed = text ? JSON.parse(text) : {};
  const result = {
    at: Date.now(),
    storePackages: asArray(parsed?.storePackages),
    localInstallations: asArray(parsed?.localInstallations),
  };
  staticDiscoveryCache = result;
  return result;
}

const RUNNING_CODEX_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$currentSessionId = (Get-Process -Id $PID).SessionId
$extraPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$names.Add('ChatGPT.exe')
[void]$names.Add('Codex.exe')
if (-not [string]::IsNullOrWhiteSpace($env:CWB_EXTRA_EXE_PATHS)) {
  try {
    foreach ($entry in @($env:CWB_EXTRA_EXE_PATHS | ConvertFrom-Json)) {
      if ([string]::IsNullOrWhiteSpace([string]$entry)) { continue }
      try {
        $full = [IO.Path]::GetFullPath([string]$entry)
        [void]$extraPaths.Add($full)
        $fileName = [IO.Path]::GetFileName($full)
        if (-not [string]::IsNullOrWhiteSpace($fileName)) { [void]$names.Add($fileName) }
      } catch {}
    }
  } catch {}
}
$clauses = @($names | ForEach-Object { "Name = '$($_.Replace('\', '\\').Replace("'", "\'"))'" })
$filter = "($($clauses -join ' OR ')) AND SessionId = $currentSessionId"
$items = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath } | ForEach-Object {
  $execPath = [string]$_.ExecutablePath
  $fullPath = $execPath
  try { $fullPath = [IO.Path]::GetFullPath($execPath) } catch {}
  $fileName = [IO.Path]::GetFileName($fullPath)
  $item = Get-Item -LiteralPath $fullPath -ErrorAction SilentlyContinue
  $include = $extraPaths.Contains($fullPath)
  if (-not $include -and $fileName -ieq 'ChatGPT.exe') {
    if ($fullPath.IndexOf('\WindowsApps\OpenAI.Codex', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $include = $true
    } elseif ($item) {
      $identity = "$($item.VersionInfo.ProductName) $($item.VersionInfo.FileDescription)"
      if ($identity -match '(?i)\bCodex\b') { $include = $true }
    }
  }
  if (-not $include -and $fileName -ieq 'Codex.exe' -and $item) {
    $identity = "$($item.VersionInfo.ProductName) $($item.VersionInfo.FileDescription)"
    $dir = [IO.Path]::GetDirectoryName($fullPath)
    $hasDesktopLayout = (Test-Path -LiteralPath (Join-Path $dir 'resources\app.asar') -PathType Leaf) -or
      (Test-Path -LiteralPath (Join-Path $dir 'chrome_elf.dll') -PathType Leaf) -or
      (Test-Path -LiteralPath (Join-Path $dir 'chrome.dll') -PathType Leaf)
    if ($hasDesktopLayout -and $identity -match '(?i)\bCodex\b') { $include = $true }
  }
  if ($include) {
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      ExecutablePath = $execPath
      ProductVersion = if ($item) { [string]$item.VersionInfo.ProductVersion } else { '' }
    }
  }
})
$items | ConvertTo-Json -Compress
`;

const INSPECT_EXE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$full = [IO.Path]::GetFullPath($env:CWB_INSPECT_EXE)
$item = Get-Item -LiteralPath $full -ErrorAction SilentlyContinue
$productName = if ($item) { [string]$item.VersionInfo.ProductName } else { '' }
$fileDescription = if ($item) { [string]$item.VersionInfo.FileDescription } else { '' }
$dir = [IO.Path]::GetDirectoryName($full)
$hasDesktopLayout = (Test-Path -LiteralPath (Join-Path $dir 'resources\app.asar') -PathType Leaf) -or
  (Test-Path -LiteralPath (Join-Path $dir 'chrome_elf.dll') -PathType Leaf) -or
  (Test-Path -LiteralPath (Join-Path $dir 'chrome.dll') -PathType Leaf)
[pscustomobject]@{
  productName = $productName
  fileDescription = $fileDescription
  looksLikeCodex = [bool](("$productName $fileDescription" -match '(?i)\bCodex\b') -or ($full.IndexOf('\WindowsApps\OpenAI.Codex', [StringComparison]::OrdinalIgnoreCase) -ge 0))
  hasDesktopLayout = [bool]$hasDesktopLayout
} | ConvertTo-Json -Compress
`;

export async function inspectExecutableIdentity(executablePath) {
  const resolvedPath = await validateExecutable(executablePath);
  if (process.platform !== "win32") {
    return { productName: "", fileDescription: "", looksLikeCodex: true, hasDesktopLayout: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", INSPECT_EXE_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: 5_000,
        windowsHide: true,
        env: { ...process.env, CWB_INSPECT_EXE: resolvedPath },
      },
    );
    const parsed = JSON.parse(String(stdout || "").replace(/^\uFEFF/, "").trim());
    return {
      productName: String(parsed?.productName || ""),
      fileDescription: String(parsed?.fileDescription || ""),
      looksLikeCodex: Boolean(parsed?.looksLikeCodex),
      hasDesktopLayout: Boolean(parsed?.hasDesktopLayout),
    };
  } catch {
    return { productName: "", fileDescription: "", looksLikeCodex: false, hasDesktopLayout: false };
  }
}

async function discoverRunningProcesses(manualExecutables = []) {
  const extraPaths = asArray(manualExecutables)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const env = {
    ...process.env,
    CWB_EXTRA_EXE_PATHS: extraPaths.length ? JSON.stringify(extraPaths) : "",
  };
  let helperResult = null;
  try {
    helperResult = await tryRunWinHelper("list-running-codex", {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8_000,
      env,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    helperResult = null;
  }
  if (helperResult) {
    return parsePowerShellJson(helperResult.stdout);
  }
  return runPowerShellJson(RUNNING_CODEX_SCRIPT, env);
}

export async function detectInstallations({ manualExecutables = [], forceRefresh = false } = {}) {
  const [staticResult, runningProcesses] = await Promise.all([
    discoverStaticInstallations({ forceRefresh }).catch(() => ({ storePackages: [], localInstallations: [] })),
    discoverRunningProcesses(manualExecutables).catch(() => []),
  ]);
  return normalizeInstallations({
    storePackages: staticResult.storePackages,
    localInstallations: staticResult.localInstallations,
    runningProcesses,
    manualExecutables,
  });
}
