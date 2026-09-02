import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBridgeCommand } from "../src/bridge-runner.mjs";
import { evaluateInCodexTargets } from "../src/cdp-client.mjs";
import { buildCompatibilityRestoreScript } from "../src/compatibility-script.mjs";
import { validateCdpPort } from "../src/installations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = validateCdpPort(process.argv[2] || 9335);
const bridgeRoot = path.resolve(here, "..", "bridge-runtime");
const compatibility = await evaluateInCodexTargets(port, buildCompatibilityRestoreScript());
await runBridgeCommand({
  executablePath: process.execPath,
  bridgeRoot,
  command: "restore",
  port,
});
const state = await evaluateInCodexTargets(port, `(() => ({
  bridge: Boolean(document.querySelector("#codex-wallpaper-bridge-root")),
  bridgeStyle: Boolean(document.querySelector("#codex-wallpaper-bridge-style")),
  compatibilityStyle: Boolean(document.querySelector("#codex-wallpaper-electron-compat-style")),
  compatibilityRuntime: Boolean(window.__codexWallpaperElectronCompat),
  compatibilityAttribute: document.documentElement.hasAttribute("data-cwb-electron-compat"),
  autoCleared: document.querySelectorAll("[data-cwb-electron-auto-clear]").length
}))()`);

console.log(JSON.stringify({ compatibility, state }, null, 2));
