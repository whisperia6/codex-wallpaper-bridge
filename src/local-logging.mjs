const LOOPBACK_SESSION_PATTERN = /(https?:\/\/127\.0\.0\.1:\d+\/)[A-Za-z0-9_-]{22,}(?=\/)/g;
const NAMED_SECRET_PATTERN = /(["']?(?:token|sessionToken)["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{22,}/gi;

export function sanitizeLogText(value) {
  return String(value || "")
    .replace(LOOPBACK_SESSION_PATTERN, "$1[session]")
    .replace(NAMED_SECRET_PATTERN, "$1[redacted]");
}

export function dailyLogFilename(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `codex-wallpaper-${year}-${month}-${day}.log`;
}

export function formatLogEntry(entry) {
  const at = entry?.at || new Date().toISOString();
  const stream = String(entry?.stream || "system").toUpperCase();
  const text = sanitizeLogText(entry?.text);
  return `[${at}] [${stream}] ${text}${text.endsWith("\n") ? "" : "\n"}`;
}
