import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeLibrary } from './library-policy.mjs';
import { DEFAULT_PLAYLISTS, normalizePlaylists } from './playlists.mjs';
import { AUTHOR_STATE_LIMITS, normalizeSavedAuthorProperties, updateSavedAuthorProperties } from './author-property-state.mjs';

/**
 * Configuration shared by the preview UI and the injector.  Keeping the
 * defaults here (rather than in the UI) makes headless use deterministic.
 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 4,
  selectedId: null,
  authorProperties: Object.freeze({}),
  media: Object.freeze({ captureAudio: false, nowPlaying: false, allowControl: false, onlineLyrics: false }),
  video: Object.freeze({ faststart: true, useOptimized: false, fpsCap: 30, encoder: 'auto' }),
  cache: Object.freeze({ directory: null }),
  engineFallbacks: Object.freeze({}),
  playlists: DEFAULT_PLAYLISTS,
  library: Object.freeze({
    directory: null, assets: Object.freeze([]), hiddenIds: Object.freeze([]),
    ratings: Object.freeze({}), allowedRatings: Object.freeze(['everyone', 'pg13', 'mature', 'unrated']),
  }),
  effects: Object.freeze({
    brightness: 72,
    darkness: 22,
    // `dim` is the renderer-facing alias for the UI's `darkness` control.
    dim: 22,
    blur: 0,
    saturation: 100,
    fit: 'cover',
    position: '50% 50%',
    positionX: 50,
    positionY: 50,
    zoom: 100,
    playbackRate: 1,
    mirror: false,
    audioEnabled: false,
    volume: 50,
    contrast: 100,
    opacity: 100,
    glassOpacity: 62,
    glassBlur: 18,
    webLoopHoldSeconds: 0,
    webForceSingleLoop: false,
    pauseWhenHidden: true,
    pauseOnBattery: false,
    playing: true,
    transition: 'cut',
    transitionDirection: 'left',
    transitionDurationMs: 600,
    reduceMotion: false,
  }),
});

const FIT_VALUES = new Set(['cover', 'contain', 'fill']);

export function normalizeEngineFallbacks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => id(key) && id(entry?.staticId))
    .slice(0, 128).map(([key, entry]) => [key, { staticId: entry.staticId }]));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function positionAxes(position = '50% 50%') {
  const parts = typeof position === 'string' ? position.trim().toLowerCase().split(/\s+/) : [];
  const axis = (value) => ({ left: 0, top: 0, center: 50, right: 100, bottom: 100 })[value]
    ?? (/^\d{1,3}%$/.test(value ?? '') ? finiteNumber(Number(value.slice(0, -1)), 50, 0, 100) : 50);
  if (parts.length === 1 && ['top', 'bottom'].includes(parts[0])) return [50, axis(parts[0])];
  if (['top', 'bottom'].includes(parts[0])) return [axis(parts[1]), axis(parts[0])];
  return [axis(parts[0]), axis(parts[1])];
}

/**
 * Return a safe, complete config object. Unknown keys are deliberately
 * discarded so a POST body can never become an arbitrary persistence API.
 */
export function normalizeConfig(input = {}, defaults = DEFAULT_CONFIG) {
  const base = defaults && typeof defaults === 'object' ? defaults : DEFAULT_CONFIG;
  const baseEffects = base.effects && typeof base.effects === 'object'
    ? base.effects
    : DEFAULT_CONFIG.effects;
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const effects = value.effects && typeof value.effects === 'object' && !Array.isArray(value.effects)
    ? value.effects
    : {};

  let selectedId = value.selectedId;
  if (selectedId === undefined) selectedId = value.wallpaperId;
  if (selectedId === undefined) selectedId = base.selectedId ?? null;
  if (selectedId !== null && typeof selectedId !== 'string') selectedId = base.selectedId ?? null;
  if (typeof selectedId === 'string') {
    selectedId = selectedId.trim().slice(0, 512) || null;
  }

  const fit = typeof effects.fit === 'string' && FIT_VALUES.has(effects.fit)
    ? effects.fit
    : (FIT_VALUES.has(baseEffects.fit) ? baseEffects.fit : DEFAULT_CONFIG.effects.fit);
  const darkness = finiteNumber(
    effects.darkness ?? effects.dim,
    baseEffects.darkness ?? baseEffects.dim ?? DEFAULT_CONFIG.effects.darkness,
    0,
    90,
  );
  const axes = positionAxes(effects.position ?? baseEffects.position);
  const positionX = finiteNumber(effects.positionX, axes[0], 0, 100);
  const positionY = finiteNumber(effects.positionY, axes[1], 0, 100);
  const position = `${positionX}% ${positionY}%`;
  const cacheDirectory = value.cache && Object.hasOwn(value.cache, 'directory') ? value.cache.directory : (base.cache?.directory ?? null);

  return {
    schemaVersion: DEFAULT_CONFIG.schemaVersion,
    selectedId,
    media: Object.fromEntries(['captureAudio', 'nowPlaying', 'allowControl', 'onlineLyrics'].map(key =>
      [key, typeof value.media?.[key] === 'boolean' ? value.media[key] : base.media?.[key] === true])),
    video: {
      faststart: typeof value.video?.faststart === 'boolean' ? value.video.faststart : base.video?.faststart !== false,
      useOptimized: typeof value.video?.useOptimized === 'boolean' ? value.video.useOptimized : base.video?.useOptimized === true,
      fpsCap: Math.floor(finiteNumber(value.video?.fpsCap, base.video?.fpsCap ?? 30, 1, 120)),
      encoder: ['auto', 'software', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(value.video?.encoder ?? base.video?.encoder)
        ? (value.video?.encoder ?? base.video?.encoder) : 'auto',
    },
    cache: { directory: typeof cacheDirectory === 'string' && path.isAbsolute(cacheDirectory)
      && cacheDirectory.length <= 4096 && !cacheDirectory.includes('\0') ? path.resolve(cacheDirectory) : null },
    authorProperties: normalizeSavedAuthorProperties(value.authorProperties ?? base.authorProperties),
    engineFallbacks: normalizeEngineFallbacks(value.engineFallbacks ?? base.engineFallbacks),
    playlists: normalizePlaylists(value.playlists ?? base.playlists),
    library: normalizeLibrary(value.library ?? base.library),
    effects: {
      brightness: finiteNumber(effects.brightness, baseEffects.brightness ?? 72, 10, 160),
      darkness,
      dim: darkness,
      blur: finiteNumber(effects.blur, baseEffects.blur ?? 0, 0, 40),
      saturation: finiteNumber(effects.saturation, baseEffects.saturation ?? 100, 0, 240),
      fit,
      position,
      positionX,
      positionY,
      zoom: finiteNumber(effects.zoom, baseEffects.zoom ?? 100, 50, 300),
      playbackRate: finiteNumber(effects.playbackRate, baseEffects.playbackRate ?? 1, 0.25, 4),
      volume: finiteNumber(effects.volume, baseEffects.volume ?? 50, 0, 100),
      contrast: finiteNumber(effects.contrast, baseEffects.contrast ?? 100, 0, 240),
      opacity: finiteNumber(effects.opacity, baseEffects.opacity ?? 100, 0, 100),
      transition: ['cut', 'fade', 'push', 'wipe', 'iris', 'zoom', 'stripes'].includes(effects.transition ?? baseEffects.transition)
        ? (effects.transition ?? baseEffects.transition) : 'cut',
      transitionDirection: ['left', 'right', 'up', 'down'].includes(effects.transitionDirection ?? baseEffects.transitionDirection)
        ? (effects.transitionDirection ?? baseEffects.transitionDirection) : 'left',
      transitionDurationMs: finiteNumber(effects.transitionDurationMs, baseEffects.transitionDurationMs ?? 600, 100, 3000),
      reduceMotion: typeof effects.reduceMotion === 'boolean' ? effects.reduceMotion : (baseEffects.reduceMotion ?? false),
      mirror: typeof effects.mirror === 'boolean' ? effects.mirror : (baseEffects.mirror ?? false),
      audioEnabled: typeof effects.audioEnabled === 'boolean' ? effects.audioEnabled : (baseEffects.audioEnabled ?? false),
      glassOpacity: finiteNumber(effects.glassOpacity, baseEffects.glassOpacity ?? 62, 0, 100),
      glassBlur: finiteNumber(effects.glassBlur, baseEffects.glassBlur ?? 18, 0, 60),
      webLoopHoldSeconds: Math.round(finiteNumber(effects.webLoopHoldSeconds, baseEffects.webLoopHoldSeconds ?? 0, 0, 3600)),
      webForceSingleLoop: typeof effects.webForceSingleLoop === 'boolean' ? effects.webForceSingleLoop : (baseEffects.webForceSingleLoop === true),
      pauseWhenHidden: typeof effects.pauseWhenHidden === 'boolean'
        ? effects.pauseWhenHidden
        : (typeof baseEffects.pauseWhenHidden === 'boolean' ? baseEffects.pauseWhenHidden : true),
      pauseOnBattery: typeof effects.pauseOnBattery === 'boolean' ? effects.pauseOnBattery : baseEffects.pauseOnBattery === true,
      playing: typeof effects.playing === 'boolean'
        ? effects.playing
        : (typeof baseEffects.playing === 'boolean' ? baseEffects.playing : true),
    },
  };
}

/** Merge the supported patch keys while retaining omitted effect values. */
export function mergeConfig(current, patch, defaults = DEFAULT_CONFIG) {
  const before = normalizeConfig(current, defaults);
  const value = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const patchEffects = value.effects && typeof value.effects === 'object' && !Array.isArray(value.effects)
    ? { ...value.effects }
    : {};
  if (patchEffects.darkness !== undefined) patchEffects.dim = patchEffects.darkness;
  else if (patchEffects.dim !== undefined) patchEffects.darkness = patchEffects.dim;
  if (patchEffects.position !== undefined) {
    const axes = positionAxes(patchEffects.position);
    patchEffects.positionX ??= axes[0];
    patchEffects.positionY ??= axes[1];
  }

  const next = {
    video: { ...before.video, ...(value.video && typeof value.video === 'object' && !Array.isArray(value.video) ? value.video : {}) },
    cache: { ...before.cache, ...(value.cache && typeof value.cache === 'object' && !Array.isArray(value.cache) ? value.cache : {}) },
    media: { ...before.media, ...(value.media && typeof value.media === 'object' && !Array.isArray(value.media) ? value.media : {}) },
    authorProperties: value.authorProperties ?? before.authorProperties,
    engineFallbacks: value.engineFallbacks ?? before.engineFallbacks,
    selectedId: value.selectedId !== undefined
      ? value.selectedId
      : (value.wallpaperId !== undefined ? value.wallpaperId : before.selectedId),
    library: { ...before.library, ...(value.library && typeof value.library === 'object'
      && !Array.isArray(value.library) ? value.library : {}) },
    playlists: { ...before.playlists, ...(value.playlists && typeof value.playlists === 'object'
      && !Array.isArray(value.playlists) ? value.playlists : {}) },
    effects: {
      ...before.effects,
      ...patchEffects,
    },
  };
  return normalizeConfig(next, defaults);
}

export function defaultConfigPath({ platform = process.platform, env = process.env } = {}) {
  const base = platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'CodexWallpaperBridge', 'config.json');
}

export class ConfigStore {
  #filePath;
  #defaults;
  #config;
  #writeQueue = Promise.resolve();
  #loadError = null;
  #legacySnapshot = null;
  #revision = 0;
  #authorRevisionBase = 0;
  #authorRevisions = new Map();

  constructor({ filePath = defaultConfigPath(), defaults = DEFAULT_CONFIG } = {}) {
    this.#filePath = path.resolve(filePath);
    this.#defaults = normalizeConfig(defaults, DEFAULT_CONFIG);
    this.#config = clone(this.#defaults);
  }

  get filePath() {
    return this.#filePath;
  }

  get revision() { return this.#revision; }

  /** Author CAS is per wallpaper, independent of selection/effect saves. */
  authorPropertiesRevision(id) { return this.#authorRevisions.get(id) ?? this.#authorRevisionBase; }

  /** Missing files use defaults; unreadable/future configs must not be overwritten. */
  load() {
    return this.#queue(() => this.#load());
  }

  async #load() {
    this.#loadError = null;
    this.#legacySnapshot = null;
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      let json;
      try {
        json = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch {
        throw new Error('配置文件无法解析，已保留原文件；请修复后重新加载');
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('配置文件必须是对象，已保留原文件');
      }
      const version = json.schemaVersion;
      if (version !== undefined && (!Number.isInteger(version) || version < 0)) {
        throw new Error('配置版本无效，已保留原文件');
      }
      if (version > DEFAULT_CONFIG.schemaVersion) {
        throw new Error(`配置版本 ${version} 高于当前支持版本 ${DEFAULT_CONFIG.schemaVersion}，已保留原文件`);
      }
      this.#config = normalizeConfig(json, this.#defaults);
      if (version === undefined || version < DEFAULT_CONFIG.schemaVersion) {
        this.#legacySnapshot = raw;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#loadError = error;
        throw error;
      }
      this.#config = clone(this.#defaults);
    }
    this.#revision++;
    this.#authorRevisions.clear(); this.#authorRevisionBase = this.#revision;
    return this.get();
  }

  /** Return an isolated snapshot; callers cannot mutate store state. */
  get() {
    return clone(this.#config);
  }

  async set(patch, { ifRevision } = {}) {
    const snapshot = clone(patch);
    return this.#enqueue(() => {
      if (ifRevision !== undefined && ifRevision !== this.#revision) {
        throw Object.assign(new Error('配置已更新，忽略过期媒体反馈'), { statusCode: 409 });
      }
      return mergeConfig(this.#config, snapshot, this.#defaults);
    });
  }

  async update(patch) {
    return this.set(patch);
  }

  setAuthorProperties(id, values, { ifRevision } = {}) {
    const snapshot = clone(values);
    return this.#enqueue(() => {
      if (ifRevision !== undefined && ifRevision !== this.authorPropertiesRevision(id)) {
        throw Object.assign(new Error('配置已更新，请重新读取作者属性'), { statusCode: 409 });
      }
      return { ...this.#config, authorProperties: updateSavedAuthorProperties(this.#config.authorProperties, id, snapshot) };
    }, id);
  }

  async replace(config) {
    const snapshot = clone(config);
    return this.#enqueue(() => normalizeConfig(snapshot, this.#defaults));
  }

  async reset() {
    return this.replace(this.#defaults);
  }

  /**
   * Commit in-memory state only after the disk write succeeds. Queue merging
   * against committed state keeps concurrent patches from losing each other.
   */
  #enqueue(nextConfig, authorId = null) {
    return this.#queue(async () => {
      if (this.#loadError) throw this.#loadError;
      const before = this.#config;
      const next = nextConfig();
      await this.#persist(next);
      this.#config = next;
      this.#revision++;
      const ids = new Set([...Object.keys(before.authorProperties), ...Object.keys(next.authorProperties)]);
      if (authorId !== null) ids.add(authorId);
      for (const id of ids) {
        if (id !== authorId && JSON.stringify(before.authorProperties[id]) === JSON.stringify(next.authorProperties[id])) continue;
        // Retain bounded tombstones for ABA. Exhaustion invalidates old tokens,
        // never revives one by evicting a record back to its original version.
        if (!this.#authorRevisions.has(id) && this.#authorRevisions.size >= AUTHOR_STATE_LIMITS.wallpapers) {
          this.#authorRevisions.clear(); this.#authorRevisionBase = this.#revision;
        }
        this.#authorRevisions.set(id, this.#revision);
      }
      return this.get();
    });
  }

  #queue(action) {
    const operation = this.#writeQueue.catch(() => {}).then(action);
    this.#writeQueue = operation;
    return operation;
  }

  async #persist(config) {
    const snapshot = `${JSON.stringify(config, null, 2)}\n`;
    const filePath = this.#filePath;
    await mkdir(path.dirname(filePath), { recursive: true });
    if (this.#legacySnapshot !== null) {
      const backupPath = `${filePath}.legacy-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`;
      await writeFile(backupPath, this.#legacySnapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.#legacySnapshot = null;
    }
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async save() {
    return this.#enqueue(() => this.get());
  }
}

export function createConfigStore(options) {
  return new ConfigStore(options);
}
