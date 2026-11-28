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
import { NativeEngineDelivery } from "../../bridge-runtime/src/native-engine-delivery.mjs";
import { scanWallpaperProjects } from "./scanner.mjs";
import { eligibleProjects } from "../../bridge-runtime/src/library-policy.mjs";
import { buildCompatibilityRestoreScript, buildCompatibilityScript } from "../../src/compatibility-script.mjs";
import { sceneAssetCache } from "../../bridge-runtime/src/scene-asset-cache.mjs";
import { validateWebWallpaperInput } from "../../bridge-runtime/src/web-wallpaper-input.mjs";
import { MediaMiddleware } from "../../bridge-runtime/src/media-middleware.mjs";
import { LyricsStore } from "../../bridge-runtime/src/media-lyrics.mjs";
import { defaultCdpPort, hostDisplayName, hostPortConflict, normalizeHostType } from "../../bridge-runtime/src/host-profiles.mjs";
import { validateCdpPort } from "../../src/installations.mjs";
import { queryWindowOcclusion } from "../../src/win-helper.mjs";

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
  const options = { command, hostType: "codex", open: true, once: false, keepOnExit: false };
  while (args.length) {
    const argument = args.shift();
    if (argument === "--no-open") options.open = false;
    else if (argument === "--once") options.once = true;
    else if (argument === "--keep-on-exit") options.keepOnExit = true;
    else if (argument === "--cdp-port") options.cdpPort = Number(args.shift());
    else if (argument === "--host-type") options.hostType = normalizeHostType(args.shift(), { strict: true });
    else if (argument === "--steam-root") (options.steamRoots ||= []).push(args.shift());
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  options.cdpPort ??= defaultCdpPort(options.hostType);
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
  console.log(`Lumina

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

async function writeRuntime(server, options, scanResult, { activeHosts, injectorActive }) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(runtimePath, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    command: options.command,
    cdpPort: activeHosts.length === 1 ? activeHosts[0].port : options.cdpPort,
    bridgeOrigin: server?.origin || null,
    projectRoot,
    injectorActive,
    activeHosts,
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
      hostType: options.hostType,
      compatibilityRestoreScript: buildCompatibilityRestoreScript(),
      onStatus: (status) => console.log(`[CDP] ${status.type}${status.message ? `: ${status.message}` : ""}`)
    });
    await rm(runtimePath, { force: true }).catch(() => {});
    console.log(`已清除 ${hostDisplayName(options.hostType)} renderer 中的 Wallpaper Bridge 样式。`);
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
  let stopping = false;
  const occlusion = nativeProvider && process.platform === "win32" && process.env.CWB_WINDOW_OCCLUSION === "1"
    ? { query: queryWindowOcclusion, isEnabled: () => !stopping && configStore.get().effects.pauseWhenOccluded }
    : null;
  options.sceneRenderer = nativeProvider ? (directSceneEnabled ? "direct-gpu" : "vp8") : "preview-only";

  const injectors = new Map();
  let server;
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
  const activeInjectors = () => [...injectors.values()].filter(({ injector }) => injector.running);
  // VP8 consumers share the provider's two source slots across both hosts.
  const sharedNativeDelivery = nativeProvider && !directSceneEnabled ? new NativeEngineDelivery({
    provider: nativeProvider,
    onFailure: (failure) => console.log(`[CDP] native-frame-error：${JSON.stringify(failure)}`),
    onReceiverLost: (session) => {
      const owner = activeInjectors().find(({ injector }) => injector.sessions.get(session.target.id) === session);
      owner?.injector.onNativeReceiverLost(session);
    },
  }) : null;
  const runtimeState = () => {
    const activeHosts = activeInjectors().map(({ hostType, port }) => ({ hostType, port }));
    return { activeHosts, injectorActive: activeHosts.length > 0 };
  };
  const registeredHosts = () => [...injectors.values()].map(({ hostType, port }) => ({ hostType, port }));
  const saveRuntime = () => writeRuntime(server, options, scanResult, runtimeState());
  const runInjectorAction = async (task) => {
    try {
      const result = await task();
      await saveRuntime();
      return result;
    } catch (error) {
      error.registeredHosts = registeredHosts();
      await saveRuntime().catch(() => console.error("桥接运行状态保存失败"));
      throw error;
    }
  };
  const assertPortAvailable = (hostType, port) => {
    const owner = [...injectors.values()].find((entry) => entry.port === port && entry.hostType !== hostType);
    if (owner) throw hostPortConflict(port, owner.hostType);
  };
  const verifyActionEndpoint = async (port, hostType) => {
    if (nativeProvider?.verifyEndpoint && (await nativeProvider.verifyEndpoint(port, hostType))?.verified !== true) {
      throw new Error("目标应用的 CDP 端口未通过身份核验");
    }
  };
  const closeInjector = async ({ hostType, injector }, allowEndpointUnavailable = false) => {
    injector.compatibilityRestoreScript ||= buildCompatibilityRestoreScript();
    try {
      await injector.close({ restore: true, ...(allowEndpointUnavailable ? { allowEndpointUnavailable } : {}) });
    } catch (error) {
      if (error.code === "CDP_RESTORATION_OWNER_UNVERIFIED") injectors.delete(hostType);
      throw error;
    }
    injectors.delete(hostType);
  };
  const settleAll = (entries, operation) => Promise.allSettled(entries.map(async (entry) => operation(entry)));
  const closeInjectors = async (allowEndpointUnavailable = false) => {
    const results = await settleAll([...injectors.values()], (entry) => closeInjector(entry, allowEndpointUnavailable));
    const errors = results.filter(({ status }) => status === "rejected");
    if (errors.length) throw new Error(errors.map(({ reason }) => reason.message).join("；"));
  };
  const currentInjection = async ({ hostType, compatibility }) => ({
    ...await buildCurrentInjection(server, configStore, {
      nativeEnabled: Boolean(nativeProvider),
      directSceneEnabled,
      hostType,
    }),
    ...compatibility,
  });
  const media = new MediaMiddleware({ getConfig: () => configStore.get(),
    lyrics: new LyricsStore({ root: path.join(path.dirname(configStore.filePath), "media-lyrics") }),
    onPower: (power) => settleAll(activeInjectors(), ({ injector }) => injector.updatePower(power)),
    getOccluded: () => {
      if (!occlusion) return false;
      const connected = activeInjectors().filter(({ injector }) => injector.occlusionSessions().length);
      return connected.length > 0 && connected.every(({ injector }) => injector.occluded);
    },
    dispatch: (id, input) => !stopping && directSceneEnabled ? dispatchInput(id, input) : null });

  async function dispatchInput(id, input) {
    const results = await settleAll(activeInjectors(), ({ injector }) => injector.sceneDelivery?.input(id, input));
    const delivered = results.reduce((total, { value }) => total + (value?.delivered || 0), 0);
    const status = delivered ? "dispatched" : results.some(({ value }) => value?.status === "unchanged") ? "unchanged" : "unavailable";
    return { ok: true, status, delivered };
  }

  const refreshInjection = async ({ entries = activeInjectors(), scan = false, allowDetached = false, allowPartial = false, onDegraded } = {}) => {
    // Saving is a disk/renderer transaction, not an OS capture readiness gate.
    // The middleware owns this queued startup and close waits for it separately.
    void media.configure().catch(() => console.error("系统媒体初始化未完成；可在媒体状态中查看"));
    const results = await settleAll(entries, async (entry) => {
      const injection = await currentInjection(entry);
      const result = scan ? await entry.injector.update(injection, { scan: true }) : await entry.injector.update(injection);
      if (result.failed > 0 || (!allowDetached && result.sessions === 0 && !(result.deferred > 0))) {
        throw new Error(`一个或多个 ${hostDisplayName(entry.hostType)} renderer 未能完成注入验证`);
      }
      return {
        ok: true,
        applied: result.sessions,
        status: result.sessions > 0 ? `updated:${result.sessions}` : result.deferred > 0 ? `deferred:${result.deferred}` : "detached",
        deferred: result.deferred || 0,
        metrics: injection.metrics,
        timings: result.timings || [],
      };
    });
    const applied = [];
    const deferred = [];
    const detached = [];
    const failed = [];
    for (const [index, result] of results.entries()) {
      const { hostType } = entries[index];
      if (result.status === "rejected") {
        failed.push({ error: result.reason, hostType });
        continue;
      }
      if (onDegraded && result.value.timings.some(({ degraded }) => degraded === true)) onDegraded(hostType);
      if (result.value.applied > 0) applied.push(result.value);
      else if (result.value.deferred > 0) deferred.push(result.value);
      else detached.push(result.value);
    }
    if (failed.length && (!allowPartial || !applied.length)) throw failed[0].error;
    for (const { error, hostType } of failed) console.error(`未能同步到 ${hostDisplayName(hostType)}：${error.message}`);
    return applied[0] || deferred[0] || detached[0] || { ok: true, status: "preview-only" };
  };

  const ensureInjector = async ({ hostType, port, adaptive }) => {
    let entry = injectors.get(hostType);
    if (entry && entry.port !== port) {
      await closeInjector(entry, true);
      entry = null;
    }
    if (!entry) {
      const injector = new CdpWallpaperInjector({
        port,
        hostType,
        installOnNewDocument: !options.once,
        nativeProvider,
        sharedNativeDelivery,
        occlusion,
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
          const detail = status.type === "attach-error" ? status.detail : null;
          const diagnostic = detail ? ` (mediaState=${detail.mediaState}, switchFailure=${detail.switchFailure}, disposed=${detail.disposed}, domReady=${detail.domReady})` : "";
          console.log(`[CDP] ${status.type}${suffix}${diagnostic}`);
        }
      });
      entry = { hostType, port, injector, compatibility: null };
      injectors.set(hostType, entry);
    }
    if (adaptive !== undefined) {
      entry.compatibility = {
        compatibilityScript: buildCompatibilityScript({ adaptive, hostType }),
        compatibilityRestoreScript: buildCompatibilityRestoreScript(),
      };
    }
    const { injector } = entry;
    if (injector.running) return refreshInjection({ entries: [entry], scan: true });
    try {
      const injection = await currentInjection(entry);
      const result = await injector.start(injection);
      await injector.updatePower((await media.snapshot()).power);
      if (result.failed > 0) throw new Error(`一个或多个 ${hostDisplayName(hostType)} renderer 未能完成注入验证`);
      if (result.sessions === 0 && !(result.deferred > 0)) {
        throw new Error(`没有在 127.0.0.1:${port} 找到 ${hostDisplayName(hostType)} renderer；可先使用预览页`);
      }
      return { deferred: result.deferred || 0, timings: result.timings || [] };
    } catch (error) {
      await closeInjector(entry).catch((cleanupError) => {
        console.error(`清理失败：${cleanupError.message}`);
      });
      throw error;
    }
  };

  try {
  server = createMediaServer({
    projects: scanResult.projects,
    publicDir,
    configStore,
    media,
    onAuthorProperties: async ({ operation, project, values }) => {
      if (sharedNativeDelivery) return sharedNativeDelivery.properties(project.id, operation === "apply" ? values : null);
      const results = await settleAll(activeInjectors(), ({ injector }) => {
        const delivery = directSceneEnabled && ["scene", "web"].includes(project.type) ? injector.sceneDelivery : injector.nativeDelivery;
        return delivery?.properties(project.id, operation === "apply" ? values : null);
      });
      const unavailable = { phase: "unavailable", method: "none", values: {} };
      if (results.some(({ status }) => status === "rejected")) return { ...unavailable, phase: "failed" };
      const reports = results.flatMap(({ value }) => value ? [value] : []);
      const problem = reports.find(({ phase }) => phase !== "ready");
      if (problem) return problem;
      const first = reports[0];
      return first && reports.every(({ values }) => JSON.stringify(values) === JSON.stringify(first.values)) ? first : unavailable;
    },
    onConfigChange: () => {
      if (occlusion) for (const { injector } of activeInjectors()) injector.refreshOcclusion();
      return enqueueOperation(() => refreshInjection({ allowDetached: true, allowPartial: true }));
    },
    // Speculation does not join the apply queue or install/reload any renderer.
    onScenePreload: directSceneEnabled ? async (id) => {
      const results = stopping ? [] : await settleAll(activeInjectors(), ({ injector }) => injector.preloadScene(id));
      const targets = results.reduce((total, { value }) => total + (value?.targets || 0), 0);
      const status = targets ? "preparing" : results.some(({ value }) => value?.status === "busy") ? "busy" : "skipped";
      return { ok: true, status, targets };
    } : null,
    onAction: (action, body = {}) => enqueueOperation(async () => {
      if (action === "inject") {
        const hostType = normalizeHostType(body.hostType, { strict: true, fallback: options.hostType });
        const port = validateCdpPort(Object.hasOwn(body, "port") ? body.port
          : Object.hasOwn(body, "hostType") ? injectors.get(hostType)?.port ?? defaultCdpPort(hostType) : options.cdpPort);
        if (body.adaptive !== undefined && typeof body.adaptive !== "boolean") throw new Error("兼容模式必须是布尔值");
        const startedAt = performance.now();
        const update = await runInjectorAction(async () => {
          assertPortAvailable(hostType, port);
          await verifyActionEndpoint(port, hostType);
          return ensureInjector({ hostType, port, adaptive: body.adaptive });
        });
        const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
        const deferredTargets = update.deferred || 0;
        const degradedTargets = update.timings.filter(timing => timing.degraded === true).length;
        return {
          ok: true,
          ...runtimeState(),
          message: `${degradedTargets ? `引擎失败，${degradedTargets} 个页面使用降级背景（需显式重试）` : "Runtime 与背景 DOM 已注入"}：${elapsedMs} ms；Scene 路径：${options.sceneRenderer}${deferredTargets ? `；${deferredTargets} 个隐藏页面等待显示后自动应用` : ""}`,
          deferredTargets,
          sceneRenderer: options.sceneRenderer,
          status: degradedTargets ? "engine-degraded" : `injected:${elapsedMs}`,
          compatibility: update.timings.map(({ targetId, compatibility: value }) => ({ targetId, value }))
        };
      }
      if (action === "restore") {
        const hasHostType = Object.hasOwn(body, "hostType");
        const requestedPort = Object.hasOwn(body, "port") ? validateCdpPort(body.port) : undefined;
        let hostType = options.hostType;
        if (hasHostType) {
          hostType = normalizeHostType(body.hostType, { strict: true, fallback: options.hostType });
        } else {
          const matchingEntry = requestedPort === undefined ? undefined
            : [...injectors.values()].find(({ port }) => port === requestedPort);
          if (matchingEntry) {
            hostType = matchingEntry.hostType;
          } else {
            const active = activeInjectors();
            if (active.length === 1) hostType = active[0].hostType;
          }
        }
        const entry = injectors.get(hostType);
        const port = requestedPort ?? entry?.port ?? (hasHostType ? defaultCdpPort(hostType) : options.cdpPort);
        assertPortAvailable(hostType, port);
        if (entry && entry.port !== port) throw new Error(`${hostDisplayName(hostType)} 当前使用 CDP 端口 ${entry.port}，请用该端口恢复`);
        await verifyActionEndpoint(port, hostType);
        await runInjectorAction(async () => {
          if (entry) await closeInjector(entry);
          else await restoreCdpWallpaper({
            port, hostType, compatibilityRestoreScript: buildCompatibilityRestoreScript(),
            verifyEndpoint: nativeProvider?.verifyEndpoint
              ? (selectedPort, purpose) => nativeProvider.verifyEndpoint(selectedPort, hostType, purpose)
              : null,
          });
        });
        return { ok: true, ...runtimeState(), message: "已恢复官方外观", status: "restored" };
      }
      if (action === "rescan") {
        await settleAll(activeInjectors(), ({ injector }) => injector.preloadScene(null));
        sceneAssetCache.clear();
        scanResult = await scanWallpaperProjects({ explicitRoots: options.steamRoots, steamRoots: options.steamRoots });
        server.setProjects(scanResult.projects);
        try {
          await chooseDefault(configStore, await server.projects());
          await refreshInjection({ allowDetached: true });
        } finally {
          await saveRuntime();
        }
        return { ok: true, message: `已发现 ${scanResult.projects.length} 个项目`, status: "rescanned" };
      }
      if (action === "play" || action === "pause") {
        await configStore.set({ effects: { playing: action === "play" } });
        await refreshInjection({ allowDetached: true });
        return { ok: true, status: action };
      }
      if (action === "engine-status") {
        const vp8Diagnostics = (delivery) => (delivery?.diagnostics() || []).map((entry) => ({ ...entry, renderer: "vp8" }));
        const engine = [
          ...vp8Diagnostics(sharedNativeDelivery),
          ...activeInjectors().flatMap(({ hostType, port, injector }) => [
            ...(injector.sceneDelivery?.diagnostics() || []),
            ...vp8Diagnostics(sharedNativeDelivery ? null : injector.nativeDelivery),
          ].map((entry) => ({ ...entry, hostType, port }))),
        ];
        return { ok: true, ...runtimeState(), sceneRenderer: options.sceneRenderer, engine };
      }
      if (action === "injection-status") {
        return { ok: true, registeredHosts: registeredHosts() };
      }
      if (action === "web-input") {
        const selectedId = configStore.get().selectedId;
        if (!directSceneEnabled || !activeInjectors().some(({ injector }) => injector.sceneDelivery) || body.projectId !== selectedId
          || Object.keys(body).some(key => !["action", "projectId", "input"].includes(key))) throw Error("web_input_unavailable");
        const selected = (await server.projects()).find(project => project.id === selectedId);
        if (selected?.type !== "web" || selected.eligible === false || selected.hidden) throw Error("web_input_unavailable");
        return dispatchInput(selectedId, validateWebWallpaperInput(body.input));
      }
      if (action === "retry-engine") {
        const selectedId = configStore.get().selectedId;
        const entries = activeInjectors().filter(({ injector }) => injector.nativeDelivery);
        if (!selectedId || (body.projectId !== undefined && body.projectId !== selectedId) || !entries.length) throw new Error("当前场景无法重试");
        const selected = (await server.projects()).find((project) => project.id === selectedId);
        const retryScene = directSceneEnabled && ["scene", "web"].includes(selected?.type);
        const sourceCleared = sharedNativeDelivery?.hasSourceFailure(selectedId) === true;
        if (sourceCleared) await sharedNativeDelivery.retry(selectedId);
        const results = await settleAll(entries, ({ injector }) => retryScene ? injector.retryScene(selectedId)
          : injector.retryNative(selectedId, { retrySource: !sharedNativeDelivery }));
        const failures = [];
        const retried = entries.filter(({ hostType }, index) => {
          const result = results[index];
          if (result.status === "fulfilled") return sourceCleared || result.value.cleared;
          failures.push(`${hostDisplayName(hostType)}：${result.reason.message}`);
          return false;
        });
        if (retried.length) {
          try {
            await refreshInjection({
              entries: retried,
              onDegraded: (hostType) => failures.push(`${hostDisplayName(hostType)}：场景仍在使用降级背景`),
            });
          } catch (error) { failures.push(error.message); }
        }
        if (failures.length) throw new Error(`场景重试失败：${failures.join("；")}`);
        if (!retried.length) return { ok: true, status: "engine-retry-skipped", message: "当前宿主场景无需重试" };
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
    if (options.command === "inject") await ensureInjector({ hostType: options.hostType, port: options.cdpPort });
    await saveRuntime();
  });
  if (options.open) openExternal(server.baseUrl);

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (occlusion) for (const { injector } of injectors.values()) injector.stopOcclusion();
    console.log(`\n收到 ${signal}，正在清理...`);
    await operationQueue;
    const errors = [];
    for (const cleanup of [
      () => media.close(),
      () => closeInjectors(true),
      () => sharedNativeDelivery?.close(),
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
    for (const cleanup of [() => media.close(), () => closeInjectors(), () => sharedNativeDelivery?.close(), () => server?.close(), () => nativeProvider?.close()]) {
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
