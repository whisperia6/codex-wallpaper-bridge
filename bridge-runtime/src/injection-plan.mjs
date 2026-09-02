import { buildApplyScript, buildBootstrapScript } from "./injected-renderer.mjs";

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
    return number <= 3 ? number * 100 : number;
  };
  const rawDim = effects.dim ?? effects.darkness;
  const dimNumber = Number(rawDim);
  return {
    brightness: asPercent(effects.brightness, 82),
    saturation: asPercent(effects.saturation, 105),
    dim: Number.isFinite(dimNumber) ? (dimNumber <= 1 ? dimNumber * 100 : dimNumber) : 28,
    blur: Number(effects.blur) || 0,
    fit: effects.fit || "cover",
    position: effects.position || "50% 50%",
    playing: effects.playing !== false,
    pauseWhenHidden: effects.pauseWhenHidden !== false,
    glassOpacity: Number(effects.glassOpacity) || 62,
    glassBlur: Number(effects.glassBlur) || 18
  };
}

export async function fetchPublicInventory(server) {
  const response = await fetch(new URL("api/inventory", server.baseUrl));
  if (!response.ok) throw new Error(`壁纸 API 返回 HTTP ${response.status}`);
  return response.json();
}

export function buildInjectionPlan({ server, config, inventory }) {
  if (!server?.origin || !server?.basePath) throw new Error("本机壁纸服务尚未启动");
  const projects = inventory?.projects || inventory?.items || [];
  const selected = projects.find((project) => project.id === config?.selectedId) || projects[0] || null;
  let wallpaper = null;

  if (selected) {
    const previewUrl = streamAssetUrl(selected.previewUrl, server);
    const mediaUrl = streamAssetUrl(selected.mediaUrl, server);
    const webUrl = streamAssetUrl(selected.webUrl, server);
    if (selected.type === "video" && mediaUrl) {
      wallpaper = { ...selected, playable: "video", mediaUrl, previewUrl };
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
    config: { ...config, effects: rendererEffects(config) }
  };
  const bootstrapScript = buildBootstrapScript();
  const applyScript = buildApplyScript(payload);
  return {
    bootstrapScript,
    applyScript,
    metrics: {
      bootstrapBytes: Buffer.byteLength(bootstrapScript, "utf8"),
      applyBytes: Buffer.byteLength(applyScript, "utf8"),
      wallpaperId: wallpaper?.id || null,
      wallpaperType: wallpaper?.type || null
    }
  };
}

export async function buildCurrentInjection(server, configStore) {
  const [inventory, config] = await Promise.all([
    fetchPublicInventory(server),
    configStore.get()
  ]);
  return buildInjectionPlan({ server, config, inventory });
}
