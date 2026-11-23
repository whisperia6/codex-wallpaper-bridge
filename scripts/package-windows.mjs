import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { Arch, build, Platform } from "electron-builder";
import {
  assertChildPath,
  assertProtectedPackageEntries,
  assertProtectedUnpackedEntries,
  windowsArtifactNames,
} from "../src/package-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const outputRoot = path.join(prototypeRoot, "out");
const packageJson = JSON.parse(await readFile(path.join(prototypeRoot, "package.json"), "utf8"));
const electronRoot = path.join(prototypeRoot, "node_modules", "electron");
const electronDist = path.join(electronRoot, "dist");
const electronPackage = JSON.parse(await readFile(path.join(electronRoot, "package.json"), "utf8"));
const electronRuntimeVersion = (await readFile(path.join(electronDist, "version"), "utf8")).trim();
if (electronRuntimeVersion !== electronPackage.version) throw new Error("本地 Electron 运行时版本不一致，请重新安装依赖");
const names = windowsArtifactNames("CodexWallpaperDesktop", packageJson.version);

function resolveScratchPaths() {
  const customRoot = String(process.env.CWB_BUILD_TEMP_ROOT || "").trim();
  if (customRoot) {
    const base = path.resolve(customRoot);
    return {
      baseRoot: base,
      scratchRoot: assertChildPath(base, path.join(base, names.scratchDirectoryName)),
      cacheRoot: assertChildPath(base, path.join(base, "electron-builder-cache")),
    };
  }
  if (process.platform === "win32" && existsSync("F:\\")) {
    const base = "F:\\.cwb-build-tmp";
    return {
      baseRoot: base,
      scratchRoot: assertChildPath(base, path.join(base, "codex-wallpaper-desktop", names.scratchDirectoryName)),
      cacheRoot: assertChildPath(base, path.join(base, "electron-builder-cache")),
    };
  }
  return {
    baseRoot: outputRoot,
    scratchRoot: assertChildPath(outputRoot, path.join(outputRoot, names.scratchDirectoryName)),
    cacheRoot: null,
  };
}

const { scratchRoot, cacheRoot } = resolveScratchPaths();
const scratchTempRoot = assertChildPath(scratchRoot, path.join(scratchRoot, ".tmp"));
const releaseRoot = assertChildPath(outputRoot, path.join(outputRoot, names.releaseDirectoryName));
const finalPath = assertChildPath(releaseRoot, path.join(releaseRoot, names.installerName));
const packageStartedAt = performance.now();
const logTiming = (stage, startedAt) => console.log(`[build-timing] ${JSON.stringify({ stage, durationMs: Math.round(performance.now() - startedAt) })}`);

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

async function listRelativeFiles(rootPath, currentPath = rootPath) {
  const files = [];
  for (const entry of await readdir(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) files.push(...await listRelativeFiles(rootPath, entryPath));
    else if (entry.isFile()) files.push(path.relative(rootPath, entryPath));
  }
  return files;
}

async function validateUnpackedApplication(unpackedRoot) {
  const resourcesRoot = path.join(unpackedRoot, "resources");
  const appAsar = path.join(resourcesRoot, "app.asar");
  const looseApp = path.join(resourcesRoot, "app");
  const asarUnpacked = path.join(resourcesRoot, "app.asar.unpacked");
  await access(appAsar);
  if (await exists(looseApp)) throw new Error("发布包仍包含 resources/app 明文源码目录");
  if (!await exists(asarUnpacked)) throw new Error("发布包缺少编译桥接运行时目录");

  const entries = assertProtectedPackageEntries(listPackage(appAsar));
  const unpackedEntries = assertProtectedUnpackedEntries(await listRelativeFiles(asarUnpacked));
  const localesRoot = path.join(unpackedRoot, "locales");
  const localeFiles = (await exists(localesRoot))
    ? (await readdir(localesRoot)).filter((name) => name.endsWith(".pak")).sort()
    : [];
  return { appAsar, entries, unpackedEntries, localeFiles };
}

await mkdir(outputRoot, { recursive: true });
await rm(scratchRoot, { recursive: true, force: true });
await mkdir(scratchTempRoot, { recursive: true });

if (await exists(releaseRoot)) {
  const releaseEntries = await readdir(releaseRoot);
  const unexpectedEntries = releaseEntries.filter((entry) => entry !== names.installerName);
  if (unexpectedEntries.length > 0) {
    throw new Error(`release 目录含有未知文件，拒绝覆盖：${unexpectedEntries.join(", ")}`);
  }
}

const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalCache = process.env.ELECTRON_BUILDER_CACHE;
process.env.TEMP = scratchTempRoot;
process.env.TMP = scratchTempRoot;
const defaultBuilderCache = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache")
  : null;
if (cacheRoot && !originalCache && (!defaultBuilderCache || !existsSync(defaultBuilderCache))) {
  await mkdir(cacheRoot, { recursive: true });
  process.env.ELECTRON_BUILDER_CACHE = cacheRoot;
}
console.log(`构建临时目录：${scratchRoot}`);

let succeeded = false;
try {
  const builderStartedAt = performance.now();
  const artifacts = await build({
    config: {
      ...packageJson.build,
      // Reuse npm's matching runtime instead of downloading it again through a mirror.
      electronVersion: electronRuntimeVersion,
      electronDist,
      directories: {
        ...packageJson.build.directories,
        output: scratchRoot,
      },
    },
    publish: "never",
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  });
  logTiming("electron-builder", builderStartedAt);
  const builtInstaller = artifacts.find((artifact) => (
    path.basename(artifact).toLowerCase() === names.builderArtifactName.toLowerCase()
  ));
  if (!builtInstaller) throw new Error(`未找到 NSIS 安装包产物：${names.builderArtifactName}`);

  const unpackedRoot = path.join(scratchRoot, names.unpackedDirectoryName);
  const validationStartedAt = performance.now();
  const validation = await validateUnpackedApplication(unpackedRoot);
  await mkdir(releaseRoot, { recursive: true });
  await copyFile(builtInstaller, finalPath);

  const releaseEntries = await readdir(releaseRoot);
  if (releaseEntries.length !== 1 || releaseEntries[0] !== names.installerName) {
    throw new Error(`release 目录必须只包含 ${names.installerName}`);
  }

  const info = await stat(finalPath);
  console.log(`NSIS 安装包产物：${finalPath}`);
  console.log(`文件大小：${(info.size / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`SHA-256：${await sha256(finalPath)}`);
  console.log(`ASAR 条目：${validation.entries.length}（主程序完整性校验已启用）`);
  console.log(`解包运行文件：${validation.unpackedEntries.length}（编译桥接文件及必要资源，不含代码混淆）`);
  console.log(`保留语言包：${validation.localeFiles.join(", ")}（共 ${validation.localeFiles.length} 个）`);
  logTiming("validate-copy-hash", validationStartedAt);
  succeeded = true;
} finally {
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  if (originalTmp === undefined) delete process.env.TMP;
  else process.env.TMP = originalTmp;
  if (originalCache === undefined) delete process.env.ELECTRON_BUILDER_CACHE;
  else process.env.ELECTRON_BUILDER_CACHE = originalCache;
  if (succeeded) {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    console.error(`构建未完成，诊断目录保留在：${scratchRoot}`);
  }
  logTiming("package-total", packageStartedAt);
}
