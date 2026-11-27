import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildProxyEnvironment,
  defaultCdpPort,
  extractPreservedLaunchArgs,
  extractTargetOrigin,
  hostDisplayName,
  inferHostTypeFromPath,
  installationHostType,
  isAllowedHostOrigin,
  isValidTargetUrlForHost,
  normalizeHostType,
} from "../bridge-runtime/src/host-profiles.mjs";
import { createSceneServer } from "../bridge-runtime/src/scene-server.mjs";
import { invokeBridgeAction } from "../src/bridge-runner.mjs";
import {
  isAuxiliaryTarget,
  scoreAntigravityTarget,
  selectCodexTargets,
} from "../src/cdp-client.mjs";
import {
  buildCodexArguments,
  launchCodex,
  profileDirectoryName,
} from "../src/codex-launcher.mjs";
import {
  buildCompatibilityRestoreScript,
  buildCompatibilityScript,
} from "../src/compatibility-script.mjs";
import { normalizeInstallations } from "../src/installations.mjs";
import { CdpWallpaperInjector } from "../bridge-overrides/src/cdp-injector.mjs";
import { buildBootstrapScript } from "../bridge-overrides/src/injected-renderer.mjs";
import { buildInjectionPlan } from "../bridge-overrides/src/injection-plan.mjs";

test("Codex and Antigravity have distinct default CDP ports", () => {
  assert.equal(defaultCdpPort("codex"), 9335);
  assert.equal(defaultCdpPort("antigravity"), 9336);
  assert.equal(defaultCdpPort(), 9335);
});

test("host-profiles normalizes host types and strictly validates Antigravity loopback HTTPS origins", () => {
  assert.equal(normalizeHostType(undefined), "codex");
  assert.equal(normalizeHostType("codex", { strict: true }), "codex");
  assert.equal(normalizeHostType("antigravity", { strict: true }), "antigravity");
  assert.throws(() => normalizeHostType("vscode", { strict: true }), /不支持的目标宿主类型/);

  assert.equal(inferHostTypeFromPath("C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"), "antigravity");
  assert.equal(inferHostTypeFromPath("D:\\Work\\Codex\\ChatGPT.exe"), "codex");
  assert.equal(installationHostType({ path: "D:\\Apps\\Antigravity.exe" }), "antigravity");
  assert.equal(installationHostType({ hostType: "antigravity", path: "D:\\Apps\\Custom.exe" }), "antigravity");
  assert.equal(hostDisplayName("antigravity"), "Antigravity");
  assert.equal(hostDisplayName("codex"), "Codex");

  assert.equal(isValidTargetUrlForHost("https://127.0.0.1:54155/onboarding?login=true", "antigravity"), true);
  assert.equal(isValidTargetUrlForHost("https://127.0.0.1:54155/#t=abc", "antigravity"), true);
  assert.equal(isValidTargetUrlForHost("data:text/html,<html></html>", "antigravity"), false);
  assert.equal(isValidTargetUrlForHost("http://127.0.0.1:54155/", "antigravity"), false);
  assert.equal(isValidTargetUrlForHost("https://127.0.0.1/", "antigravity"), false);
  assert.equal(isValidTargetUrlForHost("https://localhost:54155/", "antigravity"), false);
  assert.equal(isValidTargetUrlForHost("https://example.com:443/", "antigravity"), false);
  assert.equal(isValidTargetUrlForHost("app://-/index.html", "antigravity"), false);

  assert.equal(extractTargetOrigin("https://127.0.0.1:54155/onboarding?login=true", "antigravity"), "https://127.0.0.1:54155");
  assert.equal(extractTargetOrigin("app://-/index.html", "codex"), "app://-");
  assert.equal(isAllowedHostOrigin("https://127.0.0.1:54155", "antigravity"), true);
  assert.equal(isAllowedHostOrigin("https://127.0.0.1:54155", "codex"), false);
});

test("extractPreservedLaunchArgs keeps only allowlisted proxy flags and drops arbitrary switches", () => {
  const args = extractPreservedLaunchArgs([
    '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --proxy-server=http://127.0.0.1:10808 --remote-debugging-port=9999 --evil-flag=1',
    '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --proxy-bypass-list "localhost;127.0.0.1" --proxy-server=http://127.0.0.1:9999',
  ]);
  assert.deepEqual(args, [
    "--proxy-server=http://127.0.0.1:10808",
    "--proxy-bypass-list=localhost;127.0.0.1",
  ]);
  assert.deepEqual(
    extractPreservedLaunchArgs(['"Antigravity.exe" --proxy-server="http://127.0.0.1:10808 & calc.exe"']),
    [],
  );
});

test("normalizeInstallations discovers Antigravity alongside Codex and merges running processes", () => {
  const installations = normalizeInstallations({
    storePackages: [{
      Name: "OpenAI.Codex",
      Version: "151.0.8000.10",
      InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_151",
    }],
    localInstallations: [{
      ExecutablePath: "C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe",
      ProductVersion: "2.34.0.0",
      HostType: "antigravity",
    }],
    runningProcesses: [{
      ExecutablePath: "c:\\users\\demo\\appdata\\local\\programs\\antigravity\\antigravity.exe",
      ProductVersion: "2.34.0.0",
      HostType: "antigravity",
      ProcessId: 12092,
    }],
  });

  assert.equal(installations.length, 2);
  assert.equal("hostType" in installations[0], false);
  assert.equal(installations[1].hostType, "antigravity");
  assert.equal(installations[1].label, "Antigravity（自动发现）");
  assert.equal(installations[1].isRunning, true);
  assert.deepEqual(installations[1].processIds, [12092]);
});

test("Antigravity launcher uses distinct profile prefix, preserves safe proxy args, and strips ELECTRON_RUN_AS_NODE", async () => {
  const dir = profileDirectoryName("C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe");
  assert.match(dir, /^antigravity-[a-f0-9]{12}$/);

  const args = buildCodexArguments({
    port: 9336,
    profilePath: "C:\\Profiles\\antigravity-1",
    extraArgs: ["--proxy-server=http://127.0.0.1:10808", "--unsafe-switch=1"],
  });
  assert.deepEqual(args, [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9336",
    "--user-data-dir=C:\\Profiles\\antigravity-1",
    "--proxy-server=http://127.0.0.1:10808",
    "--proxy-bypass-list=localhost;127.0.0.1;[::1];*.local",
  ]);

  const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  let capturedSpawn = null;
  let readyCalls = 0;
  try {
    await launchCodex({
      installation: {
        hostType: "antigravity",
        path: "C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe",
        isRunning: false,
      },
      port: 9336,
      profileRoot: "C:\\Profiles",
      extraArgs: ["--proxy-server=http://127.0.0.1:10808"],
      isEndpointReady: async () => ++readyCalls >= 2,
      validateExecutableFn: async (value) => value,
      mkdirFn: async () => {},
      spawnImpl: (file, spawnArgs, options) => {
        capturedSpawn = { file, spawnArgs, options };
        return { pid: 5555, unref() {}, kill() {} };
      },
    });
  } finally {
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
  }

  assert.ok(capturedSpawn);
  assert.equal("ELECTRON_RUN_AS_NODE" in capturedSpawn.options.env, false);
  assert.equal(capturedSpawn.options.env.HTTP_PROXY, "http://127.0.0.1:10808");
  assert.equal(capturedSpawn.options.env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.match(capturedSpawn.options.env.NO_PROXY, /127\.0\.0\.1/);
  assert.ok(capturedSpawn.spawnArgs.includes("--proxy-server=http://127.0.0.1:10808"));
  assert.ok(capturedSpawn.spawnArgs.some((arg) => arg.includes("antigravity-")));

  const proxyEnv = buildProxyEnvironment(
    ["--proxy-server=127.0.0.1:10808", "--proxy-bypass-list=*.internal;<-loopback>"],
    {},
  );
  assert.equal(proxyEnv.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.match(proxyEnv.NO_PROXY, /127\.0\.0\.1/);
  assert.match(proxyEnv.NO_PROXY, /\*\.internal/);
  assert.doesNotMatch(proxyEnv.NO_PROXY, /<-loopback>/);
});

test("Antigravity target scoring selects https://127.0.0.1:<port> main window and ignores data: splash pages", () => {
  const mainTarget = {
    id: "agy-main",
    type: "page",
    title: "Antigravity",
    url: "https://127.0.0.1:54155/onboarding?login=true",
    webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/agy-main",
  };
  const splashTarget = {
    id: "agy-splash",
    type: "page",
    title: "data:text/html,...",
    url: "data:text/html;charset=utf-8,<html></html>",
    webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/agy-splash",
  };
  const unrelatedTarget = {
    id: "other",
    type: "page",
    title: "Local Dev",
    url: "https://127.0.0.1:8443/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/other",
  };

  assert.equal(isAuxiliaryTarget(splashTarget, { hostType: "antigravity" }), true);
  assert.equal(isAuxiliaryTarget(mainTarget, { hostType: "antigravity" }), false);
  assert.ok(scoreAntigravityTarget(mainTarget, { hasRoot: true, antigravityHookCount: 3, descendantCount: 57 }) >= 10);
  assert.ok(scoreAntigravityTarget(unrelatedTarget, { hasRoot: false, antigravityHookCount: 0, descendantCount: 5 }) < 10);

  const selected = selectCodexTargets([
    { target: mainTarget, probe: { hasRoot: true, antigravityHookCount: 3, descendantCount: 57 } },
    { target: splashTarget, probe: { hasRoot: false, antigravityHookCount: 0, descendantCount: 4 } },
    { target: unrelatedTarget, probe: { hasRoot: false, antigravityHookCount: 0, descendantCount: 5 } },
  ], 10, { hostType: "antigravity" });
  assert.deepEqual(selected.map(({ target }) => target.id), ["agy-main"]);
});

test("scene server accepts exact https://127.0.0.1:<port> only with allowHttpsLoopback opt-in", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cwb-agy-scene-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "project.json"), JSON.stringify({ type: "scene", file: "scene.json" }));
  await writeFile(path.join(projectRoot, "scene.pkg"), "PKGV0001-test-payload");

  const server = createSceneServer({
    project: { id: "scene", type: "scene", rootPath: projectRoot },
    parentOrigin: "https://127.0.0.1:54155",
    allowHttpsLoopback: true,
  });
  await server.start();
  t.after(() => server.close());

  const response = await fetch(server.rendererUrl);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors https:\/\/127\.0\.0\.1:54155;/);
  const capability = new URL(server.resourceBase).pathname.split("/")[1];
  const config = await (await fetch(`${server.origin}/${capability}/bridge-config.json`)).json();
  assert.equal(config.parentOrigin, "https://127.0.0.1:54155");

  for (const badOrigin of [
    "https://127.0.0.1",
    "https://127.0.0.1:0",
    "https://localhost:54155",
    "https://127.0.0.2:54155",
    "https://127.0.0.1:54155/",
    "https://user@127.0.0.1:54155",
  ]) {
    assert.throws(
      () => createSceneServer({ project: { type: "scene", rootPath: projectRoot }, parentOrigin: badOrigin, allowHttpsLoopback: true }),
      /parent|URL/,
      badOrigin,
    );
  }
});

test("invokeBridgeAction forwards validated hostType and rejects unknown hostType", async (context) => {
  const received = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const controlUrl = "http://127.0.0.1:43123/1234567890abcdef1234567890abcdef/";
  await invokeBridgeAction({ controlUrl, action: "inject", adaptive: true, hostType: "antigravity" });
  await invokeBridgeAction({ controlUrl, action: "restore", hostType: "antigravity" });
  assert.deepEqual(received, [
    { action: "inject", adaptive: true, hostType: "antigravity" },
    { action: "restore", hostType: "antigravity" },
  ]);
  await assert.rejects(
    invokeBridgeAction({ controlUrl, action: "inject", hostType: "unknown-app" }),
    /不支持的目标宿主类型/,
  );
});

test("Antigravity bootstrap script validates https://127.0.0.1:<port> origin and manages theme without Codex electronBridge", async () => {
  const script = buildBootstrapScript({ hostType: "antigravity" });
  const runAt = (origin) => {
    const context = {
      location: { origin },
      performance: { now: () => 0 },
      document: {
        documentElement: { setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} }, classList: { contains: () => false, toggle() {} }, dataset: {} },
        head: { appendChild() {} },
        body: null,
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
        addEventListener() {},
        removeEventListener() {},
        hidden: false,
      },
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
      Promise,
    };
    context.globalThis = context;
    context.parent = context;
    return runInNewContext(script, context);
  };

  const allowed = await runAt("https://127.0.0.1:54155");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ready, true);
  assert.equal(allowed.hostType, "antigravity");

  const rejectedCodexOrigin = await runAt("app://-");
  assert.equal(rejectedCodexOrigin.ok, false);
  const rejectedExternalOrigin = await runAt("https://example.com:443");
  assert.equal(rejectedExternalOrigin.ok, false);

  const plan = buildInjectionPlan({
    server: { origin: "http://127.0.0.1:43123", basePath: "/1234567890abcdef123456" },
    config: { selectedId: "img1", effects: {} },
    inventory: { projects: [{ id: "img1", type: "image", mediaUrl: "/1234567890abcdef123456/img.png", previewUrl: "/1234567890abcdef123456/img.png" }] },
    hostType: "antigravity",
  });
  assert.equal(plan.hostType, "antigravity");
  assert.match(plan.bootstrapScript, /"antigravity"/);
});

test("Antigravity compatibility script unifies seamless shell, applies frosted sidebar & composer, protects portals/pet, and restores cleanly", () => {
  const script = buildCompatibilityScript({ adaptive: true, hostType: "antigravity" });
  assert.match(script, /\.agy-inset-shell/);
  assert.match(script, /\.agy-sheet/);
  assert.match(script, /--shell-canvas:\s*transparent/);
  assert.match(script, /--card-gap:\s*0px/);
  assert.match(script, /--card-edge:\s*transparent/);
  assert.match(script, /\[data-main-content-body\]/);
  assert.match(script, /\[role="navigation"\]\[aria-label="Sidebar"\][\s\S]*?backdrop-filter:\s*blur\(var\(--cwb-sidebar-blur,\s*16px\)\)/);
  assert.match(script, /\[data-cwb-sidebar-blur="off"\][\s\S]*?\[role="navigation"\]\[aria-label="Sidebar"\][\s\S]*?backdrop-filter:\s*none/);
  assert.match(script, /\[role=navigation\]\[aria-label=Sidebar\]/);
  assert.match(script, /\.surface-composer > \.surface-composer-card/);
  assert.match(script, /\.agy-user-bubble/);
  assert.match(script, /button\[data-project-card="true"\]/);
  assert.match(script, /\.pointer-events-none\.bottom-0/);
  assert.match(script, /setTitleBarOverlay/);
  assert.doesNotMatch(script, /\[data-testid\*="sidebar" i\]\) :is\(\s*button/);
  assert.match(script, /#gemini-neko-pet-root/);
  assert.match(script, /\[data-base-ui-portal\]/);
  assert.match(script, /hostType: "antigravity"/);
  assert.match(buildCompatibilityRestoreScript(), /__codexWallpaperElectronCompat/);
});

test("CdpWallpaperInjector filters targets and records targetOrigin for Antigravity", async (context) => {
  context.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ([
      { id: "splash", type: "page", title: "splash", url: "data:text/html,<html></html>", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/splash" },
      { id: "main", type: "page", title: "Antigravity", url: "https://127.0.0.1:54155/onboarding?login=true", webSocketDebuggerUrl: "ws://127.0.0.1:9336/devtools/page/main" },
    ]),
  }));
  const injector = new CdpWallpaperInjector({ port: 9336, hostType: "antigravity" });
  const targets = await injector.listTargets();
  assert.deepEqual(targets.map((t) => t.id), ["main"]);
});

test("occluded Antigravity video slot resolves via decoded fallback when requestVideoFrameCallback is withheld", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolvePlayback } = await import("../bridge-runtime/src/playback-policy.mjs");
  const source = await readFile(new URL("../bridge-overrides/src/injected-renderer.mjs", import.meta.url), "utf8");
  const factory = source.slice(source.indexOf("const createMedia ="), source.indexOf("const mediaSwitcher ="));
  const handlers = new Map();
  let frameCallbackCount = 0;
  const video = {
    style: {},
    paused: true,
    videoWidth: 3840,
    readyState: 2,
    addEventListener: (name, fn) => handlers.set(name, fn),
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    requestVideoFrameCallback: () => { frameCallbackCount += 1; /* withheld by DWM occlusion */ },
    removeAttribute() {},
    remove() {},
    load() {},
  };
  const root = { insertBefore() {}, append() {} };
  const context = {
    document: { hidden: false, getElementById: () => root, createElement: () => video },
    nativeEnabled: true,
    directSceneEnabled: true,
    ensureRoot: () => root,
    ids: { media: "media", scrim: "scrim" },
    resolvePlayback,
    updateMediaState() {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    performance: { now: () => 0 },
    console,
    JSON,
  };
  context.globalThis = context;
  context.window = context;
  const create = runInNewContext(`${factory}\ncreateMedia`, context);
  const slot = create({
    wallpaper: { id: "3720446142", type: "video", playable: "video", mediaUrl: "http://127.0.0.1:65010/t/api/video/3720446142" },
    effects: { playing: true, pauseWhenHidden: true, fit: "cover", position: "50% 50%", zoom: 100, volume: 50, playbackRate: 1 },
  }, { revision: 2, initial: false });
  handlers.get("loadeddata")();
  assert.equal(frameCallbackCount, 1);
  const settledInTime = await Promise.race([
    slot.ready.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 600)),
  ]);
  assert.equal(settledInTime, true);
  slot.release();
});
