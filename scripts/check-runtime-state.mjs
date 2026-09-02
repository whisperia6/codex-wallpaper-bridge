import { evaluateInCodexTargets } from "../src/cdp-client.mjs";
import { validateCdpPort } from "../src/installations.mjs";

const port = validateCdpPort(process.argv[2] || 9335);
const state = await evaluateInCodexTargets(port, `(() => ({
  bridge: Boolean(document.querySelector("#codex-wallpaper-bridge-root")),
  bridgeStyle: Boolean(document.querySelector("#codex-wallpaper-bridge-style")),
  compatibilityStyle: Boolean(document.querySelector("#codex-wallpaper-electron-compat-style")),
  compatibilityRuntime: Boolean(window.__codexWallpaperElectronCompat),
  compatibilityAttribute: document.documentElement.getAttribute("data-cwb-electron-compat"),
  autoCleared: document.querySelectorAll("[data-cwb-electron-auto-clear]").length
}))()`);

console.log(JSON.stringify(state, null, 2));
