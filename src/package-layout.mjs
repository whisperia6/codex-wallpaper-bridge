import path from "node:path";

export function assertChildPath(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作输出目录之外的路径：${target}`);
  }
  return target;
}

export function windowsArtifactNames(productName, version) {
  return {
    builderArtifactName: `${productName}-${version}.exe`,
    portableName: `${productName}.exe`,
    releaseDirectoryName: `release-${version}`,
    scratchDirectoryName: ".portable-build",
    unpackedDirectoryName: "win-unpacked",
  };
}

export function assertProtectedPackageEntries(entries) {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  const required = [
    "/dist/main.mjs",
    "/dist/preload.cjs",
    "/dist/bridge-utility-entry.mjs",
    "/dist/bridge-runtime/src/cli.mjs",
    "/dist/bridge-runtime/public/index.html",
    "/dist/renderer/index.html",
  ];
  for (const entry of required) {
    if (!normalized.includes(entry)) throw new Error(`ASAR 缺少必要的编译产物：${entry}`);
  }

  const leaked = normalized.find((entry) => (
    entry.endsWith(".map")
    || entry.startsWith("/src/")
    || entry.startsWith("/scripts/")
    || entry.startsWith("/test/")
    || entry.startsWith("/bridge-overrides/")
    || entry.startsWith("/bridge-runtime/")
  ));
  if (leaked) throw new Error(`ASAR 包含不应发布的源码路径：${leaked}`);
  return normalized;
}

export function assertProtectedUnpackedEntries(entries) {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  const allowed = new Set([
    "dist/bridge-utility-entry.mjs",
    "dist/bridge-runtime/public/app.js",
    "dist/bridge-runtime/public/electron-host.js",
    "dist/bridge-runtime/public/index.html",
    "dist/bridge-runtime/public/styles.css",
    "dist/bridge-runtime/src/cli.mjs",
  ]);
  const unexpected = normalized.find((entry) => !allowed.has(entry));
  if (unexpected) throw new Error(`松散目录包含未批准的文件：${unexpected}`);
  for (const entry of allowed) {
    if (!normalized.includes(entry)) throw new Error(`松散目录缺少编译运行文件：${entry}`);
  }
  return normalized;
}
