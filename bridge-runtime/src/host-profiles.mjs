import path from "node:path";

export const HOST_TYPES = Object.freeze(["codex", "antigravity"]);

const ANTIGRAVITY_ORIGIN_PATTERN = /^https:\/\/127\.0\.0\.1:(\d{1,5})$/;
const AUXILIARY_ROUTE_PATTERN = /initialRoute=.*(?:avatar|pet|overlay)/i;
const SAFE_PROXY_VALUE_PATTERN = /^[A-Za-z0-9._:@/,;*=+\[\]-]{1,512}$/;
const PRESERVED_PROXY_FLAGS = new Set([
  "--proxy-server",
  "--proxy-bypass-list",
  "--proxy-pac-url",
]);

function isValidPortNumber(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function normalizeHostType(value, { strict = false, fallback = "codex" } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && HOST_TYPES.includes(value)) return value;
  if (strict) throw new Error(`不支持的目标宿主类型：${String(value)}`);
  return fallback;
}

export function inferHostTypeFromPath(executablePath) {
  const text = String(executablePath || "").trim();
  if (!text) return "codex";
  const normalized = path.win32.normalize(text).toLowerCase();
  const baseName = path.win32.basename(normalized);
  if (baseName === "antigravity.exe" || normalized.includes("\\programs\\antigravity\\")) {
    return "antigravity";
  }
  return "codex";
}

export function installationHostType(installation) {
  if (installation?.hostType === "antigravity") return "antigravity";
  if (installation?.hostType === "codex") return "codex";
  return inferHostTypeFromPath(installation?.path);
}

export function hostDisplayName(hostType) {
  return normalizeHostType(hostType) === "antigravity" ? "Antigravity" : "Codex";
}

export function isAllowedHostOrigin(origin, hostType = "codex") {
  const normalizedHost = normalizeHostType(hostType);
  if (typeof origin !== "string" || !origin) return false;
  if (normalizedHost === "antigravity") {
    const match = ANTIGRAVITY_ORIGIN_PATTERN.exec(origin);
    return Boolean(match && isValidPortNumber(match[1]));
  }
  return origin === "app://-";
}

export function isValidTargetUrlForHost(rawUrl, hostType = "codex") {
  const normalizedHost = normalizeHostType(hostType);
  const url = String(rawUrl || "");
  if (!url || AUXILIARY_ROUTE_PATTERN.test(url)) return false;
  if (normalizedHost === "antigravity") {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && parsed.hostname === "127.0.0.1"
        && !parsed.username
        && !parsed.password
        && isValidPortNumber(parsed.port);
    } catch {
      return false;
    }
  }
  return url.startsWith("app://");
}

export function extractTargetOrigin(rawUrl, hostType = "codex") {
  const normalizedHost = normalizeHostType(hostType);
  if (normalizedHost === "codex") return "app://-";
  if (!isValidTargetUrlForHost(rawUrl, "antigravity")) return null;
  try {
    const parsed = new URL(String(rawUrl));
    return isAllowedHostOrigin(parsed.origin, "antigravity") ? parsed.origin : null;
  } catch {
    return null;
  }
}

function tokenizeCommandLine(commandLine) {
  const text = String(commandLine || "");
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Extracts only allowlisted Chromium proxy switches (e.g. --proxy-server=...)
 * from existing root process command lines so restarting an app in debug mode
 * does not silently drop the user's proxy configuration.
 */
export function extractPreservedLaunchArgs(commandLines) {
  const lines = Array.isArray(commandLines) ? commandLines : [commandLines];
  const preserved = new Map();
  for (const line of lines) {
    const tokens = tokenizeCommandLine(line);
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--") break;
      let flag = null;
      let value = null;
      const eqIndex = token.indexOf("=");
      if (eqIndex > 0) {
        const candidateFlag = token.slice(0, eqIndex);
        if (PRESERVED_PROXY_FLAGS.has(candidateFlag)) {
          flag = candidateFlag;
          value = token.slice(eqIndex + 1);
        }
      } else if (PRESERVED_PROXY_FLAGS.has(token) && index + 1 < tokens.length) {
        flag = token;
        value = tokens[++index];
      }
      if (flag && typeof value === "string" && SAFE_PROXY_VALUE_PATTERN.test(value) && !preserved.has(flag)) {
        preserved.set(flag, `${flag}=${value}`);
      }
    }
  }
  return [...preserved.values()];
}

const DEFAULT_LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "*.local"];

function normalizeProxyUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value || !SAFE_PROXY_VALUE_PATTERN.test(value)) return null;
  if (/^(?:https?|socks5h?|socks4a?):\/\//i.test(value)) return value;
  // Chromium accepts host:port or scheme=host:port mappings; pick http/https target when present.
  const entries = value.split(";").map((part) => part.trim()).filter(Boolean);
  const httpsEntry = entries.find((entry) => /^https=/i.test(entry));
  const httpEntry = entries.find((entry) => /^http=/i.test(entry));
  const chosen = (httpsEntry || httpEntry || entries[0] || "").replace(/^(?:https?)=/i, "");
  if (!chosen) return null;
  return /^(?:https?|socks5h?|socks4a?):\/\//i.test(chosen) ? chosen : `http://${chosen}`;
}

/**
 * Mirrors allowlisted --proxy-server / --proxy-bypass-list CLI flags into
 * HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables so Go/Node backend
 * helpers spawned by Electron apps (such as Antigravity's language server) also
 * route external API calls through the user's proxy while bypassing loopback.
 */
export function buildProxyEnvironment(extraArgs = [], baseEnv = {}) {
  const env = { ...baseEnv };
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  let proxyUrl = null;
  const bypassItems = [];
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--proxy-server=")) {
      proxyUrl ||= normalizeProxyUrl(arg.slice("--proxy-server=".length));
    } else if (arg.startsWith("--proxy-bypass-list=")) {
      const rawBypass = arg.slice("--proxy-bypass-list=".length);
      for (const token of rawBypass.split(/[;,]/)) {
        const trimmed = token.trim();
        if (trimmed && trimmed !== "<-loopback>" && SAFE_PROXY_VALUE_PATTERN.test(trimmed)) {
          bypassItems.push(trimmed);
        }
      }
    }
  }
  if (!proxyUrl) return env;
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
  const existingNoProxy = String(env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const mergedNoProxy = [...new Set([...DEFAULT_LOOPBACK_NO_PROXY, ...existingNoProxy, ...bypassItems])].join(",");
  env.NO_PROXY = mergedNoProxy;
  env.no_proxy = mergedNoProxy;
  return env;
}
