import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { build, transform } from "esbuild";
import { assertChildPath } from "../src/package-layout.mjs";
import { createObfuscationOptions } from "./obfuscation-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const sourceRoot = path.join(prototypeRoot, "src");
const bridgeRoot = path.join(prototypeRoot, "bridge-runtime");
const distRoot = assertChildPath(prototypeRoot, path.join(prototypeRoot, "dist"));

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

async function obfuscate(filePath, {
  sourceType,
  target,
  preserveSerializedFunctions = false,
}) {
  const source = await readFile(filePath, "utf8");
  const result = JavaScriptObfuscator.obfuscate(source, createObfuscationOptions({
    sourceType,
    target,
    preserveSerializedFunctions,
  }));
  await writeFile(filePath, result.getObfuscatedCode(), "utf8");
}

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

await rm(distRoot, { recursive: true, force: true });
await mkdir(path.join(distRoot, "renderer"), { recursive: true });
await mkdir(path.join(distRoot, "bridge-runtime", "src"), { recursive: true });
await mkdir(path.join(distRoot, "bridge-runtime", "public"), { recursive: true });

await Promise.all([
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "main.mjs")],
    outfile: path.join(distRoot, "main.mjs"),
  }),
  build({
    ...nodeBuild,
    entryPoints: [path.join(sourceRoot, "bridge-utility-entry.mjs")],
    outfile: path.join(distRoot, "bridge-utility-entry.mjs"),
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
  minifyAsset(
    path.join(bridgeRoot, "public", "electron-host.js"),
    path.join(distRoot, "bridge-runtime", "public", "electron-host.js"),
    "js",
  ),
]);

await Promise.all([
  obfuscate(path.join(distRoot, "main.mjs"), { sourceType: "module", target: "node" }),
  obfuscate(path.join(distRoot, "bridge-runtime", "src", "cli.mjs"), {
    sourceType: "module",
    target: "node",
    preserveSerializedFunctions: true,
  }),
  obfuscate(path.join(distRoot, "renderer", "renderer-desktop.mjs"), {
    sourceType: "module",
    target: "browser-no-eval",
  }),
  obfuscate(path.join(distRoot, "bridge-runtime", "public", "app.js"), {
    sourceType: "script",
    target: "browser-no-eval",
  }),
  obfuscate(path.join(distRoot, "bridge-runtime", "public", "electron-host.js"), {
    sourceType: "script",
    target: "browser-no-eval",
  }),
]);

console.log(`受保护应用已构建到 ${distRoot}`);
