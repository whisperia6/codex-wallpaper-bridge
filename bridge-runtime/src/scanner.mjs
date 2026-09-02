import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const WALLPAPER_ENGINE_APP_ID = '431960';
export const PROJECT_TYPES = Object.freeze(['video', 'web', 'scene', 'application']);

const execFileAsync = promisify(execFile);
const PREVIEW_NAMES = Object.freeze([
  'preview.jpg',
  'preview.jpeg',
  'preview.png',
  'preview.webp',
  'preview.gif',
]);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov', '.mkv', '.avi']);

/**
 * Parse the small KeyValues/VDF dialect Steam uses for libraryfolders.vdf and
 * appmanifest files. Unknown backslash escapes are intentionally preserved so
 * a path such as C:\Steam does not become C:Steam.
 */
export function parseVdf(input) {
  const tokens = tokenizeVdf(String(input ?? '').replace(/^\uFEFF/, ''));
  let cursor = 0;

  const parseObject = (expectsClosingBrace) => {
    const result = Object.create(null);

    while (cursor < tokens.length) {
      if (tokens[cursor] === '}') {
        if (!expectsClosingBrace) {
          throw new SyntaxError('Unexpected closing brace in VDF');
        }
        cursor += 1;
        return result;
      }

      const key = tokens[cursor++];
      if (key === '{') {
        throw new SyntaxError('Unexpected opening brace in VDF');
      }
      if (cursor >= tokens.length) {
        throw new SyntaxError(`Missing value for VDF key "${key}"`);
      }

      let value;
      if (tokens[cursor] === '{') {
        cursor += 1;
        value = parseObject(true);
      } else if (tokens[cursor] === '}') {
        throw new SyntaxError(`Missing value for VDF key "${key}"`);
      } else {
        value = tokens[cursor++];
      }

      // Duplicate keys are uncommon in Steam manifests. Keeping the last one
      // matches Valve's effective configuration behaviour.
      result[key] = value;
    }

    if (expectsClosingBrace) {
      throw new SyntaxError('Unclosed object in VDF');
    }
    return result;
  };

  return parseObject(false);
}

/** Return all library roots listed by either the current or legacy VDF shape. */
export function parseLibraryFoldersVdf(input) {
  const parsed = parseVdf(input);
  const folders = getCaseInsensitive(parsed, 'libraryfolders') ?? parsed;
  if (!folders || typeof folders !== 'object' || Array.isArray(folders)) {
    return [];
  }

  const paths = [];
  for (const [key, entry] of Object.entries(folders)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof entry === 'string') {
      paths.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const libraryPath = getCaseInsensitive(entry, 'path');
      if (typeof libraryPath === 'string' && libraryPath.trim()) {
        paths.push(libraryPath);
      }
    }
  }
  return dedupeStrings(paths.filter(Boolean), process.platform === 'win32');
}

/** Extract a REG_SZ/REG_EXPAND_SZ value from `reg.exe query` output. */
export function parseRegistryValueOutput(input) {
  for (const line of String(input ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Locate existing Steam installations. Tests and callers may pass steamRoots
 * to bypass registry/common-path discovery entirely.
 */
export async function discoverSteamRoots(options = {}) {
  const platform = options.platform ?? process.platform;
  if (Array.isArray(options.steamRoots)) {
    return existingDirectories(options.steamRoots);
  }

  const candidates = [];
  if (Array.isArray(options.registryPaths)) {
    candidates.push(...options.registryPaths);
  } else if (platform === 'win32') {
    candidates.push(...await querySteamRegistry(options.registryQuery));
  }

  if (Array.isArray(options.commonPaths)) {
    candidates.push(...options.commonPaths);
  } else {
    candidates.push(...defaultSteamPaths(options.env ?? process.env, platform));
  }

  return existingDirectories(candidates);
}

/** Discover existing Steam library roots, including the primary Steam root. */
export async function discoverSteamLibraries(options = {}) {
  const steamRoots = await discoverSteamRoots(options);
  const candidates = [...steamRoots, ...(options.libraryRoots ?? [])];
  const warnings = [];

  for (const steamRoot of steamRoots) {
    const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    try {
      const contents = await fs.readFile(vdfPath, 'utf8');
      candidates.push(...parseLibraryFoldersVdf(contents));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warnings.push(`Could not read ${vdfPath}: ${error.message}`);
      }
    }
  }

  return {
    steamRoots,
    libraryRoots: await existingDirectories(candidates),
    warnings,
  };
}

/**
 * Parse one Wallpaper Engine project directory (or its project.json path).
 * Absolute paths are deliberately retained for the media server's private
 * lookup table; public responses should map them to opaque URLs.
 */
export async function parseWallpaperProject(projectDirectoryOrFile, details = {}) {
  const suppliedPath = path.resolve(String(projectDirectoryOrFile));
  const projectFile = path.basename(suppliedPath).toLowerCase() === 'project.json'
    ? suppliedPath
    : path.join(suppliedPath, 'project.json');
  const rootPath = path.dirname(projectFile);

  let raw;
  try {
    raw = await fs.readFile(projectFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    const wrapped = new SyntaxError(`Invalid Wallpaper Engine manifest ${projectFile}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }

  const type = normalizeProjectType(manifest?.type);
  if (!type) return null;

  const source = normalizeSource(details.source);
  const previewPath = await resolvePreview(rootPath, manifest?.preview);
  const declaredFile = typeof manifest?.file === 'string' ? manifest.file.trim() : '';
  let contentPath = declaredFile ? resolveInside(rootPath, declaredFile) : null;
  if (contentPath && !(await isFile(contentPath))) contentPath = null;

  if (!contentPath && type === 'video') {
    contentPath = await findFirstRootFile(rootPath, (name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  }
  if (!contentPath && type === 'web') {
    const defaultEntry = resolveInside(rootPath, 'index.html');
    if (defaultEntry && await isFile(defaultEntry)) contentPath = defaultEntry;
  }

  const folderId = path.basename(rootPath);
  const workshopId = stringOrNull(manifest?.workshopid)
    ?? (source === 'workshop' && /^\d+$/.test(folderId) ? folderId : null);
  const id = String(details.id ?? workshopId ?? `${source}:${details.relativeName ?? folderId}`);
  const title = stringOrNull(manifest?.title) ?? folderId;

  let mediaPath = null;
  let webRoot = null;
  let webEntry = null;
  let playable = false;

  if (type === 'video') {
    mediaPath = contentPath;
    playable = Boolean(contentPath);
  } else if (type === 'web') {
    webRoot = rootPath;
    webEntry = contentPath;
    playable = Boolean(contentPath);
  } else if (type === 'scene') {
    // Native scene.pkg/scene.json rendering is not available in Chromium.
    // The preview is still useful as a static Codex background.
    mediaPath = previewPath;
  }

  return {
    id,
    title,
    type,
    source,
    rootPath,
    projectFile,
    previewPath,
    mediaPath,
    webRoot,
    webEntry,
    playable,
    metadata: {
      workshopId,
      description: stringOrNull(manifest?.description),
      tags: Array.isArray(manifest?.tags)
        ? manifest.tags.filter((tag) => typeof tag === 'string')
        : [],
      contentRating: stringOrNull(manifest?.contentrating),
      visibility: stringOrNull(manifest?.visibility),
      declaredFile: declaredFile || null,
    },
  };
}

/**
 * Scan Wallpaper Engine default, user-created, and Workshop projects.
 * Returns discovery information plus the parsed project array.
 */
export async function scanWallpaperProjects(options = {}) {
  const discovery = await discoverSteamLibraries(options);
  const warnings = [...discovery.warnings];
  const projects = [];
  const seenProjectFiles = new Set();

  for (const libraryRoot of discovery.libraryRoots) {
    const steamapps = path.join(libraryRoot, 'steamapps');
    const installRoot = await findWallpaperEngineInstall(steamapps);
    const scanRoots = [];

    if (installRoot) {
      scanRoots.push(
        { source: 'default', root: path.join(installRoot, 'projects', 'defaultprojects') },
        { source: 'my', root: path.join(installRoot, 'projects', 'myprojects') },
      );
    }
    scanRoots.push({
      source: 'workshop',
      root: path.join(steamapps, 'workshop', 'content', WALLPAPER_ENGINE_APP_ID),
    });

    for (const scanRoot of scanRoots) {
      const projectFiles = await findProjectFiles(scanRoot.root, options.maxDepth ?? 6);
      for (const projectFile of projectFiles) {
        const projectKey = canonicalPathKey(projectFile);
        if (seenProjectFiles.has(projectKey)) continue;
        seenProjectFiles.add(projectKey);

        try {
          const project = await parseWallpaperProject(projectFile, {
            source: scanRoot.source,
            relativeName: path.relative(scanRoot.root, path.dirname(projectFile)).split(path.sep).join('/'),
          });
          if (project) projects.push(project);
        } catch (error) {
          warnings.push(error.message);
        }
      }
    }
  }

  projects.sort((a, b) =>
    a.source.localeCompare(b.source, 'en')
    || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    || a.id.localeCompare(b.id, 'en'));

  return {
    appId: WALLPAPER_ENGINE_APP_ID,
    steamRoots: discovery.steamRoots,
    libraryRoots: discovery.libraryRoots,
    projects,
    warnings,
  };
}

/** Convenience API for callers that only need the project records. */
export async function scanProjects(options = {}) {
  return (await scanWallpaperProjects(options)).projects;
}

export const scanWallpapers = scanProjects;

function tokenizeVdf(input) {
  const tokens = [];
  let cursor = 0;

  while (cursor < input.length) {
    const char = input[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '/' && input[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < input.length && input[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (char === '{' || char === '}') {
      tokens.push(char);
      cursor += 1;
      continue;
    }
    if (char === '"') {
      cursor += 1;
      let value = '';
      let closed = false;
      while (cursor < input.length) {
        const current = input[cursor++];
        if (current === '"') {
          closed = true;
          break;
        }
        if (current === '\\' && cursor < input.length) {
          const escaped = input[cursor++];
          if (escaped === '\\' || escaped === '"') value += escaped;
          else if (escaped === 'n') value += '\n';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 't') value += '\t';
          else value += `\\${escaped}`;
        } else {
          value += current;
        }
      }
      if (!closed) throw new SyntaxError('Unclosed quoted string in VDF');
      tokens.push(value);
      continue;
    }

    const start = cursor;
    while (cursor < input.length && !/[\s{}"]/.test(input[cursor])) {
      if (input[cursor] === '/' && input[cursor + 1] === '/') break;
      cursor += 1;
    }
    if (cursor === start) throw new SyntaxError(`Unexpected token in VDF at offset ${cursor}`);
    tokens.push(input.slice(start, cursor));
  }
  return tokens;
}

function getCaseInsensitive(object, wantedKey) {
  if (!object || typeof object !== 'object') return undefined;
  const actualKey = Object.keys(object).find((key) => key.toLowerCase() === wantedKey.toLowerCase());
  return actualKey === undefined ? undefined : object[actualKey];
}

function normalizeProjectType(value) {
  if (typeof value !== 'string') return null;
  const type = value.trim().toLowerCase();
  return PROJECT_TYPES.includes(type) ? type : null;
}

function normalizeSource(value) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['default', 'my', 'workshop'].includes(source) ? source : 'unknown';
}

async function resolvePreview(rootPath, declaredPreview) {
  if (typeof declaredPreview === 'string' && declaredPreview.trim()) {
    const candidate = resolveInside(rootPath, declaredPreview.trim());
    if (candidate && await isFile(candidate)) return candidate;
  }
  for (const name of PREVIEW_NAMES) {
    const candidate = path.join(rootPath, name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

function resolveInside(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  const root = path.resolve(rootPath);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return candidate;
  }
  return null;
}

async function findFirstRootFile(rootPath, predicate) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const match = entries
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))[0];
    return match ? path.join(rootPath, match.name) : null;
  } catch {
    return null;
  }
}

async function findProjectFiles(rootPath, maxDepth) {
  if (!(await isDirectory(rootPath))) return [];
  const results = [];

  const visit = async (directory, depth) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const manifest = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'project.json');
    if (manifest) {
      results.push(path.join(directory, manifest.name));
      return;
    }
    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
    }
  };

  await visit(rootPath, 0);
  return results;
}

async function findWallpaperEngineInstall(steamappsPath) {
  const manifestPath = path.join(steamappsPath, `appmanifest_${WALLPAPER_ENGINE_APP_ID}.acf`);
  let installName = 'wallpaper_engine';
  try {
    const manifest = parseVdf(await fs.readFile(manifestPath, 'utf8'));
    const appState = getCaseInsensitive(manifest, 'AppState');
    const declaredName = getCaseInsensitive(appState, 'installdir');
    if (typeof declaredName === 'string' && declaredName.trim()) installName = declaredName.trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A damaged appmanifest should not hide the conventional install path.
      installName = 'wallpaper_engine';
    }
  }

  const commonRoot = path.join(steamappsPath, 'common');
  const installRoot = resolveInside(commonRoot, installName);
  return installRoot && await isDirectory(installRoot) ? installRoot : null;
}

async function querySteamRegistry(customQuery) {
  const keys = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  const query = customQuery ?? (async (key, valueName) => {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return parseRegistryValueOutput(stdout);
  });

  const results = await Promise.all(keys.map(async ([key, valueName]) => {
    try {
      return await query(key, valueName);
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

function defaultSteamPaths(env, platform) {
  if (platform !== 'win32') {
    return [
      env.HOME && path.join(env.HOME, '.steam', 'steam'),
      env.HOME && path.join(env.HOME, '.local', 'share', 'Steam'),
    ].filter(Boolean);
  }

  const candidates = [
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Steam'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Steam'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ].filter(Boolean);

  // Steam is frequently installed as D:\Steam or on another data drive. The
  // existence checks are cheap and make discovery work even if registry data
  // was removed.
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const drive = String.fromCharCode(code);
    candidates.push(`${drive}:\\Steam`, `${drive}:\\steam`, `${drive}:\\SteamLibrary`);
  }
  return candidates;
}

async function existingDirectories(candidates) {
  const results = [];
  const seen = new Set();
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const absolute = path.resolve(candidate.trim());
    const key = canonicalPathKey(absolute);
    if (seen.has(key) || !(await isDirectory(absolute))) continue;
    seen.add(key);
    results.push(absolute);
  }
  return results;
}

async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function canonicalPathKey(candidate) {
  const normalized = path.resolve(candidate).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function dedupeStrings(values, caseInsensitive = false) {
  const results = [];
  const seen = new Set();
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }
  return results;
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}
