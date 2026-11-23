import path from "node:path";

// Exact compiled/native/vendor allowlist. No source-tree wildcard and no WE assets.
export const COMPILED_BRIDGE_UNPACKED_FILES = Object.freeze([
  "dist/bridge-utility-entry.mjs",
  ...["windows-media.ps1", "windows-media.dll", "cwb-win-helper.exe"].map(file => `dist/bridge-runtime/native/${file}`),
  ...["app.js", "author-properties-panel.js", "cwb-scene-bridge.js", "cwb-verifier-probe.js", "cwb-web-bridge.js",
    "electron-host.js", "index.html", "media-switch.js", "workbench-scene-preview.js", "workbench-theme.js", "styles.css"].map((file) => `dist/bridge-runtime/public/${file}`),
  ...["cli.mjs", "desktop-engine-host.mjs", "engine-provider-rpc.mjs", "engine-renderer-owner.mjs", "engine-vp8-preload.cjs",
    "native-engine-provider.mjs", "scene-server.mjs"].map((file) => `dist/bridge-runtime/src/${file}`),
  ...["index.html", "LICENSE", "mediabunny-LICENSE", "NOTICE.md", "vendor-lock.json", "we-scene-LICENSE", "web-shim.js",
    "assets/modulepreload-polyfill-B5Qt9EMX.js", "assets/renderer-AJkjEL9i.js", "default-wallpaper/index.html",
    "sources/mediabunny-1.56.0.tgz"].map((file) => `dist/bridge-runtime/vendor/webwallgl/${file}`),
]);

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
    builderArtifactName: `${productName}-${version}-Setup.exe`,
    installerName: `${productName}-${version}-Setup.exe`,
    releaseDirectoryName: `release-${version}`,
    scratchDirectoryName: ".nsis-build",
    unpackedDirectoryName: "win-unpacked",
  };
}

export function assertProtectedPackageEntries(entries) {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  const required = [
    "/dist/main.mjs",
    "/dist/preload.cjs",
    "/dist/engine-vp8-preload.cjs",
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
  const allowed = new Set(COMPILED_BRIDGE_UNPACKED_FILES);
  const unexpected = normalized.find((entry) => !allowed.has(entry));
  if (unexpected) throw new Error(`松散目录包含未批准的文件：${unexpected}`);
  for (const entry of allowed) {
    if (!normalized.includes(entry)) throw new Error(`松散目录缺少编译运行文件：${entry}`);
  }
  return normalized;
}
