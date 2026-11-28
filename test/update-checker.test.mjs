import assert from "node:assert/strict";
import test from "node:test";
import {
  UPDATE_CHECK_COOLDOWN_MS, checkForUpdates, compareUpdateVersions, dismissUpdate,
  getUpdateState, isAllowedReleaseUrl, normalizeUpdateVersion,
} from "../src/update-checker.mjs";

const repo = "https://github.com/whisperia6/lumina/releases/";
const latest = { tag_name: "v1.4.0", html_url: repo + "tag/v1.4.0", draft: false, prerelease: false };
const ok = (release = latest) => ({ ok: true, json: async () => release });
const check = (options = {}) => checkForUpdates({ currentVersion: "1.3.1", now: () => 42, fetchImpl: async () => ok(), ...options });

test("stable version comparison is strict and numeric", () => {
  assert.equal(normalizeUpdateVersion("v1.4.0"), "1.4.0");
  assert.equal(compareUpdateVersions("1.10.0", "v1.9.9"), 1);
  assert.equal(compareUpdateVersions("1.3.9", "1.4.0"), -1);
  assert.equal(compareUpdateVersions("0.0.0", "v0.0.0"), 0);
  assert.equal(compareUpdateVersions("1.0.9007199254740993", "1.0.9007199254740992"), 1);
  for (const invalid of ["01.2.3", "1.2", "1.2.3.4", " 1.2.3", "1.2.3\n", "1.2.3-beta", "1.2.3+build", "V1.2.3"]) {
    assert.equal(compareUpdateVersions(invalid, "1.2.3"), null, invalid);
  }
});

test("only newer stable releases produce a notice", async () => {
  const settings = await check({
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/whisperia6/lumina/releases/latest");
      assert.equal(options.redirect, "error");
      return ok();
    },
  });
  assert.deepEqual(getUpdateState(settings, "1.3.1"), { updateAvailable: true, version: "1.4.0", releaseUrl: latest.html_url });
  assert.deepEqual(getUpdateState(settings, "1.4.0"), { updateAvailable: false });
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: "v1.4.0-beta" }, { tag_name: "v1.3.1" }, { tag_name: "0.9.0" }]) {
    assert.equal((await check({ fetchImpl: async () => ok({ ...latest, ...patch }) })).latestUpdate, null);
  }
});

test("release URLs are validated before they can enter update state", async () => {
  assert.equal(isAllowedReleaseUrl(latest.html_url), true);
  for (const url of [
    "http://github.com/whisperia6/lumina/releases/tag/v1.4.0",
    "https://github.com.evil.example/whisperia6/lumina/releases/tag/v1.4.0",
    "https://github.com/other/lumina/releases/tag/v1.4.0",
    repo + "../../other/releases/tag/v1.4.0", repo + "%2e%2e/tag/v1.4.0",
    repo + "tag/v1.4.0\n", repo + "tag/v1.4.0?redirect=https://example.com", repo,
  ]) {
    assert.equal(isAllowedReleaseUrl(url), false, url);
    assert.equal((await check({ fetchImpl: async () => ok({ ...latest, html_url: url }) })).latestUpdate, null);
  }
});

test("cooldown and version-specific dismissal survive settings reload", async () => {
  const first = await check();
  assert.equal(dismissUpdate(first, "1.3.1", "1.3.9").dismissedUpdateVersion, null);
  const persisted = JSON.parse(JSON.stringify(dismissUpdate(first, "1.3.1", "v1.4.0")));
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return ok({ ...latest, tag_name: "v1.5.0", html_url: repo + "tag/v1.5.0" });
  };
  assert.deepEqual(await check({ settings: persisted, fetchImpl, now: () => 42 + UPDATE_CHECK_COOLDOWN_MS - 1 }), persisted);
  assert.equal(count, 0);
  assert.deepEqual(getUpdateState(persisted, "1.3.1"), { updateAvailable: false });
  const next = await check({ settings: persisted, fetchImpl, now: () => 42 + UPDATE_CHECK_COOLDOWN_MS });
  assert.equal(count, 1);
  assert.equal(next.dismissedUpdateVersion, "1.4.0");
  assert.equal(getUpdateState(next, "1.3.1").version, "1.5.0");
});

test("non-2xx update responses cancel their body and release the request even if cancellation rejects", async () => {
  const previous = await check();
  for (const cancelRejects of [false, true]) {
    let cancellations = 0;
    let signal;
    const result = await check({
      settings: previous,
      now: () => 42 + UPDATE_CHECK_COOLDOWN_MS,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        const body = new ReadableStream({
          cancel() {
            cancellations++;
            if (cancelRejects) throw new Error("cancel failed");
          },
        });
        return new Response(body, { status: 429 });
      },
    });
    assert.equal(cancellations, 1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(result.latestUpdate, previous.latestUpdate);
  }
});

test("network, rate limits, invalid JSON and hung bodies fail silently", async () => {
  for (const fetchImpl of [
    async () => { throw Error("offline"); },
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, json() { throw Error("invalid JSON"); } }),
  ]) {
    const settings = await check({ fetchImpl });
    assert.deepEqual(getUpdateState(settings, "1.3.1"), { updateAvailable: false });
    assert.equal(settings.lastUpdateCheckAt, 42);
  }
  const first = await check();
  let signal;
  const timedOut = await check({ settings: first, now: () => 42 + UPDATE_CHECK_COOLDOWN_MS, timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    },
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(timedOut.latestUpdate, first.latestUpdate);
});
