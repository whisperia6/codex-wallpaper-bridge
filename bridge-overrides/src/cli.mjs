#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpWallpaperInjector, restoreCdpWallpaper } from "./cdp-injector.mjs";
import { createConfigStore } from "./config-store.mjs";
import { buildInjectionScript } from "./injected-renderer.mjs";
import { createMediaServer } from "./media-server.mjs";
import { scanWallpaperProjects } from "./scanner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const publicDir = path.join(projectRoot, "public");
const stateRoot = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexWallpaperBridge")
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "codex-wallpaper-bridge");
const runtimePath = path.join(stateRoot, "runtime.json");
const inlineAssetCache = new Map();
const INLINE_VIDEO_MAX_BYTES = 32 * 1024 * 1024;
const TRANSFER_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Map([
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"]
]);

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
  return options;
}

function printHelp() {
  console.log(`Codex Wallpaper Bridge

用法：
  node src/cli.mjs preview [--no-open]
  node src/cli.mjs inject [--cdp-port 9335] [--no-open] [--once | --keep-on-exit]
  node src/cli.mjs restore [--cdp-port 9335]
  node src/cli.mjs scan [--steam-root D:\\steam]

选项：
  --once         注入已保存的皮肤后立即退出，保留当前 Codex 窗口中的效果
  --keep-on-exit 保持控制页实时同步；退出桥接时保留当前 Codex 窗口中的效果
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

function absoluteAssetUrl(value, origin) {
  if (!value) return null;
  return new URL(value, origin).href;
}

async function fetchAsDataUrl(url, maximumBytes) {
  if (!url) return null;
  const cacheKey = `${maximumBytes}:${url}`;
  if (inlineAssetCache.has(cacheKey)) return inlineAssetCache.get(cacheKey);
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  const declaredLength = Number(head?.headers?.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    inlineAssetCache.set(cacheKey, null);
    return null;
  }
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) {
    inlineAssetCache.set(cacheKey, null);
    return null;
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";
  const result = `data:${contentType};base64,${bytes.toString("base64")}`;
  inlineAssetCache.set(cacheKey, result);
  return result;
}

async function createVideoTransferAsset(project) {
  const filePath = project?.mediaPath;
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > TRANSFER_VIDEO_MAX_BYTES) return null;
    return {
      key: `video:${project.id}:${info.size}:${Math.trunc(info.mtimeMs)}`,
      filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      contentType: VIDEO_MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "video/mp4"
    };
  } catch {
    return null;
  }
}

function rendererEffects(config) {
  const effects = config?.effects || {};
  const asPercent = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return number <= 3 ? number * 100 : number;
  };
  const rawDim = effects.dim ?? effects.darkness;
  const dimNumber = Number(rawDim);
  return {
    brightness: asPercent(effects.brightness, 82),
    saturation: asPercent(effects.saturation, 105),
    dim: Number.isFinite(dimNumber) ? (dimNumber <= 1 ? dimNumber * 100 : dimNumber) : 28,
    blur: Number(effects.blur) || 0,
    fit: effects.fit || "cover",
    position: effects.position || "50% 50%",
    playing: effects.playing !== false,
    pauseWhenHidden: effects.pauseWhenHidden !== false,
    glassOpacity: Number(effects.glassOpacity) || 62,
    glassBlur: Number(effects.glassBlur) || 18
  };
}

async function fetchPublicInventory(server) {
  const response = await fetch(new URL("api/inventory", server.baseUrl));
  if (!response.ok) throw new Error(`壁纸 API 返回 HTTP ${response.status}`);
  return response.json();
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

async function buildCurrentScript(server, configStore, sourceProjects = []) {
  const inventory = await fetchPublicInventory(server);
  const config = await configStore.get();
  const projects = inventory.projects || inventory.items || [];
  const selected = projects.find((project) => project.id === config.selectedId) || projects[0] || null;
  let wallpaper = null;
  const assets = [];
  if (selected) {
    const mediaUrl = absoluteAssetUrl(selected.mediaUrl, server.origin);
    const previewUrl = absoluteAssetUrl(selected.previewUrl, server.origin);
    const webUrl = absoluteAssetUrl(selected.webUrl, server.origin);
    const inlinePreview = await fetchAsDataUrl(previewUrl, 12 * 1024 * 1024);
    if (selected.type === "video") {
      // app:// renderers cannot read the loopback media URL directly. Small
      // videos stay inline; larger files are transferred over CDP in bounded
      // chunks and assembled into a renderer-owned Blob URL.
      const inlineVideo = await fetchAsDataUrl(mediaUrl, INLINE_VIDEO_MAX_BYTES);
      if (inlineVideo) {
        wallpaper = { ...selected, playable: "video", mediaUrl: inlineVideo, previewUrl: inlinePreview };
      } else {
        const sourceProject = sourceProjects.find((project) => String(project.id) === String(selected.id));
        const asset = await createVideoTransferAsset(sourceProject);
        if (asset) {
          assets.push(asset);
          wallpaper = {
            ...selected,
            playable: "video",
            mediaUrl: null,
            mediaAssetKey: asset.key,
            previewUrl: inlinePreview
          };
        } else {
          console.warn("大视频无法安全传输（文件不可读或超过 512 MiB），已使用静态预览。");
          wallpaper = {
            ...selected,
            type: "scene",
            playable: "image",
            mediaUrl: inlinePreview,
            previewUrl: inlinePreview
          };
        }
      }
    } else if (selected.type === "web") {
      // Web wallpapers remain fully interactive in the HTTP preview. Codex's
      // app:// URL safety policy rejects their loopback iframe, so injection
      // uses the preview image until a dedicated protocol bridge is added.
      wallpaper = { ...selected, type: "scene", playable: "image", mediaUrl: inlinePreview, previewUrl: inlinePreview, webUrl };
    } else {
      wallpaper = { ...selected, playable: "image", mediaUrl: inlinePreview, previewUrl: inlinePreview };
    }
  }
  return {
    script: buildInjectionScript({
      wallpaper,
      config: { ...config, effects: rendererEffects(config) }
    }),
    assets
  };
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
    const injection = await buildCurrentScript(server, configStore, scanResult.projects);
    const result = await injector.update(injection);
    return { ok: result.failed === 0, status: `updated:${result.sessions}` };
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
      const injection = await buildCurrentScript(server, configStore, scanResult.projects);
      await injector.start(injection);
      if (injector.sessions.size === 0) {
        await injector.close();
        injector = null;
        throw new Error(`没有在 127.0.0.1:${options.cdpPort} 找到 Codex renderer；可先使用预览页`);
      }
    }
    return injector;
  };

  server = createMediaServer({
    projects: scanResult.projects,
    publicDir,
    configStore,
    onConfigChange: async () => refreshInjection(),
    onAction: async (action) => {
      if (action === "inject") {
        await ensureInjector();
        await refreshInjection();
        await writeRuntime(server, options, scanResult, true);
        return { ok: true, message: "已注入当前 Codex 窗口", status: "injected" };
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
        inlineAssetCache.clear();
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
    if (options.once) {
      try {
        await injector.close({ preserveCurrentPage: true });
      } finally {
        injector = null;
        await server.close().catch(() => {});
        await rm(runtimePath, { force: true }).catch(() => {});
      }
      console.log("一次性注入完成；桥接已退出，当前 Codex 窗口将保留皮肤。");
      return;
    }
  }
  await writeRuntime(server, options, scanResult, Boolean(injector));
  if (options.open) openExternal(server.baseUrl);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在清理...`);
    await injector?.close(options.keepOnExit
      ? { preserveCurrentPage: true }
      : { restore: true }).catch(() => {});
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
