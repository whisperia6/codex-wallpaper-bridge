import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
let cachedHelperPath;
let helperDisabled = false;

// 0x8007045A (ERROR_DLL_INIT_FAILED), 0xC0000142 (STATUS_DLL_INIT_FAILED),
// 0xC0000135 (STATUS_DLL_NOT_FOUND), 0xC0000022 (STATUS_ACCESS_DENIED):
// .NET CLR or OS loader cannot initialize the helper executable.
const LOADER_INIT_FAILURE_CODES = new Set([
  2147943514, -2147023782,
  3221225794, -1073741502,
  3221225781, -1073741515,
  3221225506, -1073741790,
]);

function helperCandidates() {
  const relative = path.join("dist", "bridge-runtime", "native", "cwb-win-helper.exe");
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", relative));
  }
  candidates.push(path.join(here, "bridge-runtime", "native", "cwb-win-helper.exe"));
  // The bundled CLI lives next to the bridge runtime's native directory.
  if (path.basename(path.dirname(here)) === "bridge-runtime") {
    candidates.push(path.resolve(here, "..", "native", "cwb-win-helper.exe"));
  }
  candidates.push(path.resolve(here, "..", relative));
  return candidates;
}

export function resolveWinHelperPath(platform = process.platform) {
  if (platform !== "win32" || helperDisabled) return null;
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  for (const candidate of helperCandidates()) {
    try {
      if (existsSync(candidate)) {
        cachedHelperPath = candidate;
        return cachedHelperPath;
      }
    } catch {}
  }
  return null;
}

function isHelperLoaderFailure(error) {
  if (!error || error.killed === true || error.name === "AbortError") return false;
  const hasOutput = Boolean(String(error.stdout || "").trim() || String(error.stderr || "").trim());
  if (hasOutput) return false;
  return LOADER_INIT_FAILURE_CODES.has(error.code)
    || error.code === "ENOENT"
    || error.code === "EACCES"
    || error.code === "EPERM";
}

function isTransientHelperFailure(error) {
  if (!error || error.killed === true || error.name === "AbortError") return false;
  return error.code === "EBUSY";
}

export async function tryRunWinHelper(subcommand, options = {}, platform = process.platform) {
  const helperPath = resolveWinHelperPath(platform);
  if (!helperPath) return null;
  const { args = [], ...execOptions } = options;
  try {
    return await execFileAsync(helperPath, [subcommand, ...args], {
      encoding: "utf8",
      windowsHide: true,
      ...execOptions,
      shell: false,
    });
  } catch (error) {
    if (isTransientHelperFailure(error)) {
      return null;
    }
    if (isHelperLoaderFailure(error)) {
      helperDisabled = true;
      cachedHelperPath = null;
      return null;
    }
    throw error;
  }
}

export async function queryWindowOcclusion(pids, {
  platform = process.platform, runWinHelper = tryRunWinHelper, timeout = 1200, signal,
} = {}) {
  const fallback = { occluded: false };
  if (platform !== "win32" || signal?.aborted || !Array.isArray(pids)
    || pids.some(pid => !Number.isInteger(pid) || pid < 1 || pid > 0xffffffff)) return fallback;
  const args = [...new Set(pids)].map(String);
  if (!args.length || args.length > 64) return fallback;
  try {
    const result = await runWinHelper("window-occlusion", { args, timeout, signal, maxBuffer: 4096 }, platform);
    const value = JSON.parse(result?.stdout);
    if (value?.ok === true && typeof value.occluded === "boolean"
      && Number.isInteger(value.targetCount) && value.targetCount >= 0) {
      return { occluded: value.targetCount > 0 && value.occluded, targetCount: value.targetCount };
    }
  } catch {}
  return fallback;
}

export function clearWinHelperPathCache() {
  cachedHelperPath = undefined;
  helperDisabled = false;
}
