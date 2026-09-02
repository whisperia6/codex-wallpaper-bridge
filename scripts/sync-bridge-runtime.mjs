import { access, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(here, "..");
const targetRoot = path.resolve(prototypeRoot, "bridge-runtime");
const overridesRoot = path.resolve(prototypeRoot, "bridge-overrides");
const relativeTarget = path.relative(prototypeRoot, targetRoot);

if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
  throw new Error(`桥接运行时目录超出项目范围：${targetRoot}`);
}

for (const requiredPath of [
  "package.json",
  path.join("src", "cli.mjs"),
  path.join("public", "index.html"),
  path.join("public", "app.js"),
]) {
  try {
    await access(path.join(targetRoot, requiredPath));
  } catch {
    throw new Error(`仓库内置桥接运行时不完整：缺少 bridge-runtime/${requiredPath}`);
  }
}

await cp(overridesRoot, targetRoot, { recursive: true, force: true });

const controlIndexPath = path.join(targetRoot, "public", "index.html");
let controlIndex = await readFile(controlIndexPath, "utf8");
const hostScript = '    <script src="electron-host.js" defer></script>';
const appScript = '    <script src="app.js" defer></script>';
if (!controlIndex.includes(hostScript)) {
  if (!controlIndex.includes(appScript)) {
    throw new Error("无法为 Electron 控制页安装保存握手：未找到 app.js 脚本标签");
  }
  controlIndex = controlIndex.replace(appScript, `${hostScript}\n${appScript}`);
  await writeFile(controlIndexPath, controlIndex, "utf8");
}

const hostScriptCount = controlIndex.split('src="electron-host.js"').length - 1;
if (hostScriptCount !== 1) {
  throw new Error(`Electron 控制页保存握手脚本数量异常：${hostScriptCount}`);
}

const packageJson = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8"));
const manifest = {
  schemaVersion: 1,
  source: "bundled standalone bridge runtime with Electron-only overrides",
  bridgeVersion: packageJson.version,
  overrides: ["large-video-cdp-blob-transfer", "embedded-control-save-handshake"],
};
await writeFile(
  path.join(targetRoot, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`仓库内置桥接运行时已就绪：${targetRoot}`);
