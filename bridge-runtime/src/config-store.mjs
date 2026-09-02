import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Configuration shared by the preview UI and the injector.  Keeping the
 * defaults here (rather than in the UI) makes headless use deterministic.
 */
export const DEFAULT_CONFIG = Object.freeze({
  selectedId: null,
  effects: Object.freeze({
    brightness: 72,
    darkness: 22,
    // `dim` is the renderer-facing alias for the UI's `darkness` control.
    dim: 22,
    blur: 0,
    saturation: 100,
    fit: 'cover',
    position: '50% 50%',
    glassOpacity: 62,
    glassBlur: 18,
    pauseWhenHidden: true,
    playing: true,
  }),
});

const FIT_VALUES = new Set(['cover', 'contain', 'fill']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
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
  const position = typeof effects.position === 'string'
    && effects.position.length <= 100
    && /^(?:left|center|right|top|bottom|\d{1,3}%)(?:\s+(?:left|center|right|top|bottom|\d{1,3}%))?$/i.test(effects.position.trim())
    ? effects.position.trim()
    : (typeof baseEffects.position === 'string' ? baseEffects.position : DEFAULT_CONFIG.effects.position);

  return {
    selectedId,
    effects: {
      brightness: finiteNumber(effects.brightness, baseEffects.brightness ?? 72, 10, 160),
      darkness,
      dim: darkness,
      blur: finiteNumber(effects.blur, baseEffects.blur ?? 0, 0, 40),
      saturation: finiteNumber(effects.saturation, baseEffects.saturation ?? 100, 0, 240),
      fit,
      position,
      glassOpacity: finiteNumber(effects.glassOpacity, baseEffects.glassOpacity ?? 62, 0, 100),
      glassBlur: finiteNumber(effects.glassBlur, baseEffects.glassBlur ?? 18, 0, 60),
      pauseWhenHidden: typeof effects.pauseWhenHidden === 'boolean'
        ? effects.pauseWhenHidden
        : (typeof baseEffects.pauseWhenHidden === 'boolean' ? baseEffects.pauseWhenHidden : true),
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

  const next = {
    selectedId: value.selectedId !== undefined
      ? value.selectedId
      : (value.wallpaperId !== undefined ? value.wallpaperId : before.selectedId),
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

  constructor({ filePath = defaultConfigPath(), defaults = DEFAULT_CONFIG } = {}) {
    this.#filePath = path.resolve(filePath);
    this.#defaults = normalizeConfig(defaults, DEFAULT_CONFIG);
    this.#config = clone(this.#defaults);
  }

  get filePath() {
    return this.#filePath;
  }

  /** Load an existing file. Missing or malformed files fall back to defaults. */
  async load() {
    try {
      const json = JSON.parse(await readFile(this.#filePath, 'utf8'));
      this.#config = normalizeConfig(json, this.#defaults);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.#config = clone(this.#defaults);
    }
    return this.get();
  }

  /** Return an isolated snapshot; callers cannot mutate store state. */
  get() {
    return clone(this.#config);
  }

  async set(patch) {
    this.#config = mergeConfig(this.#config, patch, this.#defaults);
    await this.save();
    return this.get();
  }

  async update(patch) {
    return this.set(patch);
  }

  async replace(config) {
    this.#config = normalizeConfig(config, this.#defaults);
    await this.save();
    return this.get();
  }

  async reset() {
    this.#config = clone(this.#defaults);
    await this.save();
    return this.get();
  }

  /**
   * Serialize and atomically replace the file. Each queued write captures its
   * own snapshot, so a later mutation cannot alter an earlier write midway.
   */
  async save() {
    const snapshot = `${JSON.stringify(this.#config, null, 2)}\n`;
    const filePath = this.#filePath;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(tempPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tempPath, filePath);
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    });
    await this.#writeQueue;
    return this.get();
  }
}

export function createConfigStore(options) {
  return new ConfigStore(options);
}
