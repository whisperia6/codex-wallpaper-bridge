import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPolicy } from './library-policy.mjs';
import { normalizeAuthorProperties, readAuthorProperties, validateAuthorPropertyPatch, mapAuthorFileProperties } from './author-properties.mjs';
import { applySceneRenderCompletionOverlay, SCENE_RENDERER_ASSET } from './scene-render-overlay.mjs';
import { DESKTOP_RENDERER_ORIGIN } from './desktop-origin.mjs';
import { sceneAssetCache, sceneAssetStamp } from './scene-asset-cache.mjs';
import { listAuthorDirectory } from './author-directory.mjs';
import { validateWebWallpaperInput } from './web-wallpaper-input.mjs';
import { SCENE_MAX_FIRST_FRAME_TIMEOUT_MS } from './engine-health.mjs';
import { rewriteWebResourceUrl, installWebResourceAliases } from './web-resource-aliases.mjs';

const VENDOR_DIR = fileURLToPath(new URL('../vendor/webwallgl/', import.meta.url));
const BRIDGE_FILE = fileURLToPath(new URL('../public/cwb-scene-bridge.js', import.meta.url));
const SCENE_HOST_FILE = fileURLToPath(new URL('../public/cwb-scene-host.mjs', import.meta.url));
const WEB_BRIDGE_FILE = fileURLToPath(new URL('../public/cwb-web-bridge.js', import.meta.url));
const PROBE_FILE = fileURLToPath(new URL('../public/cwb-verifier-probe.js', import.meta.url));
const ENGINE_PATH = '/wallpaper-engine/scene-live/';
const ENGINE_FILES = new Set(['index.html', SCENE_RENDERER_ASSET, 'mediabunny.mjs']);
const IMPORT_MAP = JSON.stringify({ imports: { mediabunny: ENGINE_PATH + 'mediabunny.mjs' } });
const IMPORT_MAP_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');
const rendererOverlays = new WeakMap();
function rendererOverlay(bytes) {
  if (!rendererOverlays.has(bytes)) rendererOverlays.set(bytes, applySceneRenderCompletionOverlay(bytes));
  return rendererOverlays.get(bytes);
}
async function rawBytes(entry) { return await sceneAssetCache.read(entry) ?? await readFile(entry.path); }
const ASSET_TYPES = new Map([
  ['.json', 'application/json'], ['.pkg', 'application/octet-stream'], ['.tex', 'application/octet-stream'],
  ['.mdl', 'application/octet-stream'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.flac', 'audio/flac'], ['.m4a', 'audio/mp4'],
  ['.ttf', 'font/ttf'], ['.otf', 'font/otf'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.js', 'text/plain'], ['.glsl', 'text/plain'], ['.vert', 'text/plain'], ['.frag', 'text/plain'], ['.txt', 'text/plain'],
]);
const WEB_TYPES = new Map([...ASSET_TYPES, ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'], ['.svg', 'image/svg+xml'],
  ['.moc3', 'application/octet-stream'], ['.bin', 'application/octet-stream'], ['.wasm', 'application/wasm']]);
export const MAX_SCENE_ASSET_BYTES = 512 * 1024 ** 2;
const PAYLOAD_CHUNK_BYTES = 64 * 1024;

function* payloadChunks(bytes) {
  for (let offset = 0; offset < bytes.length; offset += PAYLOAD_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + PAYLOAD_CHUNK_BYTES);
  }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function fileInside(root, name) {
  const target = path.resolve(root, name);
  if (!contained(root, target)) return null;
  try {
    const resolved = await realpath(target);
    if (!contained(root, resolved)) return null;
    const info = await stat(resolved);
    return info.isFile() && info.size <= MAX_SCENE_ASSET_BYTES ? { path: resolved, info } : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

async function readVerifiedWebWallgl(directory) {
  try {
    const lock = JSON.parse(await readFile(path.join(directory, 'vendor-lock.json'), 'utf8'));
    if (lock.version !== '3.1.0' || lock.commit !== '28ab4381c806cf40e0577aba47b4520b31b19e57') throw new Error();
    const root = await realpath(directory);
    const assets = new Map();
    for (const name of ['LICENSE', 'we-scene-LICENSE', 'mediabunny-LICENSE', 'NOTICE.md',
      'sources/mediabunny-1.56.0.tgz', ...ENGINE_FILES]) {
      const entry = await fileInside(root, name);
      if (!entry) throw new Error();
      const bytes = await rawBytes(entry);
      if (bytes.length !== lock.files[name]?.size
        || createHash('sha256').update(bytes).digest('hex') !== lock.files[name]?.sha256) throw new Error();
      if (ENGINE_FILES.has(name)) assets.set(name, name === SCENE_RENDERER_ASSET ? rendererOverlay(bytes) : bytes);
    }
    return { lock, assets };
  } catch {
    throw new Error('WebWallGL vendor integrity check failed');
  }
}

/** Verify vendored bytes, including licenses and MPL source, before serving or building. */
export async function verifyWebWallglAssets(directory = VENDOR_DIR) {
  return (await readVerifiedWebWallgl(directory)).lock;
}

/** Optional cold-start IO overlap. No server/capability/GPU context is created,
 * and actual serving still repeats its policy, containment and hash checks. */
export async function prewarmSceneAssets({ project, config = {}, cancelled = () => false }) {
  if (cancelled() || !project || project.type !== 'scene' || project.hidden || project.eligible === false
    || !projectPolicy(project, config).eligible) return false;
  await verifyWebWallglAssets();
  if (cancelled()) return false;
  const root = await realpath(project.rootPath);
  for (const name of ['project.json', 'scene.pkg']) {
    if (cancelled()) return false;
    const entry = await fileInside(root, name);
    // Respect the existing 32 MiB single-file / 128 MiB process budget. Large
    // packages stay on the Range-streaming path; never readFile() as fallback.
    if (entry) await sceneAssetCache.read(entry);
  }
  return !cancelled();
}

function singleRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) <= 0)) return null;
  return { start, end, partial: true };
}

function parentOriginOf(value, { allowHttpsLoopback = false } = {}) {
  if (value === null || value === undefined) return null;
  // Both independently verified Codex builds register this as a standard scheme.
  // Node's WHATWG URL reports custom origins as "null"; never use that value or
  // broaden to app:/*. Only the exact Chromium origin may receive telemetry.
  if (value === 'app://-') return value;
  const url = new URL(value);
  const httpsLoopbackAllowed = allowHttpsLoopback === true
    && url.protocol === 'https:'
    && url.hostname === '127.0.0.1'
    && /^\d{1,5}$/.test(url.port)
    && Number(url.port) >= 1
    && Number(url.port) <= 65535;
  const httpLoopbackAllowed = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.origin !== value || (!httpLoopbackAllowed && !httpsLoopbackAllowed)) {
    throw new TypeError('scene parent must be an explicit loopback or verified Codex app origin');
  }
  return url.origin;
}

/** M2-A read-only PoC. No control token, Node bridge, write API, or public path-setting API. */
export class ReadonlyWallpaperServer {
  #project;
  #config;
  #parentOrigin;
  #vendor;
  #root;
  #server = null;
  #tail = Promise.resolve();
  #token = randomBytes(16).toString('hex');
  #channel = randomBytes(16).toString('hex');
  #origin = null;
  #firstFrameTimeout = 15_000;
  #payloadProgress = { bytesServed: 0, lastByteAt: 0, activeTransfers: 0 };
  #authorProperties = { schema: {}, values: {} };
  #authorFiles;
  #webEntry = 'index.html';
  #probe = false;
  #streams = new Set();
  #engineAssets = null;
  #projectStamp = null;
  #projectAssets = new Map();
  #projectAssetsComplete = true;
  #frameRate;
  #nativeQuality;
  #desktopAncestor;
  #diagnostics = { requests: [], bytes: 0, denied: 0, upstreamDiagnostics: 0 };

  constructor({ project, config = {}, parentOrigin = null, allowHttpsLoopback = false, vendorDir = VENDOR_DIR, diagnosticProbe = false, frameRate = 30, nativeQuality = false, desktopAncestor = false, authorFiles = null } = {}) {
    if (!['scene', 'web'].includes(project?.type) || typeof project.rootPath !== 'string') throw new TypeError('a registered scene or web project is required');
    if (typeof allowHttpsLoopback !== 'boolean') throw new TypeError('invalid https loopback parent option');
    this.#project = structuredClone(project);
    this.#config = structuredClone(config);
    this.#authorFiles = authorFiles;
    this.#parentOrigin = parentOriginOf(parentOrigin, { allowHttpsLoopback });
    if (typeof desktopAncestor !== 'boolean' || (desktopAncestor && !this.#parentOrigin?.startsWith('http://127.0.0.1'))) {
      throw new TypeError('invalid desktop ancestor');
    }
    this.#desktopAncestor = desktopAncestor;
    this.#vendor = vendorDir;
    if (typeof diagnosticProbe !== 'boolean') throw new TypeError('invalid diagnostic option');
    if (![15, 30, 60].includes(frameRate) || typeof nativeQuality !== 'boolean') throw new TypeError('invalid scene preview quality');
    this.#probe = diagnosticProbe;
    this.#frameRate = frameRate; this.#nativeQuality = nativeQuality;
  }

  get origin() { return this.#origin; }
  get channel() { return this.#channel; }
  get resourceBase() { return `${this.origin}/${this.#token}/files/project`; }
  get authorProperties() { return structuredClone(this.#authorProperties); }
  get firstFrameTimeoutMs() { return this.#firstFrameTimeout; }
  payloadProgress() { return { ...this.#payloadProgress }; }
  get rendererUrl() {
    if (!this.#server) throw new Error('scene server is not running');
    if (this.#project.type === 'web') return `${this.resourceBase}/${this.#webEntry.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(ENGINE_PATH + 'index.html', this.origin);
    url.search = new URLSearchParams({ type: 'scene', src: 'project', fit: 'cover', sceneFps: String(this.#frameRate),
      muted: 'true', mediaBase: `${this.origin}/${this.#token}/files`, bake: '0',
      ...(this.#nativeQuality ? { renderDpr: '0', resources: '1', resourcesNormal: '1' } : {}) }).toString();
    return url.href;
  }
  diagnostics() { return structuredClone(this.#diagnostics); }
  async isCurrent() {
    try {
      if (!this.#server || await realpath(this.#project.rootPath) !== this.#root) return false;
      const manifest = await fileInside(this.#root, 'project.json');
      const pkg = await fileInside(this.#root, 'scene.pkg');
      if (!manifest || !this.#projectAssetsComplete
        || this.#projectStamp !== JSON.stringify([sceneAssetStamp(manifest), pkg ? sceneAssetStamp(pkg) : null])) return false;
      for (const [name, stamp] of this.#projectAssets) {
        const entry = await fileInside(this.#root, name);
        if (!entry || sceneAssetStamp(entry) !== stamp) return false;
      }
      return true;
    } catch { return false; }
  }
  #queue(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
  start() {
    return this.#queue(async () => {
      if (this.#server) return this;
      if (!projectPolicy(this.#project, this.#config).eligible || this.#project.eligible === false || this.#project.hidden) {
        throw new Error('scene project is not eligible');
      }
      const { assets } = await readVerifiedWebWallgl(this.#vendor);
      if (this.#project.type === 'scene') this.#engineAssets = assets;
      try {
        this.#root = await realpath(this.#project.rootPath);
        if (!(await stat(this.#root)).isDirectory()) throw new Error();
      } catch { throw new Error('scene project root is unavailable'); }
      const manifest = await fileInside(this.#root, 'project.json');
      if (!manifest || manifest.info.size > 1024 ** 2) throw new Error('scene manifest is unavailable');
      try {
        const parsed = JSON.parse((await readFile(manifest.path, 'utf8')).replace(/^\uFEFF/, ''));
        this.#authorProperties = normalizeAuthorProperties(parsed.general?.properties);
        if (this.#project.type === 'web') {
          const entry = typeof parsed.file === 'string' ? parsed.file : 'index.html';
          if (entry.length > 512 || /[\\\0:]/.test(entry) || entry.startsWith('/')
            || entry.split('/').some((part) => !part || part === '.' || part === '..')
            || !/\.html?$/i.test(entry) || !(await fileInside(this.#root, entry))) throw new Error();
          this.#webEntry = entry;
        }
      } catch { throw new Error('scene manifest is invalid'); }
      this.#token = randomBytes(16).toString('hex');
      this.#channel = randomBytes(16).toString('hex');
      const pkg = await fileInside(this.#root, 'scene.pkg');
      this.#projectStamp = JSON.stringify([sceneAssetStamp(manifest), pkg ? sceneAssetStamp(pkg) : null]);
      this.#projectAssets.clear(); this.#projectAssetsComplete = true;
      this.#firstFrameTimeout = Math.min(90_000, 15_000 + (pkg?.info.size ?? 0) / (8 * 1024 ** 2) * 1000);
      this.#payloadProgress = { bytesServed: 0, lastByteAt: 0, activeTransfers: 0 };
      this.#diagnostics = { requests: [], bytes: 0, denied: 0, upstreamDiagnostics: 0,
        ...(this.#project.type === 'scene' ? { rendererOverlay: 'scene-render-completion-v2' } : {}) };
      const server = createServer((request, response) => {
        void this.#handle(request, response).catch(() => {
          if (response.headersSent) response.destroy();
          else { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end('Scene resource failed'); }
        });
      });
      server.maxConnections = 16;
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.timeout = 30_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.#origin = `http://127.0.0.1:${server.address().port}`;
      this.#server = server;
      return this;
    });
  }
  close() {
    return this.#queue(async () => {
      const server = this.#server;
      if (!server) return;
      this.#server = null;
      const streams = [...this.#streams];
      const streamsClosed = streams.map((stream) => new Promise((resolve) => {
        if (stream.closed) resolve(); else stream.once('close', resolve);
        stream.destroy();
      }));
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await Promise.all(streamsClosed);
      this.#origin = null;
      this.#engineAssets = null;
    });
  }

  #headers(response) {
    response.setHeader('Content-Security-Policy', ["default-src 'none'",
      this.#project.type === 'web' ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:" : `script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORT_MAP_HASH}'`,
      "connect-src 'self' blob:", "img-src 'self' data: blob:", "media-src 'self' blob:",
      "font-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "worker-src blob:",
      this.#project.type === 'web' ? "frame-src 'none'" : "frame-src 'self'",
      "base-uri 'none'", "form-action 'none'", `frame-ancestors ${this.#parentOrigin ?? "'none'"}${this.#desktopAncestor ? ` ${DESKTOP_RENDERER_ORIGIN}` : ''}`,
      'sandbox allow-scripts allow-same-origin'].join('; '));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=()');
    response.setHeader('Cache-Control', 'no-store');
  }
  async #directoryCatalog(key, value) {
    const spec = Object.hasOwn(this.#authorProperties.schema, key) ? this.#authorProperties.schema[key] : null;
    if (spec?.type !== 'directory' || !validateAuthorPropertyPatch({ [key]: spec }, { [key]: value })) throw Object.assign(Error('作者目录引用无效'), { statusCode: 404 });
    let entries;
    if (value.startsWith('cwb-author-directories/')) {
      if (!this.#authorFiles) throw Object.assign(Error('作者目录引用无效'), { statusCode: 404 });
      entries = (await this.#authorFiles.directory(this.#project.id, key, value, spec)).map(name => ({ name,
        version: createHash('sha256').update(name).digest('hex') }));
    } else entries = await listAuthorDirectory(this.#root, value, spec);
    return { files: entries.map(({ name, version }) => ({ url: this.resourceBase + '/' + name.split('/').map(encodeURIComponent).join('/'), version })) };
  }

  async #handle(request, response) {
    const owner = this.#server;
    const live = () => this.#server === owner && !response.destroyed;
    this.#headers(response);
    const reject = (status) => {
      this.#diagnostics.denied += 1;
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Forbidden');
    };
    if (request.headers.host !== this.origin?.slice('http://'.length)
      || (request.headers.origin !== undefined && request.headers.origin !== this.origin)) { reject(403); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); reject(405); return;
    }
    let route;
    try { route = decodeURIComponent((request.url ?? '').split('?')[0]); }
    catch { reject(400); return; }
    if (route.length > 2048 || /[\\\0:]/.test(route) || route.split('/').some((part) => part === '.' || part === '..')) {
      reject(400); return;
    }
    if (route === `/${this.#token}/bridge-config.json`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(request.method === 'HEAD' ? '' : JSON.stringify({ parentOrigin: this.#parentOrigin,
        channel: this.#channel, firstFrameTimeoutMs: this.#firstFrameTimeout,
        ...(this.#project.type === 'scene' ? { maxFirstFrameTimeoutMs: SCENE_MAX_FIRST_FRAME_TIMEOUT_MS } : {}),
        type: this.#project.type, fps: this.#frameRate, authorProperties: this.#authorProperties, resourceBase: this.resourceBase })); return;
    }
    if (route === `/${this.#token}/payload-progress.json` && this.#project.type === 'scene') {
      response.setHeader('Content-Type', 'application/json');
      response.end(request.method === 'HEAD' ? '' : JSON.stringify(this.#payloadProgress)); return;
    }
    if (route.startsWith(`/${this.#token}/author-directory/`)) {
      const key = route.slice(`/${this.#token}/author-directory/`.length), params = new URL(request.url, this.origin).searchParams;
      if (!key || key.length > 128 || params.size !== 1 || !params.has('value')) { reject(404); return; }
      try {
        const catalog = await this.#directoryCatalog(key, params.get('value'));
        if (!live()) return;
        response.setHeader('Content-Type', 'application/json');
        response.end(request.method === 'HEAD' ? '' : JSON.stringify(catalog));
      } catch (error) { if (live()) reject(error.statusCode === 413 ? 413 : 404); }
      return;
    }
    if (route === '/diag') {
      this.#diagnostics.upstreamDiagnostics += 1;
      response.writeHead(204); response.end(); return;
    }
    if (this.#project.type === 'scene' && ['/cwb-scene-bridge.js', '/cwb-scene-host.mjs'].includes(route)) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      const path = route.endsWith('.mjs') ? SCENE_HOST_FILE : BRIDGE_FILE;
      const script = request.method === 'HEAD' ? '' : await rawBytes({ path, info: await stat(path) });
      if (live()) response.end(script); return;
    }
    if (route === '/cwb-web-bridge.js' && this.#project.type === 'web') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      const script = request.method === 'HEAD' ? '' : await rawBytes({ path: WEB_BRIDGE_FILE, info: await stat(WEB_BRIDGE_FILE) });
      if (live()) response.end(script); return;
    }
    if (route === '/cwb-property-validator.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(request.method === 'HEAD' ? '' : `window.__cwbValidateProperties=(${validateAuthorPropertyPatch.toString()});window.__cwbReadProperties=(${readAuthorProperties.toString()});window.__cwbMapFileProperties=(${mapAuthorFileProperties.toString()});window.__cwbValidateWebInput=(${validateWebWallpaperInput.toString()});window.__cwbRewriteResourceUrl=(${rewriteWebResourceUrl.toString()});window.__cwbInstallResourceAliases=(${installWebResourceAliases.toString()});`); return;
    }
    if (route === '/cwb-verifier-probe.js' && this.#probe) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      const script = request.method === 'HEAD' ? '' : await readFile(PROBE_FILE);
      if (live()) response.end(script); return;
    }
    let entry;
    let name;
    let type;
    if (route.startsWith(ENGINE_PATH) && this.#project.type === 'scene') {
      name = route.slice(ENGINE_PATH.length) || 'index.html';
      const bytes = this.#engineAssets?.get(name);
      if (!bytes) { reject(404); return; }
      type = name.endsWith('.mjs') ? 'text/javascript' : 'text/html; charset=utf-8';
      entry = { info: { size: bytes.length }, bytes };
      if (name === 'index.html') {
        const html = bytes.toString('utf8').replace(/<head\b[^>]*>/i,
          (head) => head + (this.#probe ? '<script src="/cwb-verifier-probe.js"></script>' : '')).replace('</head>',
          `<meta name="cwb-scene-session" content="${this.#token}"><script type="importmap">${IMPORT_MAP}</script><script src="/cwb-property-validator.js" defer></script><script src="/cwb-scene-bridge.js" defer></script><script type="module" src="/cwb-scene-host.mjs"></script></head>`);
        if (!live()) return;
        response.setHeader('Content-Type', type);
        response.end(request.method === 'HEAD' ? '' : html); return;
      }
    } else if (route.startsWith(`/${this.#token}/files/project/`)) {
      name = route.slice(`/${this.#token}/files/project/`.length);
      if (name.startsWith('cwb-author-directories/')) {
        const key = Object.keys(this.#authorProperties.schema).find(key => this.#authorProperties.schema[key].type === 'directory'
          && this.#authorFiles?.ownsDirectory(this.#project.id, key, name));
        if (key === undefined) { reject(404); return; }
        try {
          const catalog = await this.#directoryCatalog(key, name);
          if (!live()) return;
          response.setHeader('Content-Type', 'application/json'); response.end(request.method === 'HEAD' ? '' : JSON.stringify(catalog));
        } catch (error) { if (live()) reject(error.statusCode === 413 ? 413 : 404); }
        return;
      }
      type = (this.#project.type === 'web' ? WEB_TYPES : ASSET_TYPES).get(path.extname(name).toLowerCase());
      if (!type) { reject(404); return; }
      if (name.startsWith('cwb-author-files/')) {
        const key = Object.keys(this.#authorProperties.schema).find(key => ['file', 'directory'].includes(this.#authorProperties.schema[key].type)
          && this.#authorFiles?.owns(this.#project.id, key, name)
          && this.#authorProperties.schema[key].extensions.includes(path.extname(name)));
        if (key === undefined) { reject(404); return; }
        try { entry = await this.#authorFiles.resolve(this.#project.id, key, name); }
        catch { reject(404); return; }
      } else entry = await fileInside(this.#root, name);
      if (entry && !name.startsWith('cwb-author-files/') && this.#project.type === 'scene' && request.method === 'GET') {
        const stamp = sceneAssetStamp(entry), previous = this.#projectAssets.get(name);
        if (previous && previous !== stamp) this.#projectAssetsComplete = false;
        else if (previous || this.#projectAssets.size < 128) this.#projectAssets.set(name, stamp);
        else this.#projectAssetsComplete = false;
      }
      if (entry && this.#project.type === 'web' && /\.html?$/i.test(name)) {
        if (entry.info.size > 4 * 1024 ** 2) { reject(404); return; }
        const adapter = `<meta name="cwb-scene-session" content="${this.#token}">${this.#probe ? '<script src="/cwb-verifier-probe.js"></script>' : ''}<script src="/cwb-property-validator.js"></script><script src="/cwb-web-bridge.js"></script>`;
        const source = await readFile(entry.path, 'utf8');
        // The adapter must run before author inline/external scripts, not just at </head>.
        const html = /<head\b[^>]*>/i.test(source) ? source.replace(/<head\b[^>]*>/i, (head) => head + adapter) : adapter + source;
        if (!live()) return;
        response.setHeader('Content-Type', type);
        response.end(request.method === 'HEAD' ? '' : html); return;
      }
    }
    if (!live()) return;
    if (!entry) { reject(404); return; }
    const range = singleRange(request.headers.range, entry.info.size);
    if (!range) {
      response.writeHead(416, { 'Content-Range': `bytes */${entry.info.size}` }); response.end(); return;
    }
    // The loopback service still sends no-store. Reuse only raw local bytes;
    // generated session pages above never enter this cache. Huge assets stream.
    if (request.method === 'GET' && !entry.bytes) {
      const cached = await sceneAssetCache.read(entry);
      if (cached) entry = { ...entry, bytes: cached };
      if (!live()) return;
    }
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', type);
    response.setHeader('Content-Length', entry.info.size === 0 ? 0 : range.end - range.start + 1);
    if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.info.size}`);
    response.writeHead(range.partial ? 206 : 200);
    if (request.method === 'HEAD' || entry.info.size === 0) { response.end(); return; }
    if (this.#diagnostics.requests.length < 64) this.#diagnostics.requests.push(name);
    const progress = this.#project.type === 'scene' && route.startsWith(`/${this.#token}/files/project/`)
      && path.extname(name).toLowerCase() === '.pkg' ? this.#payloadProgress : null;
    const account = (length) => {
      this.#diagnostics.bytes += length;
      if (progress) { progress.bytesServed += length; progress.lastByteAt = Date.now(); }
    };
    const bytes = entry.bytes?.subarray(range.start, range.end + 1);
    if (bytes && !progress) {
      account(bytes.length); response.end(bytes); return;
    }
    const stream = bytes
      ? Readable.from(payloadChunks(bytes), { objectMode: false, highWaterMark: PAYLOAD_CHUNK_BYTES })
      : createReadStream(entry.path, { start: range.start, end: range.end });
    if (progress) {
      progress.activeTransfers++;
      response.once('close', () => { progress.activeTransfers--; });
    }
    this.#streams.add(stream);
    stream.once('close', () => this.#streams.delete(stream));
    stream.on('data', (chunk) => account(chunk.length));
    stream.on('error', () => response.destroy());
    response.once('close', () => stream.destroy());
    stream.pipe(response);
  }
}

export class SceneServer extends ReadonlyWallpaperServer {
  constructor(options = {}) {
    if (options.project?.type !== 'scene') throw new TypeError('a registered scene project is required');
    super(options);
  }
}
export function createSceneServer(options) { return new SceneServer(options); }
export function createReadonlyWallpaperServer(options) { return new ReadonlyWallpaperServer(options); }
