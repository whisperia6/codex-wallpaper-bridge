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
import { scanWallpaperProjects } from "./scanner.mjs";

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
  if (projects.some((project) => project.id === config.selectedId)) return config;
  const preferred = projects.find((project) => project.type === "video" && project.playable)
    || projects.find((project) => project.type === "web" && project.playable)
    || projects.find((project) => project.previewPath)
    || projects[0];
  if (preferred) config = await configStore.set({ selectedId: preferred.id });
  return config;
}

async function writeRuntime(server, options, scanResult, injectorActive) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(runtimePath, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    command: options.command,
    cdpPort: options.cdpPort,
    bridgeUrl: server?.baseUrl || null,
    projectRoot,
    injectorActive,
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
  await chooseDefault(configStore, scanResult.projects);

  let injector = null;
  let server;

  const refreshInjection = async () => {
    if (!injector) return { ok: true, status: "preview-only" };
    const injection = await buildCurrentInjection(server, configStore);
    const result = await injector.update(injection);
    return {
      ok: result.sessions > 0 && result.failed === 0,
      status: `updated:${result.sessions}`,
      metrics: injection.metrics,
      timings: result.timings
    };
  };

  const ensureInjector = async () => {
    if (!injector) {
      injector = new CdpWallpaperInjector({
        port: options.cdpPort,
        installOnNewDocument: !options.once,
        onStatus: (status) => {
          const suffix = status.message ? `：${status.message}` : "";
          console.log(`[CDP] ${status.type}${suffix}`);
        }
      });
      const injection = await buildCurrentInjection(server, configStore);
      await injector.start(injection);
      if (injector.sessions.size === 0) {
        await injector.close();
        injector = null;
        throw new Error(`没有在 127.0.0.1:${options.cdpPort} 找到 Codex renderer；可先使用预览页`);
      }
      return { injector, started: true, metrics: injection.metrics };
    }
    return { injector, started: false, metrics: null };
  };

  server = createMediaServer({
    projects: scanResult.projects,
    publicDir,
    configStore,
    onConfigChange: async () => refreshInjection(),
    onAction: async (action) => {
      if (action === "inject") {
        const startedAt = performance.now();
        const state = await ensureInjector();
        const update = state.started
          ? { ok: true, metrics: state.metrics, timings: [] }
          : await refreshInjection();
        if (!update.ok) throw new Error("一个或多个 Codex renderer 未能完成注入验证");
        await writeRuntime(server, options, scanResult, true);
        const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
        return {
          ok: true,
          message: `Runtime 与背景 DOM 已注入：${elapsedMs} ms；媒体正在按需加载`,
          status: `injected:${elapsedMs}`
        };
      }
      if (action === "restore") {
        if (injector) {
          await injector.close({ restore: true });
          injector = null;
        } else {
          await restoreCdpWallpaper({ port: options.cdpPort });
        }
        await writeRuntime(server, options, scanResult, false);
        return { ok: true, message: "已恢复官方外观", status: "restored" };
      }
      if (action === "rescan") {
        scanResult = await scanWallpaperProjects({ explicitRoots: options.steamRoots, steamRoots: options.steamRoots });
        server.setProjects(scanResult.projects);
        await chooseDefault(configStore, scanResult.projects);
        await refreshInjection();
        await writeRuntime(server, options, scanResult, Boolean(injector));
        return { ok: true, message: `已发现 ${scanResult.projects.length} 个项目`, status: "rescanned" };
      }
      if (action === "play" || action === "pause") {
        await configStore.set({ effects: { playing: action === "play" } });
        await refreshInjection();
        return { ok: true, status: action };
      }
      return { ok: false, message: `不支持的操作：${action}`, status: "unsupported" };
    }
  });
  await server.start();

  console.log(`扫描完成：${scanResult.projects.length} 个项目`);
  console.log(`控制与预览：${server.baseUrl}`);
  if (scanResult.warnings.length) console.log(`扫描警告：${scanResult.warnings.length} 条（不会阻止可用项目）`);

  if (options.command === "inject") {
    await ensureInjector();
  }
  await writeRuntime(server, options, scanResult, Boolean(injector));
  if (options.open) openExternal(server.baseUrl);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在清理...`);
    await injector?.close({ restore: true }).catch(() => {});
    await server.close().catch(() => {});
    await rm(runtimePath, { force: true }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  if (process.env.CWB_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
