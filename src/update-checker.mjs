const endpoint = "https://api.github.com/repos/whisperia6/lumina/releases/latest";
const releasePrefix = "https://github.com/whisperia6/lumina/releases/";
export const UPDATE_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function normalizeUpdateVersion(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(value);
  return match?.[0] === value ? match[1] : null;
}

export function compareUpdateVersions(left, right) {
  const a = normalizeUpdateVersion(left);
  const b = normalizeUpdateVersion(right);
  if (!a || !b) return null;
  const leftParts = a.split(".");
  const rightParts = b.split(".");
  for (const [index, part] of leftParts.entries()) {
    const other = rightParts[index];
    if (part.length !== other.length) return part.length > other.length ? 1 : -1;
    if (part !== other) return part > other ? 1 : -1;
  }
  return 0;
}

export function isAllowedReleaseUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith(releasePrefix)
    || /[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.pathname.startsWith(new URL(releasePrefix).pathname)
      && value.length > releasePrefix.length && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function normalizeUpdateSettings(value = {}) {
  const releaseVersion = normalizeUpdateVersion(value.latestUpdate?.version);
  const releaseUrl = value.latestUpdate?.releaseUrl;
  return {
    lastUpdateCheckAt: Number.isSafeInteger(value.lastUpdateCheckAt) && value.lastUpdateCheckAt >= 0
      ? value.lastUpdateCheckAt : null,
    dismissedUpdateVersion: normalizeUpdateVersion(value.dismissedUpdateVersion),
    latestUpdate: releaseVersion && isAllowedReleaseUrl(releaseUrl) ? { version: releaseVersion, releaseUrl } : null,
  };
}

export function getUpdateState(settings, currentVersion) {
  const { latestUpdate, dismissedUpdateVersion } = normalizeUpdateSettings(settings);
  if (!latestUpdate || latestUpdate.version === dismissedUpdateVersion
    || compareUpdateVersions(latestUpdate.version, currentVersion) !== 1) return { updateAvailable: false };
  return { updateAvailable: true, ...latestUpdate };
}

export function dismissUpdate(settings, currentVersion, version) {
  const normalized = normalizeUpdateSettings(settings);
  const state = getUpdateState(normalized, currentVersion);
  if (state.updateAvailable && normalizeUpdateVersion(version) === state.version) {
    return { ...normalized, dismissedUpdateVersion: state.version };
  }
  return normalized;
}

export async function checkForUpdates({
  settings = {}, currentVersion, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000,
} = {}) {
  const previous = normalizeUpdateSettings(settings);
  const checkedAt = now();
  if (!normalizeUpdateVersion(currentVersion) || (previous.lastUpdateCheckAt !== null
    && checkedAt >= previous.lastUpdateCheckAt && checkedAt - previous.lastUpdateCheckAt < UPDATE_CHECK_COOLDOWN_MS)) {
    return previous;
  }
  const next = { ...previous, lastUpdateCheckAt: checkedAt };
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("update_check_timeout"));
    }, timeoutMs);
  });
  try {
    const request = async () => {
      const response = await fetchImpl(endpoint, {
        redirect: "error",
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel?.();
        } finally {
          controller.abort();
        }
        throw new Error("update_check_unavailable");
      }
      return response.json();
    };
    const release = await Promise.race([request(), timeout]);
    const version = normalizeUpdateVersion(release?.tag_name);
    const releaseUrl = release?.html_url;
    next.latestUpdate = version && release.draft !== true && release.prerelease !== true
      && compareUpdateVersions(version, currentVersion) === 1 && isAllowedReleaseUrl(releaseUrl)
      ? { version, releaseUrl } : null;
  } catch {
    // Keep a previously verified release through offline and rate-limit failures.
  } finally {
    clearTimeout(timer);
  }
  return next;
}
