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
import { classifyCodexProcesses } from "./codex-processes.mjs";
import { startCodexProcessMonitor } from "./codex-process-monitor.mjs";
import { createCodexTakeoverWatcher } from "./codex-takeover.mjs";
import { detectInstallations, selectInstallationId, validateCdpPort, validateExecutable } from "./installations.mjs";
import { runLaunchAndInjectFlow } from "./launch-flow.mjs";
import { dailyLogFilename, formatLogEntry, sanitizeLogText } from "./local-logging.mjs";
import { createTrayController } from "./tray-controller.mjs";
import { desktopWindowChromeOptions, setWindowChromeTheme } from "./window-chrome.mjs";
import { prepareAcceptanceContext } from "./acceptance-context.mjs";
import { verifyCdpEndpointOwner } from "./cdp-owner.mjs";
import { createPreviewSession, stopPreviewProcess } from "./preview-session.mjs";
import { createDesktopEngineHost } from "./desktop-engine-host.mjs";
import { registerDesktopRendererScheme, installDesktopRendererProtocol } from "./desktop-renderer-protocol.mjs";
import { DESKTOP_RENDERER_URL } from "../bridge-runtime/src/desktop-origin.mjs";

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
let settings = {
  manualExecutables: [],
  selectedId: null,
  port: 9335,
  adaptive: true,
};
let activeOperation = null;
let settingsPath = null;
let logsRoot = null;
let bridgeRoot = null;
let logWriteQueue = Promise.resolve();
let nativeEngineHost = null;
// Cache only the selected executable descriptor, never a successful PID/port
// ownership result. Background CDP attachments still perform a fresh check.
let verifiedEndpointInstallation = null;
let pendingOwnerCheck = null;
let codexTakeover = null;
let codexProcessMonitor = null;
let latestCodexProcesses = [];
let staleCleanupTimer = null;
let takeoverContext = null;
let takeoverRunning = false;
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
    verifyEndpoint: async (port) => {
      let installation = verifiedEndpointInstallation?.port === port
        && verifiedEndpointInstallation.installation.id === settings.selectedId
        ? verifiedEndpointInstallation.installation : null;
      if (!installation) {
        const state = await currentState();
        installation = state.installations.find(({ id }) => id === state.selectedId);
      }
      if (!installation) throw new Error("没有所选的 Codex 安装目标");
      await verifySelectedOwner(installation, port);
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
    serviceName: "Codex Wallpaper Bridge",
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
    confirmation: "等待用户确认", close: "关闭已确认实例", launch: "启动 Codex",
    target: "等待 Codex 页面", control: "准备壁纸服务", inject: "注入流程",
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

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    let savedPort = 9335;
    try {
      savedPort = validateCdpPort(parsed.port ?? 9335);
    } catch {
      savedPort = 9335;
    }
    settings = {
      manualExecutables: Array.isArray(parsed.manualExecutables) ? parsed.manualExecutables : [],
      selectedId: typeof parsed.selectedId === "string" ? parsed.selectedId : null,
      port: savedPort,
      adaptive: parsed.adaptive !== false,
    };
  } catch {
    settings = {
      manualExecutables: [],
      selectedId: null,
      port: 9335,
      adaptive: true,
    };
  }
}

async function saveSettings() {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

async function currentState() {
  const installations = await detectInstallations({ manualExecutables: settings.manualExecutables });
  settings.selectedId = selectInstallationId(installations, settings.selectedId);
  return {
    installations,
    selectedId: settings.selectedId,
    hasStoreInstall: installations.some(({ kind }) => kind === "store"),
    activeOperation,
    port: settings.port,
    adaptive: settings.adaptive,
  };
}

async function rememberOperationSettings({ port, adaptive } = {}) {
  if (port !== undefined) settings.port = validateCdpPort(port);
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
  if (!installation) throw new Error("请选择有效的 Codex 安装");
  settings.selectedId = installation.id;
  await saveSettings();
  return installation;
}

async function writeCompatibilityDiagnostic({ port, installationId, reason }) {
  let diagnostics = { targets: [] };
  let collectionError = null;
  const current = await currentState().catch(() => ({ installations: [] }));
  const installation = current.installations.find(({ id }) => id === installationId) || null;
  try {
    await verifySelectedOwner(installation, validateCdpPort(port));
    const collected = await collectCdpDiagnostics(validateCdpPort(port));
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

async function injectOnceAtPort({ port, adaptive }) {
  assertNotQuitting();
  const startedAt = performance.now();
  const control = await measureStartupPhase("control", () => ensureControlPanel(port));
  assertNotQuitting();
  const injection = await measureStartupPhase("apply", () => invokeBridgeAction({ controlUrl: control.url, action: "inject", adaptive: Boolean(adaptive) }));
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
  const processCount = installation.processIds?.length || 0;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Codex 正在运行",
    message: `${installation.label}正在运行，是否关闭并继续？`,
    detail: `将只关闭下面路径对应的 Codex 进程，然后以调试模式重新启动并自动完成快速流式注入。请先保存尚未发送的输入。\n\n${installation.path}\n\n已发现进程：${processCount} 个`,
    buttons: ["关闭并继续", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function confirmLaunchSeparateCodex(installation, runningInstallations) {
  assertNotQuitting();
  const runningDetails = runningInstallations.map(({ label, path: executablePath }) => `${label}\n${executablePath}`).join("\n\n");
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "将启动另一版本的 Codex",
    message: "所选 Codex 与正在运行的版本不同，是否另开窗口？",
    detail: `正在运行（不会关闭）：\n${runningDetails}\n\n即将启动：\n${installation.label}\n${installation.path}\n\n继续会使用独立调试配置打开新窗口，壁纸将应用到新窗口，不会应用到原有窗口。若要给原有版本应用壁纸，请取消并在工作台顶部选择对应版本。`,
    buttons: ["另开所选版本", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#0b0d0b",
    title: "Codex Wallpaper Desktop",
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

async function verifySelectedOwner(installation, port) {
  assertNotQuitting();
  const expected = acceptanceContext?.expectedHost;
  if (acceptanceContext && (!expected || port !== expected.port
    || path.win32.normalize(installation.path).toLowerCase() !== path.win32.normalize(expected.exe).toLowerCase())) {
    throw new Error("独立验收只允许 target.json 指定的测试宿主和端口");
  }
  const key = JSON.stringify([installation.id, path.win32.normalize(installation.path).toLowerCase(), port]);
  // Coalesce overlapping identical queries only. A settled promise is removed,
  // so reconnects and subsequent operations can never inherit stale ownership.
  if (pendingOwnerCheck?.key === key) return pendingOwnerCheck.promise;
  const record = { key, promise: null };
  record.promise = Promise.resolve().then(() => verifyCdpEndpointOwner({
    installation, port,
    ...(expected ? { expectedProcess: { pid: expected.pid, creation: expected.creation, profile: expected.profile } } : {}),
  })).then((result) => {
    assertNotQuitting();
    verifiedEndpointInstallation = { port, installation: { id: installation.id, path: installation.path } };
    return result;
  }).catch((error) => {
    verifiedEndpointInstallation = null;
    throw error;
  }).finally(() => {
    if (pendingOwnerCheck === record) pendingOwnerCheck = null;
  });
  pendingOwnerCheck = record;
  return record.promise;
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
  return previewSession.ensure(validateCdpPort(port));
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

function stopCodexTakeover() {
  codexTakeover?.stop();
  codexTakeover = null;
  codexProcessMonitor?.stop();
  codexProcessMonitor = null;
  clearTimeout(staleCleanupTimer);
  staleCleanupTimer = null;
  latestCodexProcesses = [];
  takeoverContext = null;
}

function startCodexTakeover({ installation, port, adaptive, baselineProcessIds = [] }) {
  stopCodexTakeover();
  if (acceptanceContext || shutdownRequested || !installation?.path) return;
  takeoverContext = {
    installation: { ...installation },
    port: validateCdpPort(port),
    adaptive: Boolean(adaptive),
    baselineProcessIds: new Set((baselineProcessIds || []).map(Number).filter(Number.isInteger)),
  };
  try {
    codexProcessMonitor = startCodexProcessMonitor({
      executablePath: takeoverContext.installation.path,
      port: takeoverContext.port,
      intervalMs: 3_000,
      onSnapshot: (processes) => { latestCodexProcesses = processes; },
      onError: (error) => log({ stream: "stderr", text: `[自动接管] 进程监控失败：${error.message}\n` }),
    });
  } catch (error) {
    log({ stream: "stderr", text: `[自动接管] 进程监控启动失败：${error.message}\n` });
  }
  codexTakeover = createCodexTakeoverWatcher({
    port: takeoverContext.port,
    intervalMs: 5_000,
    isEnabled: () => !shutdownRequested && !isQuitting && !acceptanceContext,
    isBusy: () => Boolean(activeOperation) || takeoverRunning,
    ignoredProcessIds: takeoverContext.baselineProcessIds,
    listProcesses: async () => latestCodexProcesses,
    onTakeover: async ({ ordinary }) => {
      if (takeoverRunning || shutdownRequested) return;
      takeoverRunning = true;
      const context = takeoverContext;
      log({ stream: "system", text: `\n[自动接管] 检测到 Codex 以普通模式重新打开（${ordinary.length} 个窗口），正在恢复调试实例…\n` });
      try {
        const operation = await runOperation("自动接管 Codex", async () => {
          const state = await currentState();
          const selected = state.installations.find(({ id }) => id === context.installation.id)
            || state.installations.find(({ path: executablePath }) => (
              path.win32.normalize(String(executablePath || "")).toLowerCase()
              === path.win32.normalize(String(context.installation.path || "")).toLowerCase()
            ));
          if (!selected) throw new Error("找不到目标 Codex 安装");
          await closeCodexProcesses({ installation: selected, onLog: log });
          await launchCodex({
            installation: { ...selected, isRunning: false, processIds: [] },
            port: context.port,
            profileRoot: path.join(app.getPath("userData"), "codex-profiles"),
            onLog: log,
          });
          await waitForCodexTarget(context.port);
          await verifySelectedOwner(selected, context.port);
          await injectOnceAtPort({ port: context.port, adaptive: context.adaptive });
          return { restored: true };
        });
        if (!operation.ok) {
          log({ stream: "stderr", text: `[自动接管] 未完成：${operation.message}\n` });
        } else {
          log({ stream: "system", text: "[自动接管] 完成，壁纸已恢复到调试实例\n" });
        }
      } catch (error) {
        log({ stream: "stderr", text: `[自动接管] 失败：${error.message}\n` });
      } finally {
        takeoverRunning = false;
      }
    },
    onError: () => {},
  });
  codexTakeover.start();
  const cleanStaleProcesses = () => {
    if (shutdownRequested || !takeoverContext) return;
    if (latestCodexProcesses.length === 0) {
      staleCleanupTimer = setTimeout(cleanStaleProcesses, 3_000);
      staleCleanupTimer.unref?.();
      return;
    }
    const { ordinary } = classifyCodexProcesses(latestCodexProcesses, takeoverContext.port);
    const stale = ordinary.filter((entry) => (
      takeoverContext.baselineProcessIds.has(entry.processId) && entry.mainWindowHandle === 0
    ));
    for (const entry of stale) {
      try {
        process.kill(entry.processId);
        log({ stream: "system", text: `[自动接管] 已清理后台普通 Codex 进程 ${entry.processId}\n` });
      } catch {}
    }
  };
  staleCleanupTimer = setTimeout(cleanStaleProcesses, 2_000);
  staleCleanupTimer.unref?.();
  log({ stream: "system", text: "[自动接管] 已启用：检测到普通模式 Codex 重开时会自动接管\n" });
}

function registerIpcHandlers() {
  registerHandler("cwb:get-state", () => currentState());
  registerHandler("cwb:set-workbench-theme", (theme) => setWindowChromeTheme(mainWindow, theme, process.platform));
  registerHandler("cwb:refresh-installations", async () => {
    const state = await currentState();
    await saveSettings();
    return state;
  });
  registerHandler("cwb:choose-executable", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Codex 的 ChatGPT.exe",
      properties: ["openFile"],
      filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
    });
    if (result.canceled || !result.filePaths[0]) return currentState();
    const executablePath = await validateExecutable(result.filePaths[0]);
    if (!settings.manualExecutables.some((entry) => entry.toLowerCase() === executablePath.toLowerCase())) {
      settings.manualExecutables.push(executablePath);
    }
    const state = await currentState();
    const selected = state.installations.find(({ path: entry }) => entry.toLowerCase() === executablePath.toLowerCase());
    settings.selectedId = selected?.id || settings.selectedId;
    await saveSettings();
    return currentState();
  });
  registerHandler("cwb:apply-codex", ({ installationId, port, adaptive = true } = {}) => runOperation("应用到 Codex", async () => {
    const operationStartedAt = performance.now();
    let completed = false;
    try {
      await rememberOperationSettings({ port, adaptive });
      const snapshot = await measureStartupPhase("discovery", currentState);
      const installation = await resolveInstallation(installationId, snapshot);
      const normalizedPort = validateCdpPort(port);
      // Reuse the process snapshot taken before applying. Every process that
      // already existed is ignored by the takeover watcher; only a Codex
      // process created after this point may trigger a reclaim.
      const baselineProcessIds = installation.processIds || [];
      const flow = await runLaunchAndInjectFlow({
        installation,
        runningInstallations: snapshot.installations.filter(({ isRunning }) => isRunning),
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
        closeCodex: (selected) => {
          assertNotQuitting();
          if (acceptanceContext) throw new Error("独立验收不得关闭 Codex");
          return closeCodexProcesses({ installation: selected, onLog: log });
        },
        launchCodex: ({ installation: selected, port: selectedPort }) => {
          assertNotQuitting();
          if (acceptanceContext) throw new Error("独立验收不得启动 Codex");
          return launchCodex({
            installation: selected,
            port: selectedPort,
            profileRoot: path.join(app.getPath("userData"), "codex-profiles"),
            onLog: log,
          });
        },
        waitForTarget: waitForCodexTarget,
        injectOnce: injectOnceAtPort,
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
        closedCount: flow.closed?.closedCount || 0,
        message: flow.launch
          ? "Codex 已启动并应用壁纸；媒体服务将在托盘中保持运行"
          : "壁纸已重新应用到正在调试的 Codex",
      };
    } catch (error) {
      try {
        const diagnosticPath = await writeCompatibilityDiagnostic({
          port,
          installationId,
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
  }));
  registerHandler("cwb:restore", ({ installationId, port } = {}) => runOperation("恢复官方外观", async () => {
    stopCodexTakeover();
    await rememberOperationSettings({ port });
    const normalizedPort = validateCdpPort(port);
    const installation = await resolveInstallation(installationId || settings.selectedId);
    await verifySelectedOwner(installation, normalizedPort);
    assertNotQuitting();
    const control = await ensureControlPanel(normalizedPort);
    return invokeBridgeAction({ controlUrl: control.url, action: "restore" });
  }));
  registerHandler("cwb:open-control-panel", ({ port } = {}) => runOperation("载入壁纸面板", async () => {
    await rememberOperationSettings({ port });
    return ensureControlPanel(port);
  }));
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(async () => {
    app.setAppUserModelId("com.local.codex-wallpaper-desktop");
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
  stopCodexTakeover();
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = previewSession.shutdown()
    .then(() => nativeEngineHost?.close())
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
