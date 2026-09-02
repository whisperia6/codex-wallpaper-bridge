import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, mergeConfig, normalizeConfig } from './config-store.mjs';

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

function sendFile(request, response, entry, { range = false, cache = false, headers: extraHeaders = {} } = {}) {
  const method = request.method || 'GET';
  const size = entry.stat.size;
  const headers = {
    'Cache-Control': cache ? 'private, max-age=300' : 'no-store',
    'Content-Type': mimeType(entry.path),
    'Last-Modified': entry.stat.mtime.toUTCString(),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    'Cross-Origin-Resource-Policy': 'cross-origin',
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
  const type = ['video', 'web', 'scene', 'application'].includes(project.type)
    ? project.type
    : 'scene';
  const hasPreview = Boolean(previewCandidate(project));
  const inferredPlayable = type === 'video'
    ? Boolean(mediaCandidate(project))
    : (type === 'web' ? Boolean(webEntryCandidate(project)) : false);
  const playable = typeof project.playable === 'boolean' ? project.playable : inferredPlayable;
  const safeSources = new Set(['default', 'my', 'workshop', 'installed', 'unknown']);
  const source = safeSources.has(project.source) ? project.source : 'unknown';

  const value = {
    id,
    title: safeText(project.title ?? project.name, `Wallpaper ${id}`, 500),
    type,
    source,
    playable,
    supportsLive: playable,
    previewUrl: hasPreview ? `${basePath}/api/preview/${encodedId}` : null,
    mediaUrl: type === 'video' && playable ? `${basePath}/api/video/${encodedId}` : null,
    webUrl: type === 'web' && playable ? `${basePath}/api/web/${encodedId}/` : null,
  };
  if (/^\d+$/.test(String(project.workshopId ?? ''))) {
    value.workshopId = String(project.workshopId);
  }
  return value;
}

function inventoryStats(projects) {
  const byType = { video: 0, web: 0, scene: 0, application: 0 };
  let playable = 0;
  for (const project of projects) {
    if (Object.hasOwn(byType, project.type)) byType[project.type] += 1;
    if (project.playable) playable += 1;
  }
  return { total: projects.length, playable, byType };
}

function memoryConfigStore(initialConfig = DEFAULT_CONFIG) {
  let config = normalizeConfig(initialConfig);
  return {
    get() {
      return JSON.parse(JSON.stringify(config));
    },
    async set(patch) {
      config = mergeConfig(config, patch);
      return this.get();
    },
  };
}

function publicActionResult(result) {
  if (result == null) return { ok: true };
  if (typeof result === 'boolean') return { ok: result };
  if (typeof result !== 'object' || Array.isArray(result)) return { ok: true };
  const response = { ok: typeof result.ok === 'boolean' ? result.ok : true };
  if (typeof result.message === 'string') response.message = result.message.slice(0, 2_000);
  if (['string', 'number', 'boolean'].includes(typeof result.status)) response.status = result.status;
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

  constructor({
    projects = [],
    getProjects = null,
    publicDir = DEFAULT_PUBLIC_DIR,
    configStore = null,
    initialConfig = DEFAULT_CONFIG,
    onAction = null,
    onConfigChange = null,
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
    this.token = token;
    this.host = LOOPBACK_HOST;
    this.#publicDir = path.resolve(publicDir);
    this.#projects = normalizeProjects(projects);
    this.#getProjects = getProjects;
    this.#configStore = configStore || memoryConfigStore(initialConfig);
    this.#onAction = onAction;
    this.#onConfigChange = onConfigChange;
  }

  get port() {
    return this.#port;
  }

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
    if (this.#getProjects) return normalizeProjects(await this.#getProjects());
    return this.#projects;
  }

  async start() {
    if (this.#server) return this;
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
    server.requestTimeout = 30_000;
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
      return this;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async close() {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#port = null;
    server.closeIdleConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
    if (route === 'api/inventory') {
      await this.#inventory(request, response);
      return;
    }
    if (route === 'api/config') {
      await this.#config(request, response);
      return;
    }
    if (route === 'api/action') {
      await this.#action(request, response);
      return;
    }
    if (route.startsWith('api/preview/')) {
      await this.#preview(request, response, route.slice('api/preview/'.length));
      return;
    }
    if (route.startsWith('api/video/')) {
      await this.#video(request, response, route.slice('api/video/'.length));
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
    const projects = (await this.projects()).map((project) => publicProject(project, this.basePath));
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

  async #findProject(encodedId) {
    let id;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      return null;
    }
    return (await this.projects()).find((project) => projectId(project) === id) || null;
  }

  async #preview(request, response, encodedId) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const project = await this.#findProject(encodedId);
    if (!project) {
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

  async #video(request, response, encodedId) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      methodNotAllowed(response, ['GET', 'HEAD']);
      return;
    }
    const project = await this.#findProject(encodedId);
    if (!project || project.type !== 'video') {
      plain(response, 404, 'Not Found');
      return;
    }
    const candidate = mediaCandidate(project);
    const fallbackRoot = typeof candidate === 'string' && path.isAbsolute(candidate) ? path.dirname(candidate) : null;
    const entry = await containedEntry(projectRoot(project) || fallbackRoot, candidate);
    if (!entry) {
      plain(response, 404, 'Not Found');
      return;
    }
    sendFile(request, response, entry, { range: true });
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
    if (!project || project.type !== 'web') {
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
    const isHtml = ['.htm', '.html'].includes(path.extname(entry.path).toLowerCase());
    sendFile(request, response, entry, {
      range: true,
      cache: true,
      headers: isHtml
        ? { 'Content-Security-Policy': 'sandbox allow-scripts' }
        : {},
    });
  }

  async #config(request, response) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const config = normalizeConfig(await this.#configStore.get());
      const payload = { config };
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
    json(response, 200, { config });
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
    try {
      const result = await this.#onAction(body.action, body, {
        config: normalizeConfig(await this.#configStore.get()),
      });
      json(response, 200, publicActionResult(result));
    } catch (error) {
      const message = typeof error?.message === 'string' && error.message
        ? error.message.slice(0, 500)
        : 'Action failed';
      json(response, 500, { ok: false, error: message });
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
    sendFile(request, response, entry, { range: true, cache: true });
  }
}

export function createMediaServer(options) {
  return new MediaServer(options);
}
