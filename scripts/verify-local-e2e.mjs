import { collectCdpDiagnostics, evaluateInCodexTargets } from "../src/cdp-client.mjs";
import { buildCompatibilityScript } from "../src/compatibility-script.mjs";
import { validateCdpPort } from "../src/installations.mjs";

const port = validateCdpPort(process.argv[2] || 9335);
const applied = await evaluateInCodexTargets(port, buildCompatibilityScript({ adaptive: true }));
await new Promise((resolve) => setTimeout(resolve, 1_200));
const state = await evaluateInCodexTargets(port, `(() => ({
  bridge: Boolean(document.querySelector("#codex-wallpaper-bridge-root")),
  compat: document.documentElement.getAttribute("data-cwb-electron-compat"),
  autoCleared: document.querySelectorAll("[data-cwb-electron-auto-clear]").length,
  style: Boolean(document.querySelector("#codex-wallpaper-electron-compat-style")),
  topBannerPath: document.elementsFromPoint(innerWidth / 2, Math.min(125, innerHeight / 5)).slice(0, 8).map((element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id,
    role: element.getAttribute("role"),
    classTokens: [...element.classList].slice(0, 16),
    dataAttributes: element.getAttributeNames().filter((name) => name.startsWith("data-")),
    backgroundColor: getComputedStyle(element).backgroundColor
  }))
}))()`);
const diagnostics = await collectCdpDiagnostics(port);

console.log(JSON.stringify({
  applied,
  state,
  browser: diagnostics.browser,
  targetCount: diagnostics.targets.length,
  semanticHits: diagnostics.targets.map((entry) => entry.probe.semanticHookCount),
  surfaceCounts: diagnostics.targets.map((entry) => entry.diagnostics.surfaces.length),
}, null, 2));
