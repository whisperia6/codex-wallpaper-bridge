import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  invokeBridgeAction,
  resolveBridgeRoot,
  resolveBridgeUtilityPath,
  startBridgePreview,
} from "./bridge-runner.mjs";
import {
  collectCdpDiagnostics,
  evaluateInCodexTargets,
  isCdpEndpointReady,
  waitForCodexTarget,
} from "./cdp-client.mjs";
import { closeCodexProcesses, launchCodex } from "./codex-launcher.mjs";
import { buildCompatibilityRestoreScript, buildCompatibilityScript } from "./compatibility-script.mjs";
import { detectInstallations, validateCdpPort, validateExecutable } from "./installations.mjs";
import { runLaunchAndInjectFlow } from "./launch-flow.mjs";
import { createTrayController } from "./tray-controller.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(here, "renderer", "index.html");
const preloadPath = path.join(here, "preload.cjs");
const rendererUrl = pathToFileURL(rendererPath).href;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow = null;
let previewProcess = null;
let previewUrl = null;
let previewPort = null;
let trayController = null;
let isQuitting = false;
let hasShownTrayNotice = false;
let settings = {
  manualExecutables: [],
  selectedId: null,
  port: 9335,
  adaptive: true,
};
let activeOperation = null;
let settingsPath = null;
let diagnosticsRoot = null;
let bridgeRoot = null;

function forkBridgeUtility(modulePath, args, { cwd }) {
  const utilityPath = resolveBridgeUtilityPath({
    isPackaged: app.isPackaged,
    compiledRoot: here,
    resourcesPath: process.resourcesPath,
  });
  return utilityProcess.fork(utilityPath, args, {
    cwd,
    env: {
      ...process.env,
      CWB_BRIDGE_CLI: modulePath,
    },
    stdio: "pipe",
    serviceName: "Codex Wallpaper Bridge",
  });
}

function log(entry) {
  const normalized = {
    stream: entry?.stream || "system",
    text: String(entry?.text || ""),
    at: new Date().toISOString(),
  };
  if (!normalized.text) return;
  mainWindow?.webContents.send("cwb:log", normalized);
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
  if (settings.selectedId && !installations.some(({ id }) => id === settings.selectedId)) {
    settings.selectedId = installations[0]?.id || null;
  } else if (!settings.selectedId && installations[0]) {
    settings.selectedId = installations[0].id;
  }
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
    return handler(payload);
  });
}

async function runOperation(name, task) {
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

async function resolveInstallation(installationId) {
  const state = await currentState();
  const installation = state.installations.find(({ id }) => id === installationId);
  if (!installation) throw new Error("请选择有效的 Codex 安装");
  settings.selectedId = installation.id;
  await saveSettings();
  return installation;
}

async function injectOnceAtPort({ port, adaptive }) {
  const startedAt = performance.now();
  const control = await ensureControlPanel(port);
  const injection = await invokeBridgeAction({ controlUrl: control.url, action: "inject" });
  const compatibility = await evaluateInCodexTargets(
    port,
    buildCompatibilityScript({ adaptive: Boolean(adaptive) }),
  );
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  return {
    compatibility,
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

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#0b0d0b",
    title: "Codex Wallpaper Desktop",
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
  window.loadFile(rendererPath);
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

async function closePreview() {
  if (previewProcess && !previewProcess.killed) previewProcess.kill();
  previewProcess = null;
  previewUrl = null;
  previewPort = null;
}

function assertTrustedControlUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("壁纸控制页必须来自本机 127.0.0.1");
  }
  return parsed.href;
}

async function ensureControlPanel(port) {
  const normalizedPort = validateCdpPort(port);
  if (previewProcess && !previewProcess.killed && previewUrl && previewPort === normalizedPort) {
    return { url: previewUrl, reused: true };
  }
  await closePreview();

  const preview = await startBridgePreview({
    executablePath: process.execPath,
    bridgeRoot,
    port: normalizedPort,
    onLog: log,
    processFactory: forkBridgeUtility,
  });
  previewProcess = preview.child;
  previewUrl = assertTrustedControlUrl(preview.url);
  previewPort = normalizedPort;
  const activeProcess = previewProcess;
  activeProcess.once("exit", () => {
    if (previewProcess !== activeProcess) return;
    previewProcess = null;
    previewUrl = null;
    previewPort = null;
    mainWindow?.webContents.send("cwb:tray-action", "control-disconnected");
  });
  return { url: previewUrl, reused: false };
}

function createApplicationTray() {
  trayController = createTrayController({
    TrayCtor: Tray,
    MenuApi: Menu,
    nativeImageApi: nativeImage,
    actions: {
      showWindow: showMainWindow,
      openControl: () => sendTrayAction("control"),
      launch: () => sendTrayAction("launch"),
      inject: () => sendTrayAction("inject"),
      restore: () => sendTrayAction("restore"),
      quit: () => {
        isQuitting = true;
        app.quit();
      },
    },
    onError: (error) => log({ stream: "stderr", text: `托盘操作失败：${error.message}\n` }),
  });
}

function registerIpcHandlers() {
  registerHandler("cwb:get-state", () => currentState());
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
  registerHandler("cwb:launch-codex", ({ installationId, port, adaptive = true } = {}) => runOperation("启动并自动注入", async () => {
    await rememberOperationSettings({ port, adaptive });
    const installation = await resolveInstallation(installationId);
    const normalizedPort = validateCdpPort(port);
    const flow = await runLaunchAndInjectFlow({
      installation,
      port: normalizedPort,
      adaptive: Boolean(adaptive),
      isEndpointReady: isCdpEndpointReady,
      confirmClose: confirmCloseRunningCodex,
      closeCodex: (selected) => closeCodexProcesses({
        installation: selected,
        onLog: log,
      }),
      launchCodex: ({ installation: selected, port: selectedPort }) => launchCodex({
        installation: selected,
        port: selectedPort,
        profileRoot: path.join(app.getPath("userData"), "codex-profiles"),
        onLog: log,
      }),
      waitForTarget: waitForCodexTarget,
      injectOnce: injectOnceAtPort,
    });
    if (flow.canceled) return flow;
    return {
      result: flow.launch,
      compatibility: flow.injection.compatibility,
      adaptive: flow.injection.adaptive,
      closedCount: flow.closed?.closedCount || 0,
      message: "Codex 已启动并完成快速流式注入；媒体服务将在托盘中保持运行",
    };
  }));
  registerHandler("cwb:inject-once", ({ port, adaptive = true } = {}) => runOperation("快速流式注入", async () => {
    await rememberOperationSettings({ port, adaptive });
    const normalizedPort = validateCdpPort(port);
    return injectOnceAtPort({ port: normalizedPort, adaptive: Boolean(adaptive) });
  }));
  registerHandler("cwb:restore", ({ port } = {}) => runOperation("恢复官方外观", async () => {
    await rememberOperationSettings({ port });
    const normalizedPort = validateCdpPort(port);
    const warnings = [];
    let compatibility = [];
    try {
      compatibility = await evaluateInCodexTargets(normalizedPort, buildCompatibilityRestoreScript());
    } catch (error) {
      warnings.push(`兼容层：${error.message}`);
    }
    try {
      const control = await ensureControlPanel(normalizedPort);
      await invokeBridgeAction({ controlUrl: control.url, action: "restore" });
    } catch (error) {
      warnings.push(`壁纸层：${error.message}`);
    }
    if (warnings.length === 2) throw new Error(warnings.join("；"));
    return { compatibility, warnings };
  }));
  registerHandler("cwb:export-diagnostics", ({ port, installationId } = {}) => runOperation("导出兼容诊断", async () => {
    const normalizedPort = validateCdpPort(port);
    const diagnostics = await collectCdpDiagnostics(normalizedPort);
    const state = await currentState();
    const installation = state.installations.find(({ id }) => id === installationId) || null;
    const installationSummary = installation ? {
      id: installation.id,
      kind: installation.kind,
      label: installation.label,
      version: installation.version,
      executableName: path.basename(installation.path),
    } : null;
    const report = {
      schemaVersion: 1,
      note: "报告不采集对话正文，仅包含版本、DOM 语义命中和表面样式摘要。",
      installation: installationSummary,
      ...diagnostics,
    };
    await mkdir(diagnosticsRoot, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const diagnosticPath = path.join(diagnosticsRoot, `codex-compat-${timestamp}.json`);
    await writeFile(diagnosticPath, JSON.stringify(report, null, 2), "utf8");
    return { diagnosticPath, targetCount: diagnostics.targets.length };
  }));
  registerHandler("cwb:open-control-panel", ({ port } = {}) => runOperation("载入壁纸面板", async () => {
    await rememberOperationSettings({ port });
    return ensureControlPanel(port);
  }));
  registerHandler("cwb:reveal-diagnostics", async (diagnosticPath) => {
    const resolvedPath = path.resolve(String(diagnosticPath || ""));
    const relativePath = path.relative(diagnosticsRoot, resolvedPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("只能打开本桌面版生成的诊断文件");
    }
    shell.showItemInFolder(resolvedPath);
    return { ok: true };
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(async () => {
    app.setAppUserModelId("com.local.codex-wallpaper-desktop");
    settingsPath = path.join(app.getPath("userData"), "settings.json");
    diagnosticsRoot = path.join(app.getPath("userData"), "diagnostics");
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

app.on("before-quit", () => {
  isQuitting = true;
  void closePreview();
});

app.on("will-quit", () => {
  trayController?.destroy();
  trayController = null;
});
