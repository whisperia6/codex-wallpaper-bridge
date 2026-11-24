#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpWallpaperInjector, restoreCdpWallpaper } from "./cdp-injector.mjs";
import { createConfigStore } from "./config-store.mjs";
import { buildCurrentInjection } from "./injection-plan.mjs";
import { createMediaServer } from "./media-server.mjs";
import { openNativeEngineProvider } from "./native-engine-provider.mjs";
import { scanWallpaperProjects } from "./scanner.mjs";
import { eligibleProjects } from "../../bridge-runtime/src/library-policy.mjs";
import { buildCompatibilityRestoreScript, buildCompatibilityScript } from "../../src/compatibility-script.mjs";
import { sceneAssetCache } from "../../bridge-runtime/src/scene-asset-cache.mjs";
import { validateWebWallpaperInput } from "../../bridge-runtime/src/web-wallpaper-input.mjs";
import { MediaMiddleware } from "../../bridge-runtime/src/media-middleware.mjs";
import { LyricsStore } from "../../bridge-runtime/src/media-lyrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const publicDir = path.join(projectRoot, "public");
const stateRoot = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexWallpaperBridge")
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "codex-wallpaper-bridge");
const runtimePath = path.join(stateRoot, "runtime.json");

function parseArguments(argv) {
  const args = [...argv];
  const firstArgument = args.shift();
  const command = firstArgument && !firstArgument.startsWith("-") ? firstArgument : "preview";
  if (firstArgument?.startsWith("-")) args.unshift(firstArgument);
  const options = { command, cdpPort: 9335, open: true, once: false, keepOnExit: false };
  while (args.length) {
    const argument = args.shift();
    if (argument === "--no-open") options.open = false;
    else if (argument === "--once") options.once = true;
    else if (argument === "--keep-on-exit") options.keepOnExit = true;
    else if (argument === "--cdp-port") options.cdpPort = Number(args.shift());
    else if (argument === "--steam-root") (options.steamRoots ||= []).push(args.shift());
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1024 || options.cdpPort > 65535) {
    throw new Error("--cdp-port 必须在 1024 到 65535 之间");
  }
  if ((options.once || options.keepOnExit) && command !== "inject") {
    throw new Error("--once 和 --keep-on-exit 只能与 inject 命令一起使用");
  }
  if (options.once || options.keepOnExit) {
    throw new Error("1 秒流式架构需要媒体服务常驻；请移除 --once/--keep-on-exit，并将桌面程序最小化到托盘");
  }
  return options;
}

function printHelp() {
  console.log(`Codex Wallpaper Bridge

用法：
  node src/cli.mjs preview [--no-open]
  node src/cli.mjs inject [--cdp-port 9335] [--no-open]
  node src/cli.mjs restore [--cdp-port 9335]
  node src/cli.mjs scan [--steam-root D:\\steam]

说明：
  1 秒流式架构通过本机 HTTP Range 提供媒体，播放期间需保持桥接或桌面托盘进程运行。
`);
}

function openExternal(url) {
  if (process.platform === "win32") {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function chooseDefault(configStore, projects) {
  let config = await configStore.get();
  projects = eligibleProjects(projects, config);
  if (projects.some((project) => project.id === config.selectedId)) return config;
  const preferred = projects.find((project) => project.type === "video" && project.playable)
    || projects.find((project) => project.type === "web" && project.playable)
    || projects.find((project) => project.previewPath)
    || projects[0];
  if (config.selectedId !== (preferred?.id ?? null)) config = await configStore.set({ selectedId: preferred?.id ?? null });
  return config;
}

async function writeRuntime(server, options, scanResult, injectorActive) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(runtimePath, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    command: options.command,
    cdpPort: options.cdpPort,
    bridgeOrigin: server?.origin || null,
    projectRoot,
    injectorActive,
    nativeEngineProviderConfigured: options.nativeEngineProviderConfigured === true,
    nativeSceneSelectionIntegrated: options.nativeEngineProviderConfigured === true,
    sceneRenderer: options.sceneRenderer || "preview-only",
    wallpaperCount: scanResult?.projects?.length || 0,
    startedAt: new Date().toISOString()
  }, null, 2), "utf8");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  if (options.command === "restore") {
    await restoreCdpWallpaper({
      port: options.cdpPort,
      compatibilityRestoreScript: buildCompatibilityRestoreScript(),
      onStatus: (status) => console.log(`[CDP] ${status.type}${status.message ? `: ${status.message}` : ""}`)
    });
    await rm(runtimePath, { force: true }).catch(() => {});
    console.log("已清除 Codex renderer 中的 Wallpaper Bridge 样式。");
    return;
  }

  console.log("正在扫描 Wallpaper Engine 本地项目...");
  let scanResult = await scanWallpaperProjects({
    explicitRoots: options.steamRoots,
    steamRoots: options.steamRoots
  });
  if (options.command === "scan") {
    const byType = Object.groupBy
      ? Object.groupBy(scanResult.projects, (project) => project.type)
      : scanResult.projects.reduce((result, project) => {
        (result[project.type] ||= []).push(project);
        return result;
      }, {});
    console.log(JSON.stringify({
      total: scanResult.projects.length,
      byType: Object.fromEntries(Object.entries(byType).map(([key, value]) => [key, value.length])),
      libraries: scanResult.libraryRoots,
      warnings: scanResult.warnings
    }, null, 2));
    return;
  }

  const configStore = createConfigStore();
  await configStore.load();
  const nativeProvider = options.command === "preview" ? openNativeEngineProvider() : null;
  options.nativeEngineProviderConfigured = Boolean(nativeProvider);
  const sceneRenderer = process.env.CWB_SCENE_RENDERER || "gpu";
  if (!["gpu", "vp8"].includes(sceneRenderer)) throw new Error("CWB_SCENE_RENDERER 只能为 gpu 或 vp8");
  const directSceneEnabled = Boolean(nativeProvider) && sceneRenderer === "gpu";
  options.sceneRenderer = nativeProvider ? (directSceneEnabled ? "direct-gpu" : "vp8") : "preview-only";

  let injector = null;
  let server;
  let compatibility = null;
  let stopping = false;
  let operationQueue = Promise.resolve();
  const enqueueOperation = (task) => {
    if (stopping) return Promise.reject(new Error("壁纸服务正在停止"));
    const operation = operationQueue.then(() => {
      if (stopping) throw new Error("壁纸服务正在停止");
      return task();
    });
    operationQueue = operation.catch(() => {});
    return operation;
  };
  const currentInjection = async () => ({
    ...await buildCurrentInjection(server, configStore, { nativeEnabled: Boolean(nativeProvider), directSceneEnabled }),
    ...compatibility,
  });
  const media = new MediaMiddleware({ getConfig: () => configStore.get(),
    lyrics: new LyricsStore({ root: path.join(path.dirname(configStore.filePath), "media-lyrics") }),
    onPower: power => injector?.updatePower(power),
    dispatch: (id, input) => !stopping && injector?.running && directSceneEnabled
      ? injector.sceneDelivery?.input(id, input) : null });

  const refreshInjection = async ({ scan = false, allowDetached = false } = {}) => {
    // Saving is a disk/renderer transaction, not an OS capture readiness gate.
    // The middleware owns this queued startup and close waits for it separately.
    void media.configure().catch(() => console.error("系统媒体初始化未完成；可在媒体状态中查看"));
    if (!injector) return { ok: true, status: "preview-only" };
    const injection = await currentInjection();
    const result = scan ? await injector.update(injection, { scan: true }) : await injector.update(injection);
    if (result.failed > 0 || (!allowDetached && result.sessions === 0 && !(result.deferred > 0))) {
      throw new Error("一个或多个 Codex renderer 未能完成注入验证");
    }
    return {
      ok: true,
      status: result.sessions > 0 ? `updated:${result.sessions}` : result.deferred > 0 ? `deferred:${result.deferred}` : "detached",
      deferred: result.deferred || 0,
      metrics: injection.metrics,
      timings: result.timings || []
    };
  };

  const ensureInjector = async () => {
    if (!injector || injector.running === false) {
      injector ||= new CdpWallpaperInjector({
        port: options.cdpPort,
        installOnNewDocument: !options.once,
        nativeProvider,
        sceneProvider: directSceneEnabled ? {
          onMediaControl: (id, value) => media.control({ ...value, projectId: id }),
          authorFiles: server.authorFiles,
          diagnosticProbe: Boolean(process.env.CWB_ACCEPTANCE_ROOT) && process.env.CWB_M2_GPU_DIAGNOSTICS === "1",
          getConfig: () => configStore.get(),
          getProject: async (id) => {
            const matches = eligibleProjects(await server.projects(), configStore.get()).filter((project) => project.id === id);
            return matches.length === 1 ? matches[0] : null;
          }
        } : null,
        onStatus: (status) => {
          const suffix = status.message ? `：${status.message}` : "";
          console.log(`[CDP] ${status.type}${suffix}`);
        }
      });
      try {
        const injection = await currentInjection();
        const result = await injector.start(injection);
        await injector.updatePower((await media.snapshot()).power);
        if (result.failed > 0) throw new Error("一个或多个 Codex renderer 未能完成注入验证");
        if (result.sessions === 0 && !(result.deferred > 0)) {
          throw new Error(`没有在 127.0.0.1:${options.cdpPort} 找到 Codex renderer；可先使用预览页`);
        }
        return { injector, started: true, deferred: result.deferred || 0, metrics: injection.metrics, timings: result.timings };
      } catch (error) {
        let cleanupFailed = false;
        await injector.close({ restore: true }).catch((cleanupError) => {
          cleanupFailed = true;
          console.error(`清理失败：${cleanupError.message}`);
        });
        if (!cleanupFailed) injector = null;
        throw error;
      }
    }
    return { injector, started: false, metrics: null };
  };

  try {
  server = createMediaServer({
    projects: scanResult.projects,
    publicDir,
    configStore,
    media,
    onAuthorProperties: ({ operation, project, values }) => {
      const delivery = directSceneEnabled && ["scene", "web"].includes(project.type) ? injector?.sceneDelivery : injector?.nativeDelivery;
      return delivery ? delivery.properties(project.id, operation === "apply" ? values : null)
        : { phase: "unavailable", method: "none", values: {} };
    },
    onConfigChange: () => enqueueOperation(() => refreshInjection({ allowDetached: true })),
    // Speculation does not join the apply queue or install/reload any renderer.
    onScenePreload: directSceneEnabled ? (id) => stopping || !injector?.running
      ? { ok: true, status: "skipped", targets: 0 } : injector.preloadScene(id) : null,
    onAction: (action, body = {}) => enqueueOperation(async () => {
      if (action === "inject") {
        if (Object.hasOwn(body, "adaptive")) {
          if (typeof body.adaptive !== "boolean") throw new Error("兼容模式必须是布尔值");
          compatibility = {
            compatibilityScript: buildCompatibilityScript({ adaptive: body.adaptive }),
            compatibilityRestoreScript: buildCompatibilityRestoreScript(),
          };
        }
        const startedAt = performance.now();
        const state = await ensureInjector();
        const update = state.started
          ? { ok: true, metrics: state.metrics, timings: state.timings }
          : await refreshInjection({ scan: true });
        if (!update.ok) throw new Error("一个或多个 Codex renderer 未能完成注入验证");
        await writeRuntime(server, options, scanResult, true);
        const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
        const deferredTargets = update.deferred || state.deferred || 0;
        const degradedTargets = update.timings.filter(timing => timing.degraded === true).length;
        return {
          ok: true,
          message: `${degradedTargets ? `引擎失败，${degradedTargets} 个页面使用降级背景（需显式重试）` : "Runtime 与背景 DOM 已注入"}：${elapsedMs} ms；Scene 路径：${options.sceneRenderer}${deferredTargets ? `；${deferredTargets} 个隐藏页面等待显示后自动应用` : ""}`,
          deferredTargets,
          sceneRenderer: options.sceneRenderer,
          status: degradedTargets ? "engine-degraded" : `injected:${elapsedMs}`,
          compatibility: update.timings.map(({ targetId, compatibility: value }) => ({ targetId, value }))
        };
      }
      if (action === "restore") {
        compatibility = null;
        if (injector) {
          const activeInjector = injector;
          activeInjector.compatibilityRestoreScript ||= buildCompatibilityRestoreScript();
          await activeInjector.close({ restore: true });
          injector = null;
        } else {
          await restoreCdpWallpaper({
            port: options.cdpPort,
            compatibilityRestoreScript: buildCompatibilityRestoreScript(),
          });
        }
        await writeRuntime(server, options, scanResult, false);
        return { ok: true, message: "已恢复官方外观", status: "restored" };
      }
      if (action === "rescan") {
        await injector?.preloadScene(null);
        sceneAssetCache.clear();
        scanResult = await scanWallpaperProjects({ explicitRoots: options.steamRoots, steamRoots: options.steamRoots });
        server.setProjects(scanResult.projects);
        await chooseDefault(configStore, await server.projects());
        await refreshInjection();
        await writeRuntime(server, options, scanResult, Boolean(injector));
        return { ok: true, message: `已发现 ${scanResult.projects.length} 个项目`, status: "rescanned" };
      }
      if (action === "play" || action === "pause") {
        await configStore.set({ effects: { playing: action === "play" } });
        await refreshInjection();
        return { ok: true, status: action };
      }
      if (action === "engine-status") return { ok: true, sceneRenderer: options.sceneRenderer,
        engine: [...(injector?.sceneDelivery?.diagnostics() || []), ...(injector?.nativeDelivery?.diagnostics() || []).map((entry) => ({ ...entry, renderer: "vp8" }))] };
      if (action === "web-input") {
        const selectedId = configStore.get().selectedId;
        if (!directSceneEnabled || !injector?.running || !injector.sceneDelivery || body.projectId !== selectedId
          || Object.keys(body).some(key => !["action", "projectId", "input"].includes(key))) throw Error("web_input_unavailable");
        const selected = (await server.projects()).find(project => project.id === selectedId);
        if (selected?.type !== "web" || selected.eligible === false || selected.hidden) throw Error("web_input_unavailable");
        return injector.sceneDelivery.input(selectedId, validateWebWallpaperInput(body.input));
      }
      if (action === "retry-engine") {
        const selectedId = configStore.get().selectedId;
        if (!selectedId || (body.projectId !== undefined && body.projectId !== selectedId) || !injector?.nativeDelivery) throw new Error("当前场景无法重试");
        const selected = (await server.projects()).find((project) => project.id === selectedId);
        if (directSceneEnabled && ["scene", "web"].includes(selected?.type)) await injector.retryScene(selectedId);
        else await injector.retryNative(selectedId);
        const update = await refreshInjection();
        if (!update.ok) throw new Error("场景重试未完成，保留现有画面");
        return { ok: true, status: "engine-retried", message: "场景已显式重试" };
      }
      return { ok: false, message: `不支持的操作：${action}`, status: "unsupported" };
    })
  });
  await server.start();
  await chooseDefault(configStore, await server.projects());
  await media.configure();

  console.log(`扫描完成：${scanResult.projects.length} 个项目`);
  console.log(`控制与预览：${server.baseUrl}`);
  if (scanResult.warnings.length) console.log(`扫描警告：${scanResult.warnings.length} 条（不会阻止可用项目）`);

  await enqueueOperation(async () => {
    if (options.command === "inject") await ensureInjector();
    await writeRuntime(server, options, scanResult, Boolean(injector));
  });
  if (options.open) openExternal(server.baseUrl);

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在清理...`);
    await operationQueue;
    const activeInjector = injector;
    injector = null;
    const errors = [];
    for (const cleanup of [
      () => media.close(),
      () => activeInjector?.close({ restore: true, allowEndpointUnavailable: true }),
      () => server.close(),
      () => nativeProvider?.close(),
      () => rm(runtimePath, { force: true }),
    ]) {
      try { await cleanup(); }
      catch (error) { errors.push(error.message); }
    }
    if (errors.length) console.error(`清理未完成：${errors.join("；")}`);
    sceneAssetCache.clear();
    process.exit(errors.length ? 1 : 0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  await new Promise(() => {});
  } catch (error) {
    for (const cleanup of [() => media.close(), () => injector?.close({ restore: true }), () => server?.close(), () => nativeProvider?.close()]) {
      try { await cleanup(); } catch { console.error("启动失败后的自有资源清理未完成"); }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  if (process.env.CWB_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
