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
  try {
    $m = Join-Path $_.InstallLocation 'AppxManifest.xml'
    if (Test-Path -LiteralPath $m -PathType Leaf) {
      [xml]$xml = Get-Content -LiteralPath $m -Raw
      $node = @($xml.Package.Applications.Application | Where-Object { $_.Executable -match '(?i)(^|[\\/])ChatGPT\.exe$' }) | Select-Object -First 1
      if ($node -and $node.Id) { $appId = [string]$node.Id }
    }
  } catch {}
  [pscustomobject]@{
    Name = $_.Name
    Version = $_.Version
    InstallLocation = $_.InstallLocation
    PackageFamilyName = $_.PackageFamilyName
    ApplicationId = $appId
    SignatureKind = $_.SignatureKind
  }
})

$candidatePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Add-CodexCandidate([string]$candidatePath) {
  if ([string]::IsNullOrWhiteSpace($candidatePath)) { return }
  $expandedPath = [Environment]::ExpandEnvironmentVariables($candidatePath.Trim().Trim('"'))
  if ([IO.Path]::GetFileName($expandedPath) -ieq 'Codex.exe') {
    $chatGptPath = Join-Path ([IO.Path]::GetDirectoryName($expandedPath)) 'ChatGPT.exe'
    if (Test-Path -LiteralPath $chatGptPath -PathType Leaf) { $expandedPath = $chatGptPath }
  }
  if ([IO.Path]::GetFileName($expandedPath) -ine 'ChatGPT.exe') { return }
  if (Test-Path -LiteralPath $expandedPath -PathType Leaf) {
    [void]$candidatePaths.Add([IO.Path]::GetFullPath($expandedPath))
  }
}

function Add-InstallLocation([string]$installLocation) {
  if ([string]::IsNullOrWhiteSpace($installLocation)) { return }
  Add-CodexCandidate (Join-Path $installLocation.Trim().Trim('"') 'ChatGPT.exe')
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
  return path.win32.join(String(storePackage.InstallLocation), "app", "ChatGPT.exe");
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

async function runPowerShellJson(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 12_000,
      windowsHide: true,
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

async function discoverRunningProcesses() {
  const helperResult = await tryRunWinHelper("list-running-codex", {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 8_000,
  });
  if (helperResult) {
    return parsePowerShellJson(helperResult.stdout);
  }
  const outputSetup = "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
  const processScript = `${outputSetup} @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath } | ForEach-Object { $item=Get-Item -LiteralPath $_.ExecutablePath -ErrorAction SilentlyContinue; [pscustomobject]@{ ProcessId=$_.ProcessId; ExecutablePath=$_.ExecutablePath; ProductVersion=$item.VersionInfo.ProductVersion } }) | ConvertTo-Json -Compress`;
  return runPowerShellJson(processScript);
}

export async function detectInstallations({ manualExecutables = [], forceRefresh = false } = {}) {
  const [staticResult, runningProcesses] = await Promise.all([
    discoverStaticInstallations({ forceRefresh }).catch(() => ({ storePackages: [], localInstallations: [] })),
    discoverRunningProcesses().catch(() => []),
  ]);
  return normalizeInstallations({
    storePackages: staticResult.storePackages,
    localInstallations: staticResult.localInstallations,
    runningProcesses,
    manualExecutables,
  });
}
