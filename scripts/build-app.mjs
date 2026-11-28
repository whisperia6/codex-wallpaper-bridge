import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { assertChildPath } from "../src/package-layout.mjs";
import { verifyWebWallglAssets } from "../bridge-runtime/src/scene-server.mjs";
import { desktopMainBuildOptions } from "./desktop-main-build.mjs";
import { compileWindowsMedia } from "./compile-windows-media.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const sourceRoot = path.join(prototypeRoot, "src");
const bridgeRoot = path.join(prototypeRoot, "bridge-runtime");
const distRoot = assertChildPath(prototypeRoot, path.join(prototypeRoot, "dist"));
const buildStartedAt = performance.now();

const nodeBuild = {
  bundle: true,
  external: ["electron", "ws"],
  format: "esm",
  legalComments: "none",
  logLevel: "silent",
  minify: true,
  platform: "node",
  sourcemap: false,
  target: "node22",
  treeShaking: true,
};

async function minifyAsset(sourcePath, outputPath, loader) {
  const source = await readFile(sourcePath, "utf8");
  const result = await transform(source, {
    legalComments: "none",
    loader,
    minify: true,
    sourcefile: path.basename(sourcePath),
    sourcemap: false,
    target: loader === "css" ? undefined : "chrome130",
  });
  await writeFile(outputPath, result.code, "utf8");
}

await verifyWebWallglAssets();
await rm(distRoot, { recursive: true, force: true });
await mkdir(path.join(distRoot, "renderer"), { recursive: true });
await mkdir(path.join(distRoot, "bridge-runtime", "src"), { recursive: true });
await mkdir(path.join(distRoot, "bridge-runtime", "public"), { recursive: true });

await Promise.all([
  build(desktopMainBuildOptions({ sourceRoot, distRoot, base: nodeBuild })),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "bridge-utility-entry.mjs")],
    outfile: path.join(distRoot, "bridge-utility-entry.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(bridgeRoot, "src", "scene-server.mjs")],
    outfile: path.join(distRoot, "bridge-runtime", "src", "scene-server.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "engine-renderer-owner.mjs")],
    outfile: path.join(distRoot, "bridge-runtime", "src", "engine-renderer-owner.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "engine-provider-rpc.mjs")],
    outfile: path.join(distRoot, "bridge-runtime", "src", "engine-provider-rpc.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "desktop-engine-host.mjs")],
    outfile: path.join(distRoot, "bridge-runtime", "src", "desktop-engine-host.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(bridgeRoot, "src", "native-engine-provider.mjs")],
    outfile: path.join(distRoot, "bridge-runtime", "src", "native-engine-provider.mjs"),
  }),
  build({
    ...nodeBuild,
    banner: {
      js: 'import { createRequire as __cwbCreateRequire } from "node:module"; const require = __cwbCreateRequire(import.meta.url);',
    },
    entryPoints: [path.join(bridgeRoot, "src", "cli.mjs")],
    external: ["bufferutil", "utf-8-validate"],
    outfile: path.join(distRoot, "bridge-runtime", "src", "cli.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "preload.cjs")],
    external: ["electron"],
    format: "cjs",
    outfile: path.join(distRoot, "preload.cjs"),
  }),
  ...[distRoot, path.join(distRoot, "bridge-runtime", "src")].map((directory) => build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "engine-vp8-preload.cjs")],
    format: "cjs",
    outfile: path.join(directory, "engine-vp8-preload.cjs"),
  })),
  build({
    bundle: true,
    entryPoints: [path.join(sourceRoot, "renderer", "renderer-desktop.mjs")],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: true,
    outfile: path.join(distRoot, "renderer", "renderer-desktop.mjs"),
    platform: "browser",
    sourcemap: false,
    target: "chrome130",
    treeShaking: true,
  }),
  cp(
    path.join(sourceRoot, "renderer", "index.html"),
    path.join(distRoot, "renderer", "index.html"),
  ),
  cp(
    path.join(bridgeRoot, "public", "index.html"),
    path.join(distRoot, "bridge-runtime", "public", "index.html"),
  ),
  minifyAsset(
    path.join(sourceRoot, "renderer", "styles.css"),
    path.join(distRoot, "renderer", "styles.css"),
    "css",
  ),
  minifyAsset(
    path.join(bridgeRoot, "public", "styles.css"),
    path.join(distRoot, "bridge-runtime", "public", "styles.css"),
    "css",
  ),
  minifyAsset(
    path.join(bridgeRoot, "public", "app.js"),
    path.join(distRoot, "bridge-runtime", "public", "app.js"),
    "js",
  ),
  minifyAsset(path.join(bridgeRoot, "public", "workbench-theme.js"),
    path.join(distRoot, "bridge-runtime", "public", "workbench-theme.js"), "js"),
  minifyAsset(
    path.join(bridgeRoot, "public", "cwb-web-bridge.js"),
    path.join(distRoot, "bridge-runtime", "public", "cwb-web-bridge.js"),
    "js",
  ),
  minifyAsset(
    path.join(bridgeRoot, "public", "cwb-verifier-probe.js"),
    path.join(distRoot, "bridge-runtime", "public", "cwb-verifier-probe.js"),
    "js",
  ),
  minifyAsset(
    path.join(bridgeRoot, "public", "electron-host.js"),
    path.join(distRoot, "bridge-runtime", "public", "electron-host.js"),
    "js",
  ),
  minifyAsset(path.join(bridgeRoot, "public", "media-switch.js"),
    path.join(distRoot, "bridge-runtime", "public", "media-switch.js"), "js"),
  minifyAsset(path.join(bridgeRoot, "public", "author-properties-panel.js"),
    path.join(distRoot, "bridge-runtime", "public", "author-properties-panel.js"), "js"),
  minifyAsset(path.join(bridgeRoot, "public", "workbench-scene-preview.js"),
    path.join(distRoot, "bridge-runtime", "public", "workbench-scene-preview.js"), "js"),
  minifyAsset(path.join(bridgeRoot, "public", "cwb-scene-bridge.js"),
    path.join(distRoot, "bridge-runtime", "public", "cwb-scene-bridge.js"), "js"),
  minifyAsset(path.join(bridgeRoot, "public", "cwb-scene-host.mjs"),
    path.join(distRoot, "bridge-runtime", "public", "cwb-scene-host.mjs"), "js"),
  cp(path.join(bridgeRoot, "vendor"), path.join(distRoot, "bridge-runtime", "vendor"), { recursive: true }),
  compileWindowsMedia({ nativeRoot: path.join(bridgeRoot, "native"), outputRoot: path.join(distRoot, "bridge-runtime", "native") }),
]);

console.log(`应用已构建到 ${distRoot}（普通压缩，不进行代码混淆）`);
console.log(`[build-timing] ${JSON.stringify({ stage: "compile-assets", durationMs: Math.round(performance.now() - buildStartedAt), obfuscation: false })}`);
