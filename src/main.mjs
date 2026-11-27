import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invokeBridgeAction,
  resolveBridgeRoot,
  resolveBridgeUtilityPath,
  startBridgePreview,
} from "./bridge-runner.mjs";
import {
  collectCdpDiagnostics,
  isCdpEndpointReady,
  waitForCodexTarget,
} from "./cdp-client.mjs";
import { closeCodexProcesses, launchCodex } from "./codex-launcher.mjs";
import { listCodexProcesses } from "./codex-processes.mjs";
import { runCodexTakeoverFlow } from "./codex-takeover-flow.mjs";
import { startCodexProcessMonitor } from "./codex-process-monitor.mjs";
import { createCodexTakeoverWatcher } from "./codex-takeover.mjs";
import { detectInstallations, inspectExecutableIdentity, selectInstallationId, validateCdpPort, validateExecutable } from "./installations.mjs";
import { runLaunchAndInjectFlow } from "./launch-flow.mjs";
import { dailyLogFilename, formatLogEntry, sanitizeLogText } from "./local-logging.mjs";
import { createTrayController, TRAY_ICON_DATA_URL } from "./tray-controller.mjs";
import { desktopWindowChromeOptions, setWindowChromeTheme } from "./window-chrome.mjs";
import { prepareAcceptanceContext } from "./acceptance-context.mjs";
import { verifyCdpEndpointOwner } from "./cdp-owner.mjs";
import { createPreviewSession, stopPreviewProcess } from "./preview-session.mjs";
import { createDesktopEngineHost } from "./desktop-engine-host.mjs";
import { registerDesktopRendererScheme, installDesktopRendererProtocol } from "./desktop-renderer-protocol.mjs";
import { DESKTOP_RENDERER_URL } from "../bridge-runtime/src/desktop-origin.mjs";
import { defaultCdpPort, extractPreservedLaunchArgs, HOST_TYPES, hostDisplayName, hostPortConflict, installationHostType } from "../bridge-runtime/src/host-profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.join(here, "renderer");
const preloadPath = path.join(here, "preload.cjs");
const rendererUrl = DESKTOP_RENDERER_URL;
registerDesktopRendererScheme(protocol);
const acceptanceContext = await prepareAcceptanceContext({ appPath: app.getAppPath(), isPackaged: app.isPackaged });
if (acceptanceContext) app.setPath("userData", acceptanceContext.userData);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow = null;
let trayController = null;
let isQuitting = false;
let shutdownRequested = false;
let shutdownComplete = false;
let shutdownPromise = null;
let hasShownTrayNotice = false;
const defaultPortsByHost = () => Object.fromEntries(HOST_TYPES.map((hostType) => [hostType, defaultCdpPort(hostType)]));
let migratedLegacyPort = null;
let selectedHostType = "codex";
let settings = {
  manualExecutables: [],
  selectedId: null,
  port: defaultCdpPort("codex"),
  portsByHost: defaultPortsByHost(),
  adaptive: true,
  preservedLaunchArgs: {},
};
let activeOperation = null;
let settingsPath = null;
let settingsWriteQueue = Promise.resolve();
let logsRoot = null;
let bridgeRoot = null;
let logWriteQueue = Promise.resolve();
let nativeEngineHost = null;
// Keep executable descriptors for the resident bridge. Every attachment still verifies ownership.
const verifiedEndpointInstallations = new Map();
const pendingOwnerChecks = new Map();
const takeovers = new Map();
let controlSessionPort = null;
const preservedLaunchArgs = new Map();
const previewSession = createPreviewSession({
  start: (port, { onChild }) => startBridgePreview({
    executablePath: process.execPath,
    bridgeRoot,
    port,
    onLog: log,
    processFactory: forkBridgeUtility,
    onChild,
  }),
  stop: stopPreviewProcess,
  validateUrl: assertTrustedControlUrl,
  onDisconnected: () => {
    verifiedEndpointInstallations.clear();
    if (!isQuitting) mainWindow?.webContents.send("cwb:tray-action", "control-disconnected");
  },
});

function forkBridgeUtility(modulePath, args, { cwd }) {
  const utilityPath = resolveBridgeUtilityPath({
    isPackaged: app.isPackaged,
    compiledRoot: here,
    resourcesPath: process.resourcesPath,
  });
  const ownedNativeProvider = args[0] === "preview";
  const bridgeEnv = { ...process.env, ...acceptanceContext?.bridgeEnv };
  if (ownedNativeProvider) nativeEngineHost ??= createDesktopEngineHost({
    electron: { BrowserWindow, session, nativeImage, ipcMain }, env: bridgeEnv,
    verifyEndpoint: async (port, hostType, purpose) => {
      const installation = verifiedEndpointInstallations.get(port)?.installation;
      if (!installation || (hostType !== undefined && installationHostType(installation) !== hostType)) {
        throw new Error("此 CDP 端口只允许连接已核验的目标应用");
      }
      await verifySelectedOwner(installation, port, { restoring: purpose === "restore" });
      return { verified: true };
    },
  });
  const child = utilityProcess.fork(utilityPath, args, {
    cwd,
    env: {
      ...bridgeEnv,
      CWB_BRIDGE_CLI: modulePath,
      CWB_NATIVE_ENGINE_PROVIDER: ownedNativeProvider ? "owned-parent-v1" : "",
    },
    stdio: "pipe",
    serviceName: "Lumina",
  });
  if (ownedNativeProvider) {
    try { nativeEngineHost.attach(child); }
    catch { child.kill(); throw new Error("原生引擎资源通道未能建立"); }
  }
  return child;
}

function log(entry) {
  const normalized = {
    stream: entry?.stream || "system",
    text: sanitizeLogText(entry?.text),
    at: new Date().toISOString(),
  };
  if (!normalized.text) return;
  if (!logsRoot) return;
  const append = async () => {
    await mkdir(logsRoot, { recursive: true });
    await appendFile(
      path.join(logsRoot, dailyLogFilename(new Date(normalized.at))),
      formatLogEntry(normalized),
      "utf8",
    );
  };
  logWriteQueue = logWriteQueue.then(append, append).catch(() => {});
}

function logStartupPhase({ phase, elapsedMs, ok }) {
  const labels = {
    discovery: "安装发现", endpoint: "调试端口探测", owner: "进程身份核验",
    confirmation: "等待用户确认", close: "关闭已确认实例", launch: "启动目标应用",
    target: "等待目标页面", control: "准备壁纸服务", inject: "注入流程",
    apply: "等待注入及媒体就绪", total: "点击到流程结束",
  };
  if (!labels[phase] || !Number.isFinite(elapsedMs)) return;
  log({ stream: "system", text: `[注入计时] ${labels[phase]}：${Math.round(elapsedMs)} ms${ok ? "" : "（未成功）"}\n` });
}

async function measureStartupPhase(phase, task) {
  const startedAt = performance.now();
  let ok = false;
  try { const result = await task(); ok = true; return result; }
  finally { logStartupPhase({ phase, elapsedMs: performance.now() - startedAt, ok }); }
}

function sanitizeSavedLaunchArgs(raw) {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [id, list] of Object.entries(raw)) {
    if (typeof id !== "string" || !id || !Array.isArray(list)) continue;
    const cleaned = extractPreservedLaunchArgs([`app.exe ${list.filter((item) => typeof item === "string").join(" ")}`]);
    if (cleaned.length) result[id] = cleaned;
  }
  return result;
}

async function rememberPreservedLaunchArgs(installationId, extraArgs) {
  if (!installationId || !Array.isArray(extraArgs) || extraArgs.length === 0) return;
  preservedLaunchArgs.set(installationId, extraArgs);
  const currentSaved = settings.preservedLaunchArgs?.[installationId];
  if (JSON.stringify(currentSaved) !== JSON.stringify(extraArgs)) {
    settings.preservedLaunchArgs = {
      ...(settings.preservedLaunchArgs || {}),
      [installationId]: extraArgs,
    };
    await saveSettings().catch(() => {});
  }
}

function getPreservedLaunchArgs(installationId) {
  if (!installationId) return [];
  return preservedLaunchArgs.get(installationId)
    || settings.preservedLaunchArgs?.[installationId]
    || [];
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    const portsByHost = defaultPortsByHost();
    for (const hostType of HOST_TYPES) {
      try { portsByHost[hostType] = validateCdpPort(parsed.portsByHost?.[hostType]); } catch {}
    }
    // Resolve legacy port ownership once the saved installation has been discovered.
    if (!parsed.portsByHost) {
      try { migratedLegacyPort = validateCdpPort(parsed.port); } catch {}
    }
    const savedArgs = sanitizeSavedLaunchArgs(parsed.preservedLaunchArgs);
    preservedLaunchArgs.clear();
    for (const [id, args] of Object.entries(savedArgs)) preservedLaunchArgs.set(id, args);
    settings = {
      manualExecutables: Array.isArray(parsed.manualExecutables) ? parsed.manualExecutables : [],
      selectedId: typeof parsed.selectedId === "string" ? parsed.selectedId : null,
      port: migratedLegacyPort ?? portsByHost.codex,
      portsByHost,
      adaptive: parsed.adaptive !== false,
      preservedLaunchArgs: savedArgs,
    };
  } catch {
    preservedLaunchArgs.clear();
    settings = {
      manualExecutables: [],
      selectedId: null,
      port: defaultCdpPort("codex"),
      portsByHost: defaultPortsByHost(),
      adaptive: true,
      preservedLaunchArgs: {},
    };
  }
}

function saveSettings() {
  const contents = JSON.stringify(settings, null, 2);
  const write = settingsWriteQueue.then(async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, contents, "utf8");
  });
  settingsWriteQueue = write.catch(() => {});
  return write;
}

async function currentState({ forceRefresh = false } = {}) {
  const installations = await detectInstallations({
    manualExecutables: settings.manualExecutables,
    forceRefresh,
  });
  if (migratedLegacyPort !== null) {
    const legacyHostType = installationHostType(installations.find(({ id }) => id === settings.selectedId));
    settings.portsByHost[legacyHostType] = migratedLegacyPort;
    migratedLegacyPort = null;
  }
  settings.selectedId = selectInstallationId(installations, settings.selectedId);
  selectedHostType = installationHostType(installations.find(({ id }) => id === settings.selectedId));
  settings.port = settings.portsByHost[selectedHostType];
  return {
    installations,
    selectedId: settings.selectedId,
    hasStoreInstall: installations.some(({ kind }) => kind === "store"),
    activeOperation,
    activeInjectionTargets: activeInjectionTargets(),
    port: settings.port,
    portsByHost: { ...settings.portsByHost },
    defaultPortsByHost: defaultPortsByHost(),
    adaptive: settings.adaptive,
  };
}

async function rememberOperationSettings({ installation, port, adaptive } = {}) {
  if (installation) {
    settings.selectedId = installation.id;
    selectedHostType = installationHostType(installation);
  }
  if (port !== undefined) settings.portsByHost[selectedHostType] = validateCdpPort(port);
  settings.port = settings.portsByHost[selectedHostType];
  if (adaptive !== undefined) settings.adaptive = Boolean(adaptive);
  await saveSettings();
}

function assertTrustedEvent(event) {
  const sourceUrl = event.senderFrame?.url || "";
  if (sourceUrl !== rendererUrl) throw new Error("拒绝来自非本地页面的 IPC 请求");
}

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    assertTrustedEvent(event);
    assertNotQuitting();
    return handler(payload);
  });
}

async function runOperation(name, task) {
  if (shutdownRequested) return { ok: false, message: "正在退出，不能启动新的壁纸操作" };
  if (activeOperation) return { ok: false, message: `正在执行“${activeOperation}”，请稍候` };
  activeOperation = name;
  log({ stream: "system", text: `\n[${name}] 开始\n` });
  try {
    const detail = await task();
    log({ stream: "system", text: `[${name}] 完成\n` });
    return { ok: true, message: `${name}完成`, ...detail };
  } catch (error) {
    log({ stream: "stderr", text: `[${name}] ${error.message}\n` });
    return { ok: false, message: error.message };
  } finally {
    activeOperation = null;
  }
}

async function resolveInstallation(installationId, snapshot = null) {
  const state = snapshot ?? await currentState();
  const installation = state.installations.find(({ id }) => id === installationId);
  if (!installation) throw new Error("请选择有效的目标应用");
  return installation;
}

async function writeCompatibilityDiagnostic({ port, installationId, reason }) {
  let diagnostics = { targets: [] };
  let collectionError = null;
  const current = await currentState().catch(() => ({ installations: [] }));
  const installation = current.installations.find(({ id }) => id === installationId) || null;
  try {
    await verifySelectedOwner(installation, validateCdpPort(port));
    const collected = await collectCdpDiagnostics(validateCdpPort(port), {
      hostType: installationHostType(installation),
    });
    // URLs and probe titles are needed internally for target detection, not in
    // saved reports: they can contain an auth route or a conversation title.
    diagnostics = {
      collectedAt: collected.collectedAt,
      browser: collected.browser,
      targets: collected.targets.map(({ type, score, titleMatchesCodex, probe, diagnostics: surfaces }, targetIndex) => ({
        targetIndex, type, score, titleMatchesCodex,
        probe: {
          hasRoot: probe?.hasRoot === true,
          semanticHookCount: probe?.semanticHookCount,
          composerHookCount: probe?.composerHookCount,
          descendantCount: probe?.descendantCount,
        },
        diagnostics: surfaces,
      })),
    };
  } catch {
    collectionError = "诊断采集失败或目标身份未核验";
  }
  const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    note: "自动兼容诊断不采集对话正文，仅包含版本、DOM 语义命中和表面样式摘要。",
    reason: sanitizeLogText(reason),
    port: Number.isInteger(port) ? port : null,
    collectionError,
    installation: installation ? {
      id: installation.id,
      kind: installation.kind,
      label: installation.label,
      version: installation.version,
      executableName: path.basename(installation.path),
    } : null,
    ...diagnostics,
  };
  await mkdir(logsRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const diagnosticPath = path.join(logsRoot, `codex-compat-${timestamp}.json`);
  await writeFile(diagnosticPath, JSON.stringify(report, null, 2), "utf8");
  return diagnosticPath;
}

async function injectOnceAtPort({ installation, port, adaptive, signal }) {
  signal?.throwIfAborted();
  assertNotQuitting();
  const startedAt = performance.now();
  const control = await measureStartupPhase("control", () => ensureControlPanel(port));
  assertNotQuitting();
  signal?.throwIfAborted();
  const hostType = installationHostType(installation);
  await reconcileEndpointRegistrations();
  signal?.throwIfAborted();
  assertNotQuitting();
  const binding = rememberEndpoint(installation, port);
  const injection = await measureStartupPhase("apply", () => invokeBridgeAction({
    controlUrl: control.url, action: "inject", adaptive: Boolean(adaptive), hostType, port,
  })).catch(async (error) => {
    await reconcileEndpointError(binding, error, control.url);
    throw error;
  });
  forgetReleasedEndpoints(hostType, [{ hostType, port }]);
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  return {
    compatibility: injection.compatibility || [],
    adaptive: Boolean(adaptive),
    injection,
    elapsedMs,
    message: `${injection.message || "Runtime 与背景 DOM 已注入"}；总流程 ${elapsedMs} ms`,
  };
}

async function confirmCloseRunningCodex(installation) {
  if (typeof mainWindow?.isVisible === "function" && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
    showMainWindow();
  }
  const hostName = hostDisplayName(installationHostType(installation));
  const processCount = installation.processIds?.length || 0;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: `${hostName} 正在运行`,
    message: `${installation.label}正在运行，是否关闭并继续？`,
    detail: `将只关闭下面路径对应的 ${hostName} 进程，然后以调试模式重新启动并自动完成快速流式注入。请先保存尚未发送的输入。\n\n${installation.path}\n\n已发现进程：${processCount} 个`,
    buttons: ["关闭并继续", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function confirmLaunchSeparateCodex(installation, runningInstallations) {
  assertNotQuitting();
  if (typeof mainWindow?.isVisible === "function" && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
    showMainWindow();
  }
  const hostName = hostDisplayName(installationHostType(installation));
  const runningDetails = runningInstallations.map(({ label, path: executablePath }) => `${label}\n${executablePath}`).join("\n\n");
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: `将启动另一版本的 ${hostName}`,
    message: `所选 ${hostName} 与正在运行的版本不同，是否另开窗口？`,
    detail: `正在运行（不会关闭）：\n${runningDetails}\n\n即将启动：\n${installation.label}\n${installation.path}\n\n继续会使用独立调试配置打开新窗口，壁纸将应用到新窗口，不会应用到原有窗口。若要给原有版本应用壁纸，请取消并在工作台顶部选择对应版本。`,
    buttons: ["另开所选版本", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

function createMainWindow() {
  const windowIcon = typeof nativeImage?.createFromDataURL === "function"
    ? nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
    : undefined;
  const window = new BrowserWindow({
    width: 1540,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#0c0d10",
    title: "Lumina",
    ...(windowIcon ? { icon: windowIcon } : {}),
    ...desktopWindowChromeOptions(process.platform),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.loadURL(rendererUrl);
  const hideToTray = (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
    if (!hasShownTrayNotice) {
      hasShownTrayNotice = true;
      trayController?.showResidentNotice();
    }
  };
  window.on("minimize", hideToTray);
  window.on("close", hideToTray);
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendTrayAction(action) {
  showMainWindow();
  const send = () => mainWindow?.webContents.send("cwb:tray-action", action);
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function assertNotQuitting() {
  if (shutdownRequested) throw new Error("正在退出，不能启动新的壁纸操作");
}

async function verifySelectedOwner(installation, port, { restoring = false } = {}) {
  if (!restoring) assertNotQuitting();
  if (!installation) throw new Error("没有所选的目标应用");
  assertAcceptanceTarget(installation, port);
  const expected = acceptanceContext?.expectedHost;
  const key = JSON.stringify([installation.id, path.win32.normalize(installation.path).toLowerCase(), port, restoring]);
  // Coalesce overlapping identical queries only. A settled promise is removed,
  // so reconnects and subsequent operations can never inherit stale ownership.
  if (pendingOwnerChecks.has(key)) return pendingOwnerChecks.get(key);
  const query = Promise.resolve().then(() => verifyCdpEndpointOwner({
    installation, port,
    ...(expected ? { expectedProcess: { pid: expected.pid, creation: expected.creation, profile: expected.profile } } : {}),
  })).then((result) => {
    if (!restoring) assertNotQuitting();
    return result;
  }).finally(() => {
    pendingOwnerChecks.delete(key);
  });
  pendingOwnerChecks.set(key, query);
  return query;
}

function assertAcceptanceTarget(installation, port) {
  const expected = acceptanceContext?.expectedHost;
  if (acceptanceContext && (!expected || port !== expected.port
    || path.win32.normalize(installation.path).toLowerCase() !== path.win32.normalize(expected.exe).toLowerCase())) {
    throw new Error("独立验收只允许 target.json 指定的测试宿主和端口");
  }
}

function assertPortAvailable(installation, port) {
  const assigned = verifiedEndpointInstallations.get(port)?.installation;
  if (assigned && assigned.id !== installation.id) {
    throw hostPortConflict(port, installationHostType(assigned));
  }
}

function rememberEndpoint(installation, port) {
  assertPortAvailable(installation, port);
  const existing = verifiedEndpointInstallations.get(port);
  if (existing) return existing;
  const binding = { port, installation: {
    id: installation.id, path: installation.path, hostType: installationHostType(installation),
  }, registered: false };
  verifiedEndpointInstallations.set(port, binding);
  return binding;
}

function activeInjectionTargets() {
  return [...verifiedEndpointInstallations.values()].filter(({ registered }) => registered)
    .map(({ port, installation, reconcileUrl }) => ({
      port, installationId: installation.id, hostType: installation.hostType,
      ...(reconcileUrl ? { reconcilePending: true } : {}),
    }));
}

function assertRestoreTarget(installation, port) {
  const hostType = installationHostType(installation);
  const owner = [...verifiedEndpointInstallations.values()].find((binding) =>
    binding.registered && binding.installation.hostType === hostType
    && (binding.port !== port || binding.installation.id !== installation.id));
  if (owner) {
    throw new Error(`${hostDisplayName(hostType)} 当前使用 CDP 端口 ${owner.port}，请选择原安装及该端口恢复`);
  }
  const takeover = takeovers.get(hostType);
  if (takeover && !takeover.controller.signal.aborted
    && (takeover.port !== port || takeover.installation.id !== installation.id)) {
    throw new Error(`${hostDisplayName(hostType)} 正在 CDP 端口 ${takeover.port} 自动接管，请选择原安装及该端口恢复`);
  }
  assertPortAvailable(installation, port);
}

function forgetReleasedEndpoints(hostType, registeredHosts) {
  for (const [port, binding] of verifiedEndpointInstallations) {
    if (binding.installation.hostType !== hostType) continue;
    if (!registeredHosts.some((entry) => entry.hostType === hostType && entry.port === port)) {
      verifiedEndpointInstallations.delete(port);
    } else {
      binding.registered = true;
      binding.reconcileUrl = null;
    }
  }
}

async function reconcileEndpointRegistrations() {
  const pending = [...verifiedEndpointInstallations.values()].filter(({ reconcileUrl }) => reconcileUrl);
  if (!pending.length) return;
  try {
    const status = await invokeBridgeAction({ controlUrl: pending[0].reconcileUrl, action: "injection-status" });
    if (!Array.isArray(status.registeredHosts)) return;
    for (const binding of pending) {
      if (verifiedEndpointInstallations.get(binding.port) === binding) {
        forgetReleasedEndpoints(binding.installation.hostType, status.registeredHosts);
      }
    }
  } catch {
    // Retain the verification binding while the bridge outcome is unknown.
    // The next operation retries reconciliation or the child exit clears it.
  }
}

async function reconcileEndpointError(binding, error, controlUrl) {
  if (verifiedEndpointInstallations.get(binding.port) !== binding) return;
  if (Array.isArray(error.registeredHosts)) {
    forgetReleasedEndpoints(binding.installation.hostType, error.registeredHosts);
  } else if (error.notExecuted === true || (error.statusCode >= 400 && error.statusCode < 500)) {
    if (!binding.registered && !binding.reconcileUrl) verifiedEndpointInstallations.delete(binding.port);
  } else {
    binding.reconcileUrl = controlUrl;
    for (const previous of verifiedEndpointInstallations.values()) {
      if (previous.registered && previous.installation.hostType === binding.installation.hostType) {
        previous.reconcileUrl = controlUrl;
      }
    }
    await reconcileEndpointRegistrations();
  }
}

function assertTrustedControlUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("壁纸控制页必须来自本机 127.0.0.1");
  }
  return parsed.href;
}

async function ensureControlPanel(port) {
  assertNotQuitting();
  controlSessionPort ??= validateCdpPort(port);
  return previewSession.ensure(controlSessionPort);
}

function createApplicationTray() {
  trayController = createTrayController({
    TrayCtor: Tray,
    MenuApi: Menu,
    nativeImageApi: nativeImage,
    actions: {
      showWindow: showMainWindow,
      apply: () => sendTrayAction("apply"),
      restore: () => sendTrayAction("restore"),
      openLogs: async () => {
        await mkdir(logsRoot, { recursive: true });
        const error = await shell.openPath(logsRoot);
        if (error) throw new Error(error);
      },
      quit: () => {
        isQuitting = true;
        app.quit();
      },
    },
    onError: (error) => log({ stream: "stderr", text: `托盘操作失败：${error.message}\n` }),
  });
}

function stopCodexTakeover(context) {
  if (context.controller.signal.aborted) return;
  context.controller.abort();
  context.watcher?.stop();
  context.monitor?.stop();
  context.snapshot = null;
  if (!context.task) takeovers.delete(context.hostType);
}

async function cancelCodexTakeover(hostType) {
  const contexts = hostType === undefined ? [...takeovers.values()] : [takeovers.get(hostType)].filter(Boolean);
  for (const context of contexts) stopCodexTakeover(context);
  await Promise.all(contexts.map(({ task }) => task));
}

async function drainTakeoverForTarget(installationId, port) {
  const running = [...takeovers.values()].find(({ task }) => task);
  if (!running) return;
  const state = await currentState();
  const installation = state.installations.find(({ id }) => id === (installationId || state.selectedId));
  if (!installation || installationHostType(installation) !== running.hostType || takeovers.get(running.hostType) !== running) return;
  try { assertPortAvailable(installation, validateCdpPort(port ?? settings.portsByHost[running.hostType])); }
  catch { return; }
  await cancelCodexTakeover(running.hostType);
}

function startCodexTakeover({ installation, port, adaptive, baselineProcessIds = [] }) {
  if (acceptanceContext || shutdownRequested || !installation?.path) return;
  const hostType = installationHostType(installation);
  const hostName = hostDisplayName(hostType);
  const context = {
    installation: { ...installation }, port: validateCdpPort(port),
    adaptive: Boolean(adaptive), hostType, controller: new AbortController(),
    watcher: null, monitor: null, snapshot: null, task: null,
  };
  takeovers.set(hostType, context);
  const isCurrent = () => takeovers.get(hostType) === context && !context.controller.signal.aborted && !shutdownRequested && !isQuitting;
  const failClosed = (error) => {
    if (!isCurrent()) return;
    stopCodexTakeover(context);
    log({ stream: "stderr", text: `[自动接管 ${hostName}] 已暂停，请重新应用壁纸后再试：${error.message}\n` });
  };
  try {
    context.monitor = startCodexProcessMonitor({
      executablePath: context.installation.path, port: context.port, intervalMs: 3_000,
      onSnapshot: (snapshot) => { if (isCurrent()) context.snapshot = snapshot; },
      onError: failClosed,
    });
    if (!isCurrent()) { context.monitor.stop(); return; }
    context.watcher = createCodexTakeoverWatcher({
      port: context.port, intervalMs: 5_000,
      isEnabled: isCurrent,
      isBusy: () => Boolean(activeOperation),
      ignoredProcessIds: baselineProcessIds,
      listProcesses: async () => context.snapshot,
      onTakeover: ({ ordinary }) => {
        if (!isCurrent() || activeOperation) return;
        const extraArgs = extractPreservedLaunchArgs(ordinary.map((entry) => entry.commandLine));
        if (extraArgs.length) void rememberPreservedLaunchArgs(context.installation.id, extraArgs);
        const task = runOperation(`自动接管 ${hostName}`, async () => {
          const result = await runCodexTakeoverFlow({
            installation: context.installation, port: context.port, adaptive: context.adaptive,
            expectedProcesses: ordinary, signal: context.controller.signal, isCurrent,
            listProcesses: (selected) => listCodexProcesses({ executablePath: selected.path, port: context.port }),
            isEndpointReady: isCdpEndpointReady,
            confirmClose: confirmCloseRunningCodex,
            closeCodex: (selected, expectedProcesses) => closeCodexProcesses({
              installation: selected, expectedProcesses, signal: context.controller.signal, onLog: log,
            }),
            launchCodex: (options) => launchCodex({
              ...options,
              profileRoot: path.join(app.getPath("userData"), "codex-profiles"),
              extraArgs: getPreservedLaunchArgs(context.installation.id),
              onLog: log,
            }),
            waitForTarget: (selectedPort, signal) => waitForCodexTarget(selectedPort, { signal, hostType: context.hostType }),
            verifyOwner: verifySelectedOwner,
            injectOnce: (options) => injectOnceAtPort({ ...options, installation: context.installation }),
          });
          if (result.canceled || result.skipped) stopCodexTakeover(context);
          return result;
        }).then((operation) => {
          if (!operation.ok) failClosed(new Error(operation.message));
          return operation;
        }).finally(() => {
          context.snapshot = null;
          context.task = null;
          if (context.controller.signal.aborted && takeovers.get(hostType) === context) takeovers.delete(hostType);
        });
        context.task = task;
        return task;
      },
      onError: failClosed,
    });
    context.watcher.start();
    log({ stream: "system", text: "[自动接管] 已启用监控：普通实例重开后需确认才重启；取消或失败将暂停接管\n" });
  } catch (error) { failClosed(error); }
}

function registerIpcHandlers() {
  registerHandler("cwb:get-state", () => currentState());
  registerHandler("cwb:set-workbench-theme", (theme) => setWindowChromeTheme(mainWindow, theme, process.platform));
  registerHandler("cwb:refresh-installations", async () => {
    const state = await currentState({ forceRefresh: true });
    await saveSettings();
    return state;
  });
  registerHandler("cwb:choose-executable", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Codex 或 Antigravity 可执行文件",
      properties: ["openFile"],
      filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
    });
    if (result.canceled || !result.filePaths[0]) return currentState();
    assertNotQuitting();
    if (activeOperation) throw new Error("壁纸操作进行中，请稍后切换目标");
    const executablePath = await validateExecutable(result.filePaths[0]);
    if (typeof inspectExecutableIdentity === "function") {
      const identity = await inspectExecutableIdentity(executablePath).catch(() => null);
      if (identity && !identity.looksLikeCodex && !identity.looksLikeAntigravity) {
        const confirm = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "确认所选可执行文件",
          message: "所选程序未检测到 Codex / Antigravity 身份标识，是否仍要将其作为目标？",
          detail: `${executablePath}\n\n应用壁纸时若该程序正在运行，本程序会尝试关闭并重启该路径对应的所有进程。若不确定它是 Codex 或 Antigravity 桌面版，建议取消。`,
          buttons: ["仍要添加", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirm.response !== 0) return currentState();
      }
    }
    if (!settings.manualExecutables.some((entry) => entry.toLowerCase() === executablePath.toLowerCase())) {
      settings.manualExecutables.push(executablePath);
    }
    const state = await currentState({ forceRefresh: true });
    const selected = state.installations.find(({ path: entry }) => entry.toLowerCase() === executablePath.toLowerCase());
    settings.selectedId = selected?.id || settings.selectedId;
    const updatedState = await currentState();
    await saveSettings();
    return updatedState;
  });
  registerHandler("cwb:apply-codex", async ({ installationId, port, adaptive = true } = {}) => {
    await drainTakeoverForTarget(installationId, port);
    const result = await runOperation("应用壁纸", async () => {
    const operationStartedAt = performance.now();
    let completed = false;
    let resolvedInstallationId = installationId;
    let resolvedPort = port;
    try {
      const snapshot = await measureStartupPhase("discovery", currentState);
      resolvedInstallationId = installationId || snapshot.selectedId;
      const installation = await resolveInstallation(resolvedInstallationId, snapshot);
      const hostType = installationHostType(installation);
      const hostName = hostDisplayName(hostType);
      const normalizedPort = resolvedPort = validateCdpPort(port ?? settings.portsByHost[hostType]);
      await reconcileEndpointRegistrations();
      assertPortAvailable(installation, normalizedPort);
      assertAcceptanceTarget(installation, normalizedPort);
      await cancelCodexTakeover(hostType);
      await rememberOperationSettings({ installation, port: normalizedPort, adaptive });
      // Reuse the process snapshot taken before applying. Every process that
      // already existed is ignored by the takeover watcher; only a target
      // process created after this point may trigger a reclaim.
      const baselineProcessIds = installation.processIds || [];
      const flow = await runLaunchAndInjectFlow({
        installation,
        runningInstallations: snapshot.installations.filter(
          (entry) => entry.isRunning && installationHostType(entry) === hostType,
        ),
        port: normalizedPort,
        adaptive: Boolean(adaptive),
        onPhase: logStartupPhase,
        isEndpointReady: async (selectedPort) => {
          assertNotQuitting();
          const ready = await isCdpEndpointReady(selectedPort);
          if (acceptanceContext && !ready) throw new Error("独立验收只连接预先启动的测试实例，不启动或关闭 Codex");
          return ready;
        },
        verifyEndpointOwner: verifySelectedOwner,
        confirmClose: confirmCloseRunningCodex,
        confirmLaunchSeparate: confirmLaunchSeparateCodex,
        closeCodex: async (selected) => {
          assertNotQuitting();
          if (acceptanceContext) throw new Error("独立验收不得关闭 Codex");
          try {
            const processes = await listCodexProcesses({ executablePath: selected.path, port: normalizedPort });
            const extraArgs = extractPreservedLaunchArgs(processes.map((entry) => entry.commandLine));
            if (extraArgs.length) await rememberPreservedLaunchArgs(selected.id, extraArgs);
          } catch {}
          return closeCodexProcesses({ installation: selected, onLog: log });
        },
        launchCodex: ({ installation: selected, port: selectedPort }) => {
          assertNotQuitting();
          if (acceptanceContext) throw new Error("独立验收不得启动 Codex");
          const extraArgs = getPreservedLaunchArgs(selected.id);
          return launchCodex({
            installation: selected,
            port: selectedPort,
            profileRoot: path.join(app.getPath("userData"), "codex-profiles"),
            ...(extraArgs.length ? { extraArgs } : {}),
            onLog: log,
          });
        },
        waitForTarget: (selectedPort) => waitForCodexTarget(selectedPort, { hostType }),
        injectOnce: (options) => injectOnceAtPort({ ...options, installation }),
      });
      if (flow.canceled) return flow;
      completed = true;
      try {
        startCodexTakeover({ installation, port: normalizedPort, adaptive: Boolean(adaptive), baselineProcessIds });
      } catch (error) {
        log({ stream: "stderr", text: `[自动接管] 启用失败：${error.message}\n` });
      }
      return {
        result: flow.launch,
        compatibility: flow.injection.compatibility,
        adaptive: flow.injection.adaptive,
        activeHosts: flow.injection.injection.activeHosts,
        injectorActive: flow.injection.injection.injectorActive,
        closedCount: flow.closed?.closedCount || 0,
        message: flow.launch
          ? `${hostName} 已启动并应用壁纸；媒体服务将在托盘中保持运行`
          : `壁纸已重新应用到正在调试的 ${hostName}`,
      };
    } catch (error) {
      try {
        const diagnosticPath = await writeCompatibilityDiagnostic({
          port: resolvedPort,
          installationId: resolvedInstallationId,
          reason: error.message,
        });
        log({ stream: "system", text: `已自动写入兼容诊断：${diagnosticPath}\n` });
      } catch (diagnosticError) {
        log({ stream: "stderr", text: `兼容诊断写入失败：${diagnosticError.message}\n` });
      }
      throw error;
    } finally {
      logStartupPhase({ phase: "total", elapsedMs: performance.now() - operationStartedAt, ok: completed });
    }
    });
    return { ...result, activeInjectionTargets: activeInjectionTargets() };
  });
  registerHandler("cwb:restore", async ({ installationId, port } = {}) => {
    const resolveTarget = async () => {
      const snapshot = await currentState();
      const installation = await resolveInstallation(installationId || snapshot.selectedId, snapshot);
      const hostType = installationHostType(installation);
      const normalizedPort = validateCdpPort(port ?? settings.portsByHost[hostType]);
      await reconcileEndpointRegistrations();
      assertRestoreTarget(installation, normalizedPort);
      return { installation, hostType, normalizedPort };
    };
    let target;
    if ([...takeovers.values()].some(({ task }) => task)) {
      try { target = await resolveTarget(); }
      catch (error) { return { ok: false, message: error.message, activeInjectionTargets: activeInjectionTargets() }; }
      if (takeovers.get(target.hostType)?.task) await cancelCodexTakeover(target.hostType);
    }
    const operation = await runOperation("恢复官方外观", async () => {
      const { installation, hostType, normalizedPort } = target ?? await resolveTarget();
      assertRestoreTarget(installation, normalizedPort);
      await verifySelectedOwner(installation, normalizedPort);
      await cancelCodexTakeover(hostType);
      await rememberOperationSettings({ installation, port: normalizedPort });
      assertNotQuitting();
      const control = await ensureControlPanel(normalizedPort);
      const binding = rememberEndpoint(installation, normalizedPort);
      try {
        const result = await invokeBridgeAction({ controlUrl: control.url, action: "restore", hostType, port: normalizedPort });
        verifiedEndpointInstallations.delete(normalizedPort);
        return result;
      } catch (error) {
        await reconcileEndpointError(binding, error, control.url);
        throw error;
      }
    });
    return { ...operation, activeInjectionTargets: activeInjectionTargets() };
  });
  registerHandler("cwb:open-control-panel", async ({ port } = {}) => {
    return runOperation("载入壁纸面板", async () => {
      await currentState();
      const normalizedPort = validateCdpPort(port ?? settings.port);
      await rememberOperationSettings({ port: normalizedPort });
      return ensureControlPanel(normalizedPort);
    });
  });
}

const quitRunningInstanceRequested = Array.isArray(process.argv) && process.argv.includes("--quit-running-instance");
if (!hasSingleInstanceLock || quitRunningInstanceRequested) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (Array.isArray(argv) && argv.includes("--quit-running-instance")) {
      isQuitting = true;
      app.quit();
      return;
    }
    showMainWindow();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId("com.local.codex-wallpaper-desktop");
    session?.defaultSession?.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    session?.defaultSession?.setPermissionCheckHandler?.(() => false);
    await installDesktopRendererProtocol({ protocol, rendererRoot });
    settingsPath = path.join(app.getPath("userData"), "settings.json");
    logsRoot = acceptanceContext?.logsRoot || path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "CodexWallpaperDesktop", "logs");
    bridgeRoot = resolveBridgeRoot({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    await loadSettings();
    registerIpcHandlers();
    mainWindow = createMainWindow();
    createApplicationTray();
    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("before-quit", (event) => {
  isQuitting = true;
  shutdownRequested = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = cancelCodexTakeover()
    .then(() => previewSession.shutdown())
    .then(() => nativeEngineHost?.close())
    .then(() => settingsWriteQueue)
    .then(() => logWriteQueue)
    .then(() => {
      shutdownComplete = true;
      app.quit();
    })
    .catch((error) => {
      shutdownPromise = null;
      isQuitting = false;
      log({ stream: "stderr", text: `退出清理失败：${error.message}\n` });
      showMainWindow();
      dialog.showErrorBox("退出清理未完成", "壁纸服务尚未确认退出，请稍后再次从托盘退出。详情见本地日志。");
    });
});

app.on("will-quit", () => {
  trayController?.destroy();
  trayController = null;
});
