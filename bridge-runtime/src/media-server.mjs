import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DEFAULT_CONFIG, mergeConfig, normalizeConfig } from './config-store.mjs';
import { AssetLibrary } from './asset-library.mjs';
import { CONTENT_RATINGS, eligibleProjects, projectPolicy } from './library-policy.mjs';
import { PlaylistController } from './playlist-controller.mjs';
import { PLAYLIST_LIMITS } from './playlists.mjs';
import { AuthorPropertyController } from './author-property-controller.mjs';
import { AuthorFileStore } from './author-file-store.mjs';
import { updateSavedAuthorProperties } from './author-property-state.mjs';
import { ScenePreviewLeases } from './scene-preview-leases.mjs';
import { openScenePackageVideo } from './scene-inspector.mjs';
import { VideoVersions, layoutChunks } from './video-stream.mjs';
import { ManagedCache } from './managed-cache.mjs';
import { VideoOptimizer, videoOptions } from './video-optimizer.mjs';
import { HOST_TYPES } from './host-profiles.mjs';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
export const MAX_JSON_BODY_BYTES = 64 * 1024;

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function mimeType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function safeText(value, fallback = '', maximum = 1_000) {
  return typeof value === 'string' ? value.slice(0, maximum) : fallback;
}

function projectId(project) {
  const value = project?.id ?? project?.workshopId ?? project?.projectId;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return id && id.length <= 512 ? id : null;
}

function projectRoot(project) {
  return project?.rootPath
    ?? project?.projectRoot
    ?? project?.projectDir
    ?? project?.directory
    ?? project?.root
    ?? null;
}

function previewCandidate(project) {
  return project?.previewPath ?? project?.thumbnailPath ?? project?.previewFile ?? null;
}

function mediaCandidate(project) {
  return project?.mediaPath ?? project?.videoPath ?? project?.videoFile ?? null;
}

function webRootCandidate(project) {
  return project?.webRoot ?? projectRoot(project);
}

function webEntryCandidate(project) {
  return project?.webEntry ?? project?.entryPath ?? project?.entryFile
    ?? (project?.type === 'web' ? mediaCandidate(project) : null);
}

function normalizeProjects(value) {
  const projects = Array.isArray(value) ? value : value?.projects;
  return Array.isArray(projects) ? projects.filter((project) => projectId(project) !== null) : [];
}

function isContained(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function candidatePath(rootPath, candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return null;
  if (path.isAbsolute(candidate)) return path.resolve(candidate);
  if (typeof rootPath !== 'string' || !rootPath) return null;
  return path.resolve(rootPath, candidate);
}

/** Resolve symlinks on both sides before applying the containment check. */
async function containedEntry(rootPath, candidate, { allowDirectory = false } = {}) {
  if (typeof rootPath !== 'string' || !rootPath) return null;
  const unresolved = candidatePath(rootPath, candidate);
  if (!unresolved) return null;

  try {
    const [root, target] = await Promise.all([realpath(path.resolve(rootPath)), realpath(unresolved)]);
    if (!isContained(root, target)) return null;
    const info = await stat(target);
    if (!info.isFile() && !(allowDirectory && info.isDirectory())) return null;
    return { root, path: target, stat: info };
  } catch {
    return null;
  }
}

function json(response, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  response.end(body);
}

function plain(response, statusCode, message, extraHeaders = {}) {
  const body = Buffer.from(message);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  plain(response, 405, 'Method Not Allowed', { Allow: allowed.join(', ') });
}

function parseRange(header, size) {
  if (typeof header !== 'string' || !header) return null;
  if (!header.startsWith('bytes=') || header.includes(',')) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return false;

  const [, first, last] = match;
  if (!first && !last) return false;

  let start;
  let end;
  if (!first) {
    const suffixLength = Number(last);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(first);
    end = last ? Number(last) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    if (start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function sendFile(request, response, entry, { range = false, cache = false, cors = true, headers: extraHeaders = {} } = {}) {
  const method = request.method || 'GET';
  const size = entry.stat.size;
  const headers = {
    'Cache-Control': cache ? 'private, max-age=300' : 'no-store',
    'Content-Type': mimeType(entry.path),
    'Last-Modified': entry.stat.mtime.toUTCString(),
    ...(cors ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    } : {
      'X-Content-Type-Options': 'nosniff',
    }),
    ...extraHeaders,
  };

  let bounds = null;
  if (range) {
    headers['Accept-Ranges'] = 'bytes';
    bounds = parseRange(request.headers.range, size);
    if (bounds === false) {
      response.writeHead(416, {
        ...headers,
        'Content-Range': `bytes */${size}`,
        'Content-Length': 0,
      });
      response.end();
      return;
    }
  }

  const start = bounds?.start ?? 0;
  const end = bounds?.end ?? Math.max(0, size - 1);
  const length = bounds ? end - start + 1 : size;
  if (bounds) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = length;
  response.writeHead(bounds ? 206 : 200, headers);

  if (method === 'HEAD' || size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(entry.path, bounds ? { start, end } : undefined);
  stream.on('error', () => {
    if (!response.headersSent) plain(response, 500, 'Unable to read file');
    else response.destroy();
  });
  request.on('aborted', () => stream.destroy());
  stream.pipe(response);
}

async function readJsonBody(request, maximumBytes = MAX_JSON_BODY_BYTES) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (contentType && !contentType.startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.statusCode = 415;
    throw error;
  }

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    const error = new Error('JSON body is too large');
    error.statusCode = 413;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error('JSON body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError();
    return value;
  } catch {
    const error = new Error('Invalid JSON object');
    error.statusCode = 400;
    throw error;
  }
}

function publicProject(project, basePath) {
  const id = projectId(project);
  const encodedId = encodeURIComponent(id);
  const type = ['image', 'video', 'web', 'scene', 'application'].includes(project.type)
    ? project.type
    : 'scene';
  const hasPreview = Boolean(previewCandidate(project));
  const inferredPlayable = type === 'video' || type === 'image'
    ? Boolean(mediaCandidate(project))
    : (type === 'web' ? Boolean(webEntryCandidate(project)) : false);
  const playable = typeof project.playable === 'boolean' ? project.playable : inferredPlayable;
  const safeSources = new Set(['default', 'my', 'workshop', 'installed', 'imported', 'unknown']);
  const source = safeSources.has(project.source) ? project.source : 'unknown';

  const value = {
    id,
    title: safeText(project.title ?? project.name, `Wallpaper ${id}`, 500),
    type,
    source,
    playable,
    supportsLive: playable,
    previewUrl: hasPreview ? `${basePath}/api/preview/${encodedId}` : null,
    mediaUrl: ['image', 'video'].includes(type) && playable ? `${basePath}/api/${type}/${encodedId}` : null,
    webUrl: type === 'web' && playable ? `${basePath}/api/web/${encodedId}/` : null,
    embeddedVideoUrl: type === 'scene' && (project.embeddedVideoPath || project.embeddedVideoPackage) ? `${basePath}/api/embedded-video/${encodedId}` : null,
  };
  if (/^\d+$/.test(String(project.workshopId ?? ''))) {
    value.workshopId = String(project.workshopId);
  }
  return value;
}

function inventoryStats(projects) {
  const byType = { image: 0, video: 0, web: 0, scene: 0, application: 0 };
  let playable = 0;
  for (const project of projects) {
    if (Object.hasOwn(byType, project.type)) byType[project.type] += 1;
    if (project.playable) playable += 1;
  }
  return { total: projects.length, playable, byType,
    hidden: projects.filter((project) => project.hidden).length,
    eligible: projects.filter((project) => project.eligible).length,
    imported: projects.filter((project) => project.source === 'imported').length };
}

function memoryConfigStore(initialConfig = DEFAULT_CONFIG) {
  let config = normalizeConfig(initialConfig);
  let revision = 0;
  return {
    get revision() { return revision; },
    get() {
      return JSON.parse(JSON.stringify(config));
    },
    async set(patch, { ifRevision } = {}) {
      if (ifRevision !== undefined && ifRevision !== revision) {
        throw Object.assign(new Error('配置已更新，忽略过期媒体反馈'), { statusCode: 409 });
      }
      config = mergeConfig(config, patch);
      revision++;
      return this.get();
    },
    async setAuthorProperties(id, values, { ifRevision } = {}) {
      if (ifRevision !== undefined && ifRevision !== revision) throw Object.assign(new Error('配置已更新，请重新读取作者属性'), { statusCode: 409 });
      config = { ...config, authorProperties: updateSavedAuthorProperties(config.authorProperties, id, values) };
      revision++; return this.get();
    },
  };
}

function publicHostEndpoint(entry) {
  if (!HOST_TYPES.includes(entry?.hostType) || !Number.isInteger(entry.port) || entry.port < 1024 || entry.port > 65535) return null;
  return { hostType: entry.hostType, port: entry.port };
}

function publicHostEndpoints(entries) {
  return entries.slice(0, HOST_TYPES.length).map(publicHostEndpoint).filter(Boolean);
}

function publicActionResult(result) {
  if (result == null) return { ok: true };
  if (typeof result === 'boolean') return { ok: result };
  if (typeof result !== 'object' || Array.isArray(result)) return { ok: true };
  const response = { ok: typeof result.ok === 'boolean' ? result.ok : true };
  if (typeof result.injectorActive === 'boolean') response.injectorActive = result.injectorActive;
  if (Array.isArray(result.activeHosts)) response.activeHosts = publicHostEndpoints(result.activeHosts);
  if (Array.isArray(result.registeredHosts)) response.registeredHosts = publicHostEndpoints(result.registeredHosts);
  if (['direct-gpu', 'vp8', 'preview-only'].includes(result.sceneRenderer)) response.sceneRenderer = result.sceneRenderer;
  if (typeof result.message === 'string') response.message = result.message.slice(0, 2_000);
  if (['string', 'number', 'boolean'].includes(typeof result.status)) response.status = result.status;
  if (Number.isSafeInteger(result.delivered) && result.delivered >= 0 && result.delivered <= 16 * HOST_TYPES.length) response.delivered = result.delivered;
  if (Array.isArray(result.engine)) response.engine = result.engine.slice(0, 2 * HOST_TYPES.length).flatMap((entry) => {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(entry.id)) return [];
    if (entry.renderer === 'direct-gpu') {
      const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : 0;
      return [{ id: entry.id, ...publicHostEndpoint(entry), ...(entry.type === 'web' || entry.type === 'scene' ? { type: entry.type } : {}), renderer: 'direct-gpu', failed: entry.failed === true,
        requestedFps: integer(entry.requestedFps, 60),
        targets: (Array.isArray(entry.targets) ? entry.targets : []).slice(0, 16).flatMap((target) => {
          if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
          return [{ active: target.active === true, preloaded: target.preloaded === true,
            width: integer(target.width, 4096), height: integer(target.height, 4096),
            fps: typeof target.fps === 'number' && Number.isFinite(target.fps) && target.fps >= 0 && target.fps <= 240 ? target.fps : 0,
              pointerReceived: integer(target.pointerReceived, 1e9), pointerForwarded: integer(target.pointerForwarded, 1e9),
              pointerBlocked: ['none', 'inactive', 'released', 'failed', 'unprepared', 'hidden', 'paused', 'control', 'geometry', 'outside'].includes(target.pointerBlocked) ? target.pointerBlocked : 'none',
            renderCompletions: integer(target.renderCompletions, 1e9),
            ...(entry.type === 'web' ? { paintFrames: integer(target.paintFrames, 1e9), animationFrames: integer(target.animationFrames, 1e9) } : {}) }];
        }) }];
    }
    return [{ id: entry.id, ...publicHostEndpoint(entry), paused: entry.paused === true, failed: entry.failed === true,
      delivered: Number.isSafeInteger(entry.delivered) && entry.delivered >= 0 ? entry.delivered : 0,
      samples: (Array.isArray(entry.samples) ? entry.samples : []).slice(-128).flatMap((sample) => {
        const keys = ['sequence', 'acknowledged', 'stateMs', 'controlMs', 'captureMs', 'ackMs', 'totalMs', 'startedAt', 'endedAt'];
        if (!sample || !keys.every((key) => typeof sample[key] === 'number' && Number.isFinite(sample[key]) && sample[key] >= 0)) return [];
        return [Object.fromEntries(keys.map((key) => [key, sample[key]]))];
      }) }];
  });
  // Keep the desktop's per-target compatibility acknowledgement without
  // turning this public endpoint into a pass-through for renderer content.
  if (Array.isArray(result.compatibility)) {
    response.compatibility = result.compatibility.slice(0, 100).flatMap((entry) => {
      if (!entry || typeof entry.targetId !== 'string' || !entry.targetId
        || typeof entry.value?.ok !== 'boolean') return [];
      const value = { ok: entry.value.ok };
      if (typeof entry.value.adaptive === 'boolean') value.adaptive = entry.value.adaptive;
      return [{ targetId: entry.targetId.slice(0, 512), value }];
    });
  }
  return response;
}

export class MediaServer {
  #publicDir;
  #projects;
  #getProjects;
  #configStore;
  #onAction;
  #onConfigChange;
  #server = null;
  #port = null;
  #configLoaded = false;
  #library;
  #playlists;
  #authorProperties;
  #authorFiles;
  #scenePreviews;
  #onScenePreload;
  #media;
  #cache;
  #optimizer;
  #videoVersions = new VideoVersions();
  #videoReaders = new Set();

  constructor({
    projects = [],
    getProjects = null,
    publicDir = DEFAULT_PUBLIC_DIR,
    configStore = null,
    initialConfig = DEFAULT_CONFIG,
    onAction = null,
    onConfigChange = null,
    onAuthorProperties = null,
    onScenePreload = null,
    media = null,
    videoTools = undefined,
    cacheEnv = process.env,
    token = randomBytes(16).toString('hex'),
  } = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22,}$/.test(token)) {
      throw new TypeError('token must contain at least 128 bits encoded as 22+ URL-safe characters');
    }
    if (getProjects !== null && typeof getProjects !== 'function') {
      throw new TypeError('getProjects must be a function');
    }
    if (onAction !== null && typeof onAction !== 'function') {
      throw new TypeError('onAction must be a function');
    }
    if (onConfigChange !== null && typeof onConfigChange !== 'function') {
      throw new TypeError('onConfigChange must be a function');
    }
    if (onScenePreload !== null && typeof onScenePreload !== 'function') throw new TypeError('onScenePreload must be a function');
    this.token = token;
    this.host = LOOPBACK_HOST;
    this.#publicDir = path.resolve(publicDir);
    this.#projects = normalizeProjects(projects);
    this.#getProjects = getProjects;
    this.#configStore = configStore || memoryConfigStore(initialConfig);
    this.#library = this.#configStore.filePath ? new AssetLibrary({ configStore: this.#configStore }) : null;
    this.#onAction = onAction;
    this.#onConfigChange = onConfigChange;
    this.#onScenePreload = onScenePreload;
    this.#media = media;
    this.#cache = this.#configStore.filePath ? new ManagedCache({ configStore: this.#configStore, env: cacheEnv }) : null;
    this.#optimizer = this.#cache ? new VideoOptimizer({ cache: this.#cache, tools: videoTools,
      getSource: async id => (await this.#videoSource(id))?.path ?? null }) : null;
    this.#authorFiles = this.#configStore.filePath ? new AuthorFileStore({ configStore: this.#configStore }) : null;
    this.#authorProperties = new AuthorPropertyController({ configStore: this.#configStore, onAuthorProperties, authorFiles: this.#authorFiles });
    this.#scenePreviews = this.#createScenePreviews();
    this.#playlists = new PlaylistController({ configStore: this.#configStore,
      getProjects: () => this.projects(), busy: () => Boolean(this.#library?.busy),
      apply: (config, patch) => this.#onConfigChange?.(config, patch),
      preload: onScenePreload,
      available: async (project) => {
        const candidate = ['image', 'video'].includes(project.type) ? mediaCandidate(project)
          : project.type === 'web' ? webEntryCandidate(project) : previewCandidate(project);
        const root = projectRoot(project) || (candidate && path.isAbsolute(candidate) ? path.dirname(candidate) : null);
        return Boolean(await containedEntry(root, candidate));
      } });
  }

  get port() {
    return this.#port;
  }
  // Private in-process dependency for GPU delivery, never part of HTTP state.
  get authorFiles() { return this.#authorFiles; }

  get origin() {
    return this.#port === null ? null : `http://${this.host}:${this.#port}`;
  }

  get basePath() {
    return `/${this.token}`;
  }

  get baseUrl() {
    return this.origin === null ? null : `${this.origin}${this.basePath}/`;
  }

  get url() {
    return this.baseUrl;
  }

  address() {
    return this.#port === null
      ? null
      : { host: this.host, port: this.#port, token: this.token, origin: this.origin, baseUrl: this.baseUrl };
  }

  setProjects(projects) {
    this.#projects = normalizeProjects(projects);
    // An explicit replacement takes precedence over a previously supplied
    // provider; this makes rescan -> replaceProjects deterministic.
    this.#getProjects = null;
    return this.#projects.length;
  }

  replaceProjects(projects) {
    return this.setProjects(projects);
  }

  updateProjects(projects) {
    return this.setProjects(projects);
  }

  async projects() {
    const scanned = this.#getProjects ? normalizeProjects(await this.#getProjects()) : this.#projects;
    return [...scanned, ...(await this.#library?.projects() ?? [])];
  }

  async start() {
    if (this.#server) return this;
    if (this.#scenePreviews.status().closed) throw Error('media server is closed');
    if (!this.#configLoaded && typeof this.#configStore?.load === 'function') {
      await this.#configStore.load();
      this.#configLoaded = true;
    }

    const server = createServer((request, response) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) plain(response, 500, 'Internal Server Error');
        else response.destroy();
      });
    });
    // Large uploads use backpressure and an idle timeout, not a total 30 s limit.
    server.requestTimeout = 0;
    server.timeout = 30_000;
    server.headersTimeout = 10_000;

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
        throw new Error('media server did not bind to the IPv4 loopback interface');
      }
      this.#server = server;
      this.#port = address.port;
      await this.#playlists.refresh();
      return this;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async close() {
    const server = this.#server;
    if (!server) return;
    const videoClosing = this.#optimizer?.close(), cacheClosing = this.#cache?.close();
    this.#videoVersions.close();
    for (const reader of this.#videoReaders) reader.destroy();
    const authorsClosing = this.#authorProperties.close(), filesClosing = this.#authorFiles?.close();
    await this.#scenePreviews.close();
    await this.#playlists.close();
    await this.#library?.close();
    await filesClosing;
    await authorsClosing;
    const videoStatus = await videoClosing;
    await cacheClosing;
    this.#server = null;
    this.#port = null;
    server.closeIdleConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (videoStatus && !videoStatus.clean) throw Error('video_process_close_unconfirmed');
  }

  async #handle(request, response) {
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      plain(response, 400, 'Bad Request');
      return;
    }

    const prefix = this.basePath;
    if (url.pathname === prefix) {
      response.writeHead(302, { Location: `${prefix}/`, 'Content-Length': 0 });
      response.end();
      return;
    }
    if (!url.pathname.startsWith(`${prefix}/`)) {
      plain(response, 404, 'Not Found');
      return;
    }

    const route = url.pathname.slice(prefix.length + 1);
    if (!['GET', 'HEAD'].includes(request.method)) {
      // The secret path is not enough if an unrelated page can induce writes.
      const origin = request.headers.origin;
      if ((origin && origin !== this.origin)
        || request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.host && request.headers.host !== new URL(this.origin).host)) {
        json(response, 403, { error: '跨来源写入被拒绝' });
        return;
      }
    }
    if (route === 'api/library' || route.startsWith('api/library/')) {
      await this.#libraryRoute(request, response, route);
      return;
    }
    if (route === 'api/video-tools' || route.startsWith('api/video-tools/')
      || route === 'api/video-jobs' || route.startsWith('api/video-jobs/')
      || route === 'api/cache' || route.startsWith('api/cache/')) {
      await this.#videoTaskRoute(request, response, route); return;
    }
    if (route === 'api/playlists' || route.startsWith('api/playlists/')) {
      await this.#playlistRoute(request, response, route);
      return;
    }
    if (route === 'api/inventory') {
      await this.#inventory(request, response);
      return;
    }
    if (route === 'api/media' || route === 'api/media/control' || route === 'api/media/lyrics') {
      if (!this.#media) { json(response, 503, { error: 'media_unavailable' }); return; }
      try {
        if (route === 'api/media' && request.method === 'GET') { json(response, 200, await this.#media.snapshot()); return; }
        if (route !== 'api/media' && request.method === 'POST') {
          const body = await readJsonBody(request, route.endsWith('/lyrics') ? 800000 : 4096);
          json(response, 200, route.endsWith('/lyrics') ? await this.#media.importLyrics(body) : await this.#media.control(body)); return;
        }
        methodNotAllowed(response, route === 'api/media' ? ['GET'] : ['POST']);
      } catch (error) { json(response, error.statusCode || 409, { error: error.statusCode ? error.message : 'media_operation_unavailable' }); }
      return;
    }
    if (route === 'api/config') {
      await this.#config(request, response);
      return;
    }
    if (route.startsWith('api/author-properties/')) {
      await this.#authorPropertyRoute(request, response, route.slice('api/author-properties/'.length));
      return;
    }
    if (route === 'api/action') {
      await this.#action(request, response);
      return;
    }
    if (route === 'api/scene-preview') {
      await this.#scenePreviewRoute(request, response);
      return;
    }
    if (route === 'api/scene-preload') {
      await this.#scenePreloadRoute(request, response);
      return;
    }
    if (route.startsWith('api/preview/')) {
      await this.#preview(request, response, route.slice('api/preview/'.length));
      return;
    }
    if (route.startsWith('api/embedded-video/')) {
      await this.#video(request, response, route.slice('api/embedded-video/'.length), 'scene');
      return;
    }
    if (route.startsWith('api/video/')) {
      await this.#video(request, response, route.slice('api/video/'.length), 'video', url.searchParams.get('v'));
      return;
    }
    if (route.startsWith('api/image/')) {
      await this.#video(request, response, route.slice('api/image/'.length), 'image');
      return;
    }
    if (route.startsWith('api/web/')) {
      await this.#web(request, response, route.slice('api/web/'.length));
      return;
    }
    if (route.startsWith('api/')) {
      json(response, 404, { error: 'Not Found' });
      return;
    }
    await this.#static(request, response, route);
  }

  async #inventory(request, response) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const config = await this.#configStore.get();
    const projects = await Promise.all((await this.projects()).map(async (project) => {
      const policy = projectPolicy(project, config);
      const value = publicProject(project, this.basePath);
      if (project.type === 'video' && policy.eligible && value.mediaUrl) {
        const candidate = mediaCandidate(project), root = projectRoot(project) || (path.isAbsolute(candidate ?? '') ? path.dirname(candidate) : null);
        const entry = await containedEntry(root, candidate);
        if (entry) {
          const optimized = config.video.useOptimized && this.#optimizer
            ? await this.#optimizer.optimizedFile(value.id, entry.path, { fpsCap: config.video.fpsCap, encoder: config.video.encoder }).catch(() => null) : null;
          try {
            const version = await this.#videoVersions.pin(value.id, optimized || entry.path, { faststart: config.video.faststart });
            value.mediaUrl += `?v=${version}`; value.videoVariant = optimized ? 'optimized' : 'original';
          } catch (error) {
            if (error.message !== 'video_version_capacity') throw error;
            // Existing pinned sessions remain intact; excess inventory entries
            // degrade to the legacy original-only URL instead of a global 500.
            value.videoVariant = 'original'; value.videoVersionAvailable = false;
          }
        } else { value.mediaUrl = null; value.playable = false; }
      }
      return { ...value, ...policy,
        scenePreviewAvailable: ['scene', 'web'].includes(project.type) && policy.eligible };
    }));
    const payload = { projects, items: projects, stats: inventoryStats(projects) };
    if (request.method === 'HEAD') {
      const length = Buffer.byteLength(JSON.stringify(payload));
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': length,
      });
      response.end();
      return;
    }
    json(response, 200, payload);
  }

  async #scenePreviewRoute(request, response) {
    if (request.method !== 'POST') { methodNotAllowed(response, ['POST']); return; }
    try {
      const body = await readJsonBody(request), { op, ...args } = body;
      if (!['open', 'renew', 'close', 'validate'].includes(op)) { json(response, 400, { error: 'preview_invalid' }); return; }
      const value = await this.#scenePreviews[op === 'close' ? 'release' : op](args);
      json(response, 200, value);
    } catch (error) {
      const known = ['preview_invalid', 'preview_closed', 'preview_capacity', 'preview_cancelled', 'preview_unavailable'].includes(error.message);
      const inputError = [400, 413, 415].includes(error.statusCode);
      json(response, known ? error.statusCode : inputError ? error.statusCode : 500,
        { error: known ? error.message : inputError ? 'preview_invalid' : 'preview_unavailable' });
    }
  }

  #createScenePreviews() {
    return new ScenePreviewLeases({ getProject: (id) => this.#findProject(encodeURIComponent(id)),
      getConfig: () => this.#configStore.get(), parentOrigin: () => this.origin, authorFiles: this.#authorFiles });
  }

  async #findProject(encodedId) {
    let id;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      return null;
    }
    const project = (await this.projects()).find((project) => projectId(project) === id);
    if (project?.source === 'imported') {
      try { await this.#library.resolve(project.id); } catch { return null; }
    }
    return project ? { ...project, ...projectPolicy(project, await this.#configStore.get()) } : null;
  }

  async #preview(request, response, encodedId) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const project = await this.#findProject(encodedId);
    if (!project || !(await this.#configStore.get()).library.allowedRatings.includes(project.contentRating)) {
      plain(response, 404, 'Not Found');
      return;
    }
    const candidate = previewCandidate(project);
    const fallbackRoot = typeof candidate === 'string' && path.isAbsolute(candidate) ? path.dirname(candidate) : null;
    const entry = await containedEntry(projectRoot(project) || fallbackRoot, candidate);
    if (!entry) {
      plain(response, 404, 'Not Found');
      return;
    }
    sendFile(request, response, entry, { cache: true });
  }

  async #video(request, response, encodedId, type = 'video', version = null) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const project = await this.#findProject(encodedId);
    if (!project || project.type !== type || !project.eligible) {
      plain(response, 404, 'Not Found');
      return;
    }
    if (type === 'video' && version !== null) {
      await this.#versionedVideo(request, response, projectId(project), version); return;
    }
    const candidate = type === 'scene' ? project.embeddedVideoPath : mediaCandidate(project);
    if (type === 'scene' && !candidate && project.embeddedVideoPackage) {
      const video = await openScenePackageVideo(projectRoot(project)).catch(() => null);
      if (!video) { plain(response, 404, 'Not Found'); return; }
      let streaming = false;
      try {
        const range = parseRange(request.headers.range, video.size);
        const headers = { 'Cache-Control': 'no-store', 'Content-Type': mimeType(video.name),
          'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range' };
        if (range === false) {
          response.writeHead(416, { ...headers, 'Content-Range': `bytes */${video.size}`, 'Content-Length': 0 }); response.end(); return;
        }
        const start = range?.start ?? 0, end = range?.end ?? video.size - 1;
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.size}` } : {}) });
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = video.handle.createReadStream({ start: video.start + start, end: video.start + end, autoClose: true });
        streaming = true;
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy()); stream.pipe(response);
      } finally { if (!streaming) await video.handle.close(); }
      return;
    }
    if (type === 'scene' && (typeof candidate !== 'string' || !['.mp4', '.webm', '.m4v', '.mov'].includes(path.extname(candidate).toLowerCase()))) {
      plain(response, 404, 'Not Found'); return;
    }
    const fallbackRoot = typeof candidate === 'string' && path.isAbsolute(candidate) ? path.dirname(candidate) : null;
    const entry = await containedEntry(projectRoot(project) || fallbackRoot, candidate);
    if (!entry) {
      plain(response, 404, 'Not Found');
      return;
    }
    sendFile(request, response, entry, { range: true });
  }

  async #versionedVideo(request, response, id, version) {
    let video;
    try { video = await this.#videoVersions.open(id, version); }
    catch (error) { json(response, error.statusCode || 404, { error: error.statusCode ? error.message : 'video_version_unavailable' }); return; }
    const { handle, layout } = video, size = layout.size, etag = `"${version}"`;
    try {
      const range = request.headers['if-range'] && request.headers['if-range'] !== etag ? null : parseRange(request.headers.range, size);
      const headers = { 'Cache-Control': 'private, max-age=300', 'Content-Type': mimeType(video.path), 'Accept-Ranges': 'bytes',
        ETag: etag, 'X-CWB-Video-Layout': layout.kind, 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, X-CWB-Video-Layout' };
      if (range === false) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); response.end(); return; }
      const start = range?.start ?? 0, end = range?.end ?? size - 1;
      response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': size ? end - start + 1 : 0,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (request.method === 'HEAD' || !size) { response.end(); return; }
      this.#videoReaders.add(response);
      await pipeline(Readable.from(layoutChunks(handle, layout, start, end)), response).catch(() => { response.destroy(); });
    } finally { this.#videoReaders.delete(response); await handle.close(); }
  }

  async #videoSource(id) {
    const project = await this.#findProject(encodeURIComponent(id));
    if (!project || project.type !== 'video' || !project.eligible) return null;
    const candidate = mediaCandidate(project), root = projectRoot(project) || (path.isAbsolute(candidate ?? '') ? path.dirname(candidate) : null);
    if (!['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'].includes(path.extname(candidate ?? '').toLowerCase())) return null;
    return containedEntry(root, candidate);
  }

  async #videoTaskRoute(request, response, route) {
    if (!this.#optimizer || !this.#cache) { json(response, 503, { error: 'video_cache_requires_persistence' }); return; }
    try {
      if (route === 'api/video-tools' && request.method === 'GET') { json(response, 200, this.#optimizer.status()); return; }
      if (route === 'api/video-tools/probe' && request.method === 'POST') {
        if (this.#optimizer.busy || this.#cache.busy) { json(response, 409, { error: 'video_job_busy' }); return; }
        const body = await readJsonBody(request, 2048);
        if (Object.keys(body).length) { json(response, 400, { error: 'video_options_invalid' }); return; }
        json(response, 200, { capabilities: await this.#optimizer.tools.probeCapabilities({ refresh: true }) }); return;
      }
      if (route === 'api/video-jobs' && request.method === 'GET') { json(response, 200, this.#optimizer.status()); return; }
      if (route === 'api/video-jobs' && request.method === 'POST') {
        const body = await readJsonBody(request, 2048), config = this.#configStore.get();
        if (Object.keys(body).some(k => !['id', 'options'].includes(k)) || typeof body.id !== 'string') { json(response, 400, { error: 'video_options_invalid' }); return; }
        const options = body.options ?? { fpsCap: config.video.fpsCap, encoder: config.video.encoder };
        videoOptions(options);
        if (!await this.#videoSource(body.id)) { json(response, 404, { error: 'video_unavailable' }); return; }
        json(response, 202, { job: this.#optimizer.begin(body.id, options) }); return;
      }
      if (route === 'api/cache' && request.method === 'GET') {
        await this.#cache.init(); json(response, 200, this.#cache.status()); return;
      }
      if (route === 'api/cache/jobs' && request.method === 'POST') {
        const body = await readJsonBody(request, 8192);
        if (Object.keys(body).some(k => k !== 'directory')) { json(response, 400, { error: 'cache_invalid_directory' }); return; }
        json(response, 202, { job: await this.#cache.beginMigration(body.directory) }); return;
      }
      if (route === 'api/cache/resume' && request.method === 'POST') {
        const body = await readJsonBody(request, 2048);
        if (Object.keys(body).length) { json(response, 400, { error: 'cache_invalid_request' }); return; }
        json(response, 202, { job: await this.#cache.resume() }); return;
      }
      const jobRoute = /^api\/(video-jobs|cache\/jobs)\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/.exec(route);
      if (jobRoute) {
        const [, kind, id, action] = jobRoute, owner = kind === 'video-jobs' ? this.#optimizer : this.#cache;
        if (!action && request.method === 'GET') { json(response, 200, { job: owner.job(id) }); return; }
        if (action && request.method === 'POST') {
          const body = await readJsonBody(request, 2048);
          if (Object.keys(body).length) { json(response, 400, { error: 'video_options_invalid' }); return; }
          json(response, action === 'retry' ? 202 : 200, { job: await owner[action](id) }); return;
        }
        methodNotAllowed(response, action ? ['POST'] : ['GET']); return;
      }
      if (['api/video-tools', 'api/video-tools/probe', 'api/video-jobs', 'api/cache', 'api/cache/jobs', 'api/cache/resume'].includes(route)) {
        methodNotAllowed(response, route.endsWith('/probe') || route.endsWith('/resume') || route === 'api/cache/jobs' ? ['POST']
          : route === 'api/video-jobs' ? ['GET', 'POST'] : ['GET']); return;
      }
      json(response, 404, { error: 'Not Found' });
    } catch (error) { json(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'video_cache_operation_failed' }); }
  }

  async #web(request, response, routeTail) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const separator = routeTail.indexOf('/');
    const encodedId = separator === -1 ? routeTail : routeTail.slice(0, separator);
    const encodedResource = separator === -1 ? '' : routeTail.slice(separator + 1);
    const project = await this.#findProject(encodedId);
    if (!project || project.type !== 'web' || !project.eligible) {
      plain(response, 404, 'Not Found');
      return;
    }

    const root = webRootCandidate(project);
    if (typeof root !== 'string' || !root) {
      plain(response, 404, 'Not Found');
      return;
    }

    let requested;
    if (!encodedResource) {
      requested = webEntryCandidate(project) || 'index.html';
    } else {
      try {
        requested = decodeURIComponent(encodedResource);
      } catch {
        plain(response, 400, 'Bad Request');
        return;
      }
    }
    if (typeof requested !== 'string' || requested.includes('\0')) {
      plain(response, 400, 'Bad Request');
      return;
    }

    let entry = await containedEntry(root, requested, { allowDirectory: true });
    if (entry?.stat.isDirectory()) {
      entry = await containedEntry(root, path.join(entry.path, 'index.html'));
    }
    if (!entry || !entry.stat.isFile()) {
      plain(response, 404, 'Not Found');
      return;
    }
    // Range support is useful for video/audio assets embedded by web projects.
    // Apply sandbox + connect-src 'none' on every response (including .svg/.xml)
    // so untrusted Workshop assets can never execute same-origin with the control API.
    sendFile(request, response, entry, {
      range: true,
      cache: true,
      cors: false,
      headers: {
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
      },
    });
  }

  async #scenePreloadRoute(request, response) {
    if (request.method !== 'POST') { methodNotAllowed(response, ['POST']); return; }
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'id')
        || (body.id !== null && (typeof body.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.id)))) {
        json(response, 400, { ok: false, error: '预加载只接受已注册的项目 id 或 null' }); return;
      }
      if (!this.#onScenePreload || (this.#library?.busy && body.id !== null)) { json(response, 200, { ok: true, status: 'skipped' }); return; }
      if (body.id !== null) {
        const config = await this.#configStore.get();
        const project = eligibleProjects(await this.projects(), config).find((item) => item.id === body.id && item.type === 'scene');
        if (!project) { json(response, 404, { ok: false, error: '场景不可预加载' }); return; }
      }
      const result = await this.#onScenePreload(body.id);
      // No descriptor, URL, path, CDP handle or author capability in the response.
      json(response, 200, { ok: true, status: ['preparing', 'busy', 'skipped'].includes(result?.status) ? result.status : 'skipped',
        targets: Number.isSafeInteger(result?.targets) ? Math.max(0, Math.min(32, result.targets)) : 0 });
    } catch (error) { json(response, error.statusCode || 500, { ok: false, error: '场景预加载暂不可用，选择时仍可正常加载' }); }
  }

  async #config(request, response) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const config = normalizeConfig(await this.#configStore.get());
      const payload = { config, defaults: DEFAULT_CONFIG.effects };
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
        });
        response.end();
      } else {
        json(response, 200, payload);
      }
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['GET', 'HEAD', 'POST']);
      return;
    }

    let patch;
    try {
      patch = await readJsonBody(request);
    } catch (error) {
      json(response, error.statusCode || 400, { error: error.message });
      return;
    }
    if (patch.selectedId === undefined && patch.wallpaperId !== undefined) {
      patch.selectedId = patch.wallpaperId;
    }
    if (patch.playlists !== undefined) {
      json(response, 400, { error: '播放列表只能通过专用接口修改' });
      return;
    }
    if (patch.authorProperties !== undefined) {
      json(response, 400, { error: '作者属性只能通过专用接口修改' });
      return;
    }
    if (patch.cache !== undefined) { json(response, 400, { error: '缓存路径只能通过缓存迁移接口修改' }); return; }
    if (patch.video !== undefined) {
      const value = patch.video;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(k => !['faststart', 'useOptimized', 'fpsCap', 'encoder'].includes(k))
        || ['faststart', 'useOptimized'].some(k => value[k] !== undefined && typeof value[k] !== 'boolean')) {
        json(response, 400, { error: 'video_options_invalid' }); return;
      }
      try { videoOptions({ ...(value.fpsCap !== undefined ? { fpsCap: value.fpsCap } : {}),
        ...(value.encoder !== undefined ? { encoder: value.encoder } : {}) }); }
      catch { json(response, 400, { error: 'video_options_invalid' }); return; }
    }
    if (patch.library !== undefined) {
      if (!patch.library || typeof patch.library !== 'object' || Array.isArray(patch.library)
        || Object.keys(patch.library).some((key) => key !== 'allowedRatings')
        || !Array.isArray(patch.library.allowedRatings)
        || patch.library.allowedRatings.some((rating) => !CONTENT_RATINGS.includes(rating))) {
        json(response, 400, { error: '资源索引、路径和元数据只能通过资源库接口修改' });
        return;
      }
    }
    const next = mergeConfig(await this.#configStore.get(), patch);
    const candidates = eligibleProjects(await this.projects(), next);
    if (patch.selectedId && !(candidates.some((project) => project.id === patch.selectedId))) {
      json(response, 409, { error: '该壁纸不存在、已隐藏或被内容规则排除' });
      return;
    }
    if (patch.library && !candidates.some((project) => project.id === next.selectedId)) {
      patch.selectedId = candidates[0]?.id ?? null;
    }

    let config;
    if (typeof this.#configStore.set === 'function') {
      config = await this.#configStore.set(patch);
    } else if (typeof this.#configStore.update === 'function') {
      config = await this.#configStore.update(patch);
    } else {
      const current = await this.#configStore.get();
      config = mergeConfig(current, patch);
      if (typeof this.#configStore.replace === 'function') config = await this.#configStore.replace(config);
    }
    config = normalizeConfig(config);
    if (this.#onConfigChange) await this.#onConfigChange(config, patch);
    await this.#playlists.refresh();
    json(response, 200, { config });
  }

  async #authorPropertyRoute(request, response, encodedId) {
    const upload = /^([^/]+)\/(file|directory-file)\/([^/]+)$/.exec(encodedId);
    if (upload) {
      if (request.method !== 'POST') { methodNotAllowed(response, ['POST']); return; }
      const project = await this.#findProject(upload[1]);
      if (!project || !project.eligible || !['scene', 'web'].includes(project.type)) { json(response, 404, { error: '作者属性元数据不可用' }); return; }
      try {
        const params = new URL(request.url, this.origin).searchParams;
        let key;
        try { key = decodeURIComponent(upload[3]); }
        catch { json(response, 400, { error: '作者文件属性无效' }); return; }
        const size = request.headers['x-cwb-file-size'], revision = params.get('revision');
        if (request.headers['content-type'] !== 'application/octet-stream' || !/^[1-9]\d{0,8}$/.test(size || '')
          || !/^(?:0|[1-9]\d{0,15})$/.test(revision || '') || params.size !== 2 || !params.has('filename')
          || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== size)) {
          json(response, 400, { error: '作者文件上传请求无效' }); return;
        }
        const state = await this.#authorProperties.upload(project, key, request, { filename: params.get('filename'), size: Number(size), revision: Number(revision) }, upload[2] === 'directory-file');
        json(response, 200, state);
      } catch (error) { json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '作者文件保存失败，原设置已保留' }); }
      return;
    }
    const directory = /^([^/]+)\/directory\/([^/]+)$/.exec(encodedId);
    if (directory) {
      if (request.method !== 'POST') { methodNotAllowed(response, ['POST']); return; }
      const project = await this.#findProject(directory[1]);
      if (!project || !project.eligible || !['scene', 'web'].includes(project.type)) { json(response, 404, { error: '作者属性元数据不可用' }); return; }
      try {
        const key = decodeURIComponent(directory[2]);
        json(response, 200, await this.#authorProperties.directory(project, key, await readJsonBody(request)));
      } catch (error) { json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '作者目录保存失败，原设置已保留' }); }
      return;
    }
    if (!['GET', 'POST'].includes(request.method)) { methodNotAllowed(response, ['GET', 'POST']); return; }
    const project = await this.#findProject(encodedId);
    if (!project || !project.eligible || !['scene', 'web'].includes(project.type)) {
      json(response, 404, { error: '作者属性元数据不可用' }); return;
    }
    try {
      const patch = request.method === 'POST' ? await readJsonBody(request) : null;
      json(response, 200, await this.#authorProperties.state(project, patch));
    } catch (error) { json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '作者属性保存失败，原设置已保留' }); }
  }

  async #playlistRoute(request, response, route) {
    try {
      if (route === 'api/playlists' && request.method === 'GET') {
        const config = await this.#configStore.get();
        const stateOnly = new URL(request.url, this.origin).searchParams.get('state') === '1';
        json(response, 200, { config: { selectedId: config.selectedId, effects: config.effects, media: config.media,
          ...(!stateOnly ? { playlists: config.playlists } : {}) }, revision: this.#configStore.revision, status: this.#playlists.status() });
        return;
      }
      if (route === 'api/playlists/manage' && request.method === 'POST') {
        const body = await readJsonBody(request, PLAYLIST_LIMITS.jsonBytes);
        json(response, 200, { ...await this.#playlists.manage(body), revision: this.#configStore.revision });
        return;
      }
      if (route === 'api/playlists/next' && request.method === 'POST') {
        await readJsonBody(request, 4096);
        json(response, 200, { config: await this.#playlists.next(), revision: this.#configStore.revision, status: this.#playlists.status() });
        return;
      }
      if (route === 'api/playlists/failed' && request.method === 'POST') {
        const body = await readJsonBody(request, 4096);
        json(response, 200, { config: await this.#playlists.reportFailure(body), revision: this.#configStore.revision, status: this.#playlists.status() });
        return;
      }
      methodNotAllowed(response, ['GET', 'POST']);
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '播放列表操作失败，请重新读取状态' });
    }
  }

  async #action(request, response) {
    if (request.method !== 'POST') {
      methodNotAllowed(response, ['POST']);
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }
    if (typeof body.action !== 'string' || !body.action.trim() || body.action.length > 100) {
      json(response, 400, { ok: false, error: 'action must be a non-empty string' });
      return;
    }
    if (!this.#onAction) {
      json(response, 501, { ok: false, error: 'No action handler is configured' });
      return;
    }
    if (this.#library?.busy && body.action === 'inject') {
      json(response, 409, { ok: false, notExecuted: true, error: '资源任务正在进行，请等待或取消后应用' });
      return;
    }
    // Validated native injection may initialize several renderers before any
    // response bytes exist. Keep its socket alive for the desktop's bounded wait.
    if (body.action === 'inject') response.setTimeout(60_000);
    try {
      const result = await this.#onAction(body.action, body, {
        config: normalizeConfig(await this.#configStore.get()),
      });
      if (body.action === 'restore' && result?.ok !== false && result?.injectorActive !== true) {
        await this.#playlists.manage({ action: 'settings', enabled: false });
      }
      if (body.action === 'rescan') this.#playlists.resetFailures();
      if (body.action !== 'injection-status') await this.#playlists.refresh();
      json(response, 200, publicActionResult(result));
    } catch (error) {
      const message = typeof error?.message === 'string' && error.message
        ? error.message.slice(0, 500)
        : 'Action failed';
      const registeredHosts = Array.isArray(error?.registeredHosts) ? publicHostEndpoints(error.registeredHosts) : undefined;
      json(response, 500, { ok: false, error: message, registeredHosts });
    }
  }

  async #libraryRoute(request, response, route) {
    if (!this.#library) { json(response, 501, { error: '资源库需要持久化配置' }); return; }
    try {
      if (route === 'api/library' && request.method === 'GET') {
        json(response, 200, { directory: this.#library.directory, busy: this.#library.busy });
        return;
      }
      if (route === 'api/library/jobs' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const job = body.kind === 'import' ? this.#library.beginImport(body)
          : body.kind === 'migrate' ? await this.#library.beginMigration(body.directory) : null;
        if (!job) { json(response, 400, { error: '任务类型无效' }); return; }
        json(response, 202, { job });
        return;
      }
      const match = /^api\/library\/jobs\/([a-f0-9-]{36})(?:\/(content|cancel))?$/.exec(route);
      if (match) {
        const [, id, operation] = match;
        if (!operation && request.method === 'GET') { json(response, 200, { job: this.#library.getJob(id) }); return; }
        if (operation === 'cancel' && request.method === 'POST') { json(response, 200, { job: this.#library.cancel(id) }); return; }
        if (operation === 'content' && request.method === 'PUT') {
          const job = this.#library.getJob(id);
          if (request.headers['content-type'] !== 'application/octet-stream') {
            json(response, 415, { error: '文件传输必须使用 application/octet-stream' }); return;
          }
          if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) !== job.total) {
            json(response, 400, { error: '文件长度与任务声明不一致' }); return;
          }
          const result = await this.#library.upload(id, request);
          json(response, 200, { job: result });
          return;
        }
        methodNotAllowed(response, operation === 'content' ? ['PUT'] : operation === 'cancel' ? ['POST'] : ['GET']);
        return;
      }
      if (route === 'api/library/manage' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const projects = await this.projects();
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
        if (ids.length > 100 || ids.some((id) => typeof id !== 'string' || !projects.some((project) => project.id === id))) {
          json(response, 400, { error: '请选择最多 100 张已存在的壁纸' }); return;
        }
        let result = {};
        if (body.action === 'remove' && ids.length === 1) {
          const config = await this.#configStore.get();
          const nextId = eligibleProjects(projects.filter((project) => project.id !== ids[0]), config)[0]?.id ?? null;
          result = await this.#library.remove(ids[0], nextId);
        } else if (['hide', 'restore', 'restore-all', 'rating'].includes(body.action)) {
          if ((body.action !== 'restore-all' && ids.length === 0)
            || (body.action === 'rating' && !CONTENT_RATINGS.includes(body.rating))) {
            json(response, 400, { error: '壁纸或分级无效' }); return;
          }
          await this.#library.mutate(async () => {
            const config = await this.#configStore.get();
            const library = config.library;
            if (body.action === 'hide') library.hiddenIds = [...new Set([...library.hiddenIds, ...ids])];
            if (body.action === 'restore') library.hiddenIds = library.hiddenIds.filter((id) => !ids.includes(id));
            if (body.action === 'restore-all') library.hiddenIds = [];
            if (body.action === 'rating') for (const id of ids) {
              Object.defineProperty(library.ratings, id, { value: body.rating, enumerable: true, configurable: true, writable: true });
            }
            const candidates = eligibleProjects(projects, { library });
            const selectedId = candidates.some((project) => project.id === config.selectedId)
              ? config.selectedId : candidates[0]?.id ?? null;
            await this.#configStore.set({ library, selectedId });
          });
        } else { json(response, 400, { error: '资源操作无效' }); return; }
        const config = normalizeConfig(await this.#configStore.get());
        if (this.#onConfigChange) {
          try { await this.#onConfigChange(config, { library: true }); }
          catch { json(response, 502, { error: '资源设置已保存，但 Codex 同步失败；请重新应用', saved: true, config }); return; }
        }
        await this.#playlists.refresh();
        json(response, 200, { ok: true, config, ...result });
        return;
      }
      json(response, 404, { error: '资源接口不存在' });
    } catch (error) {
      json(response, error.statusCode || 500, { error: error.statusCode ? error.message : '资源操作失败，未覆盖源文件' });
    }
  }

  async #static(request, response, encodedPath) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    let relativePath;
    try {
      relativePath = encodedPath ? decodeURIComponent(encodedPath) : 'index.html';
    } catch {
      plain(response, 400, 'Bad Request');
      return;
    }
    if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
    if (relativePath.includes('\0')) {
      plain(response, 400, 'Bad Request');
      return;
    }
    const entry = await containedEntry(this.#publicDir, relativePath);
    if (!entry) {
      plain(response, 404, 'Not Found');
      return;
    }
    const isHtml = ['.htm', '.html'].includes(path.extname(entry.path).toLowerCase());
    sendFile(request, response, entry, {
      range: true,
      cache: true,
      cors: false,
      headers: isHtml ? {
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' cwb-desktop://shell",
      } : {},
    });
  }
}

export function createMediaServer(options) {
  return new MediaServer(options);
}
