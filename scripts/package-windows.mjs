import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
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
const names = windowsArtifactNames("CodexWallpaperDesktop", packageJson.version);
const scratchRoot = assertChildPath(outputRoot, path.join(outputRoot, names.scratchDirectoryName));
const releaseRoot = assertChildPath(outputRoot, path.join(outputRoot, names.releaseDirectoryName));
const finalPath = assertChildPath(releaseRoot, path.join(releaseRoot, names.portableName));

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
  const mainCode = extractFile(appAsar, path.join("dist", "main.mjs")).toString("utf8");
  const bridgeCode = await readFile(
    path.join(asarUnpacked, "dist", "bridge-runtime", "src", "cli.mjs"),
    "utf8",
  );
  for (const marker of ["buildCompatibilityScript", "createVideoTransferAsset", "rendererEffects"]) {
    if (mainCode.includes(marker) || bridgeCode.includes(marker)) {
      throw new Error(`编译产物仍暴露关键源码标识：${marker}`);
    }
  }
  return { appAsar, entries, unpackedEntries };
}

await mkdir(outputRoot, { recursive: true });
await rm(scratchRoot, { recursive: true, force: true });
if (await exists(releaseRoot)) {
  const releaseEntries = await readdir(releaseRoot);
  const unexpectedEntries = releaseEntries.filter((entry) => entry !== names.portableName);
  if (unexpectedEntries.length > 0) {
    throw new Error(`release 目录含有未知文件，拒绝覆盖：${unexpectedEntries.join(", ")}`);
  }
}

let succeeded = false;
try {
  const artifacts = await build({
    config: {
      ...packageJson.build,
      directories: {
        ...packageJson.build.directories,
        output: scratchRoot,
      },
    },
    publish: "never",
    targets: Platform.WINDOWS.createTarget(["portable"], Arch.x64),
  });
  const builtPortable = artifacts.find((artifact) => (
    path.basename(artifact).toLowerCase() === names.builderArtifactName.toLowerCase()
  ));
  if (!builtPortable) throw new Error(`未找到 Portable 产物：${names.builderArtifactName}`);

  const unpackedRoot = path.join(scratchRoot, names.unpackedDirectoryName);
  const validation = await validateUnpackedApplication(unpackedRoot);
  await mkdir(releaseRoot, { recursive: true });
  await copyFile(builtPortable, finalPath);

  const releaseEntries = await readdir(releaseRoot);
  if (releaseEntries.length !== 1 || releaseEntries[0] !== names.portableName) {
    throw new Error(`release 目录必须只包含 ${names.portableName}`);
  }

  const info = await stat(finalPath);
  console.log(`单文件产物：${finalPath}`);
  console.log(`文件大小：${(info.size / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`SHA-256：${await sha256(finalPath)}`);
  console.log(`ASAR 条目：${validation.entries.length}（主程序完整性校验已启用）`);
  console.log(`解包运行文件：${validation.unpackedEntries.length}（仅编译混淆后的桥接文件）`);
  succeeded = true;
} finally {
  if (succeeded) {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    console.error(`构建未完成，诊断目录保留在：${scratchRoot}`);
  }
}
