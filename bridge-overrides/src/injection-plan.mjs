import { buildApplyScript, buildBootstrapScript } from "./injected-renderer.mjs";
import { eligibleProjects } from "../../bridge-runtime/src/library-policy.mjs";

function absoluteAssetUrl(value, origin) {
  if (!value) return null;
  return new URL(value, origin).href;
}

function streamAssetUrl(value, server) {
  const absolute = absoluteAssetUrl(value, server.origin);
  if (!absolute) return null;
  const source = new URL(absolute);
  const expectedOrigin = new URL(server.origin);
  const pathPrefix = `${server.basePath}/`;
  if (
    source.origin !== expectedOrigin.origin ||
    source.username || source.password || source.hash ||
    expectedOrigin.protocol !== "http:" ||
    expectedOrigin.hostname !== "127.0.0.1" ||
    expectedOrigin.username || expectedOrigin.password ||
    expectedOrigin.pathname !== "/" || expectedOrigin.search || expectedOrigin.hash ||
    !Number.isInteger(Number(expectedOrigin.port)) ||
    !/^\/[A-Za-z0-9_-]{22,}$/.test(server.basePath) ||
    !source.pathname.startsWith(pathPrefix)
  ) {
    throw new Error("媒体 URL 不属于当前本机壁纸服务");
  }
  return source.href;
}

export function rendererEffects(config) {
  const effects = config?.effects || {};
  const asPercent = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return !config?.schemaVersion && number > 0 && number < 3 && !Number.isInteger(number) ? number * 100 : number;
  };
  const rawDim = effects.dim ?? effects.darkness;
  const dimNumber = Number(rawDim);
  return {
    brightness: asPercent(effects.brightness, 82),
    saturation: asPercent(effects.saturation, 105),
    dim: Number.isFinite(dimNumber) ? (!config?.schemaVersion && dimNumber > 0 && dimNumber < 1 ? dimNumber * 100 : dimNumber) : 28,
    blur: Number(effects.blur) || 0,
    fit: effects.fit || "cover",
    position: effects.position || "50% 50%",
    zoom: effects.zoom ?? 100,
    playbackRate: effects.playbackRate ?? 1,
    mirror: effects.mirror === true,
    audioEnabled: effects.audioEnabled === true,
    volume: effects.volume ?? 50,
    contrast: effects.contrast ?? 100,
    opacity: effects.opacity ?? 100,
    playing: effects.playing !== false,
    pauseWhenHidden: effects.pauseWhenHidden !== false,
    pauseOnBattery: effects.pauseOnBattery === true,
    glassOpacity: effects.glassOpacity ?? 62,
    glassBlur: effects.glassBlur ?? 18,
    webLoopHoldSeconds: Math.max(0, Math.min(3600, Math.round(Number(effects.webLoopHoldSeconds) || 0))),
    webForceSingleLoop: effects.webForceSingleLoop === true,
    transition: effects.transition ?? "cut",
    transitionDirection: effects.transitionDirection ?? "left",
    transitionDurationMs: effects.transitionDurationMs ?? 600,
    reduceMotion: effects.reduceMotion === true
  };
}

export async function fetchPublicInventory(server) {
  const response = await fetch(new URL("api/inventory", server.baseUrl));
  if (!response.ok) throw new Error(`壁纸 API 返回 HTTP ${response.status}`);
  return response.json();
}

export function buildInjectionPlan({ server, config, inventory, nativeEnabled = false, directSceneEnabled = false }) {
  if (!server?.origin || !server?.basePath) throw new Error("本机壁纸服务尚未启动");
  const projects = eligibleProjects(inventory?.projects || inventory?.items || [], config);
  const selected = projects.find((project) => project.id === config?.selectedId) || projects[0] || null;
  let wallpaper = null;

  if (selected) {
    const previewUrl = streamAssetUrl(selected.previewUrl, server);
    const mediaUrl = streamAssetUrl(selected.mediaUrl, server);
    const webUrl = streamAssetUrl(selected.webUrl, server);
    if (directSceneEnabled && ["scene", "web"].includes(selected.type)) {
      wallpaper = { id: selected.id, type: selected.type, playable: "direct-gpu", previewUrl };
    } else if (nativeEnabled && ["scene", "web"].includes(selected.type)) {
      wallpaper = { id: selected.id, type: selected.type, playable: "native", previewUrl };
    } else if (selected.type === "video" && mediaUrl) {
      wallpaper = { ...selected, playable: "video", mediaUrl, previewUrl };
    } else if (selected.type === "image" && mediaUrl) {
      wallpaper = { ...selected, playable: "image", mediaUrl, previewUrl };
    } else if (selected.type === "web" && webUrl) {
      wallpaper = { ...selected, playable: "web", mediaUrl: webUrl, previewUrl, webUrl };
    } else {
      wallpaper = {
        ...selected,
        type: selected.type === "application" ? "scene" : selected.type,
        playable: "image",
        mediaUrl: previewUrl,
        previewUrl
      };
    }
  }

  const payload = {
    wallpaper,
    // Resource index and directory are control-plane state, never CDP payload.
    config: { selectedId: config?.selectedId ?? null, effects: rendererEffects(config) }
  };
  const bootstrapScript = buildBootstrapScript({ nativeEnabled, directSceneEnabled });
  const applyScript = buildApplyScript(payload);
  const fallbackScripts = [];
  if (wallpaper?.playable === "direct-gpu") {
    const embeddedVideo = streamAssetUrl(selected.embeddedVideoUrl, server);
    const staticId = config.engineFallbacks?.[selected.id]?.staticId;
    const image = projects.find(project => project.id === staticId && project.type === "image");
    const customStatic = image ? streamAssetUrl(image.mediaUrl, server) : null;
    for (const [reason, kind, source] of [["embedded_video", "video", embeddedVideo], ["custom_static", "image", customStatic], ["preview", "image", wallpaper.previewUrl], ["empty", null, null]]) {
      if (!source && reason !== "empty") continue;
      const fallback = source ? { id: selected.id, type: kind, playable: kind, mediaUrl: source, previewUrl: wallpaper.previewUrl } : null;
      fallbackScripts.push({ reason, script: buildApplyScript({ ...payload, wallpaper: fallback, fallbackReason: reason, waitForMedia: true }) });
    }
  }
  return {
    bootstrapScript,
    applyScript,
    nativeEnabled: nativeEnabled === true,
    nativeWallpaperId: wallpaper?.playable === "native" ? wallpaper.id : null,
    directSceneEnabled: directSceneEnabled === true,
    directSceneId: wallpaper?.playable === "direct-gpu" ? wallpaper.id : null,
    requiresMediaCsp: Boolean(wallpaper?.mediaUrl || wallpaper?.playable === "direct-gpu"),
    fallbackScripts,
    metrics: {
      bootstrapBytes: Buffer.byteLength(bootstrapScript, "utf8"),
      applyBytes: Buffer.byteLength(applyScript, "utf8"),
      wallpaperId: wallpaper?.id || null,
      wallpaperType: wallpaper?.type || null,
      renderer: wallpaper?.playable === "direct-gpu" ? "direct-gpu" : wallpaper?.playable === "native" ? "vp8" : wallpaper?.playable || "none"
    }
  };
}

export async function buildCurrentInjection(server, configStore, options = {}) {
  const [inventory, config] = await Promise.all([
    fetchPublicInventory(server),
    configStore.get()
  ]);
  return buildInjectionPlan({ server, config, inventory, nativeEnabled: options.nativeEnabled === true,
    directSceneEnabled: options.directSceneEnabled === true });
}
