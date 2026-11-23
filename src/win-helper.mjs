import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
let cachedHelperPath;
let helperDisabled = false;

// 0x8007045A (ERROR_DLL_INIT_FAILED): .NET CLR cannot initialize when an .exe
// inherits a Low Mandatory Integrity Level (for example inside sandboxed dev folders).
const LOADER_INIT_FAILURE_CODES = new Set([2147943514, -2147023782]);

function helperCandidates() {
  const relative = path.join("dist", "bridge-runtime", "native", "cwb-win-helper.exe");
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", relative));
  }
  candidates.push(path.join(here, "bridge-runtime", "native", "cwb-win-helper.exe"));
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

export async function tryRunWinHelper(subcommand, options = {}, platform = process.platform) {
  const helperPath = resolveWinHelperPath(platform);
  if (!helperPath) return null;
  try {
    return await execFileAsync(helperPath, [subcommand], {
      encoding: "utf8",
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    if (isHelperLoaderFailure(error)) {
      helperDisabled = true;
      cachedHelperPath = null;
      return null;
    }
    throw error;
  }
}

export function clearWinHelperPathCache() {
  cachedHelperPath = undefined;
  helperDisabled = false;
}
