import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { classifyInitialTargetCohort, isVerifierRendererTarget } from "../scripts/verify-live-host.mjs";
import { createWorkbenchReport, operationFailureReason, ownershipFailureReason, parseArguments as parseWorkbenchArguments, visibleMediaReferenceMatches } from "../scripts/verify-live-workbench.mjs";

const execFileAsync = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repository, "scripts", "verify-live-host.mjs");
const acceptanceRoot = path.join(repository, "out", "live-acceptance");
const unique = `verifier-guard-test-${process.pid}-${Date.now()}`;
// These paths deliberately do not exist. Rejected inputs must not create them.
const untouchedRoot = path.join(acceptanceRoot, unique);
const externalRoot = path.join(os.tmpdir(), `${unique}-external`);
const siblingRoot = `${acceptanceRoot}-${unique}`;
const baseline = {
  "--port": "19335",
  "--expected-exe": process.execPath,
  "--expected-profile": path.join(untouchedRoot, "test-profile"),
  "--expected-pid": "123456789",
  "--output": path.join(untouchedRoot, "report.json"),
};
const argsFor = (overrides = {}, omitted = []) => Object.entries({ ...baseline, ...overrides })
  .filter(([key]) => !omitted.includes(key)).flat();

async function assertNoFilesCreated(extraPaths = []) {
  for (const candidate of [untouchedRoot, externalRoot, siblingRoot, ...extraPaths]) {
    await assert.rejects(stat(candidate), { code: "ENOENT" }, `rejected verifier unexpectedly created ${path.basename(candidate)}`);
  }
}

const STRIPPED_VERIFIER_ENV_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

async function rejectedBeforeHost(args, expectedReason, { nodeArguments = null, extraPaths = [] } = {}) {
  let result;
  try {
    result = await execFileAsync(process.execPath, nodeArguments || [script, ...args], {
      cwd: repository,
      // PowerShell and subprocess binaries are intentionally not available on PATH.
      // Strip proxy/Node option env vars too so experimental runtime warnings do not pollute stderr.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIPPED_VERIFIER_ENV_KEYS.has(key.toUpperCase()))),
      windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    });
    assert.fail("invalid verifier input unexpectedly succeeded");
  } catch (error) {
    assert.equal(error.code, 1, "verifier must exit with validation failure, not timeout or process-launch failure");
    result = error;
  }
  assert.equal(result.stdout, "", "host lifecycle steps must not run for invalid input");
  const lines = result.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, "validation must emit only one sanitized status record");
  const failure = JSON.parse(lines[0]);
  assert.equal(failure.status, "fail");
  assert.match(failure.reason, expectedReason);
  assert.deepEqual(Object.keys(failure).sort(), ["reason", "status"]);
  await assertNoFilesCreated(extraPaths);
}

test("live verifier rejects missing, duplicate, and unknown arguments before host access", async () => {
  await rejectedBeforeHost([], /invalid port/);
  for (const key of Object.keys(baseline)) {
    const reason = key === "--port" ? /invalid port/
      : key === "--expected-pid" ? /invalid host PID/
        : key === "--expected-exe" ? /absolute expectedExe/
          : key === "--expected-profile" ? /absolute expectedProfile/ : /absolute output/;
    await rejectedBeforeHost(argsFor({}, [key]), reason);
  }
  await rejectedBeforeHost([...argsFor(), "--port", "19336"], /missing or duplicate argument/);
  await rejectedBeforeHost([...argsFor(), "--output"], /missing or duplicate argument/);
  await rejectedBeforeHost([...argsFor(), "--launch-host", "true"], /unsupported argument/);
  await rejectedBeforeHost(argsFor({ "--expected-exe": "" }), /missing or duplicate argument/);
});

test("live verifier rejects invalid ports and PIDs without probing any listener", async () => {
  for (const port of ["1023", "65536", "19335.5", "not-a-port"]) {
    await rejectedBeforeHost(argsFor({ "--port": port }), /invalid port/);
  }
  for (const pid of ["0", "-1", "1.5", "not-a-pid", "9007199254740992"]) {
    await rejectedBeforeHost(argsFor({ "--expected-pid": pid }), /invalid host PID/);
  }
  const selfPidSource = `
    import { pathToFileURL } from 'node:url';
    const script = ${JSON.stringify(script)};
    const args = ${JSON.stringify(argsFor())};
    args[args.indexOf('--expected-pid') + 1] = String(process.pid);
    process.argv = [process.execPath, script, ...args];
    await import(pathToFileURL(script).href);
  `;
  await rejectedBeforeHost([], /invalid host PID/, { nodeArguments: ["--input-type=module", "--eval", selfPidSource] });
});

test("live verifier requires absolute executable, profile, and JSON report paths", async () => {
  for (const [key, reason] of [
    ["--expected-exe", /absolute expectedExe/],
    ["--expected-profile", /absolute expectedProfile/],
    ["--output", /absolute output/],
  ]) {
    await rejectedBeforeHost(argsFor({ [key]: "relative-path" }), reason);
  }
  await rejectedBeforeHost(argsFor({ "--output": path.join(untouchedRoot, "report.txt") }), /output must be a JSON file/);
});

test("live verifier rejects external output and profile paths without creating files", async () => {
  const outsideReport = path.join(externalRoot, "report.json");
  const outsideProfile = path.join(externalRoot, "profile");
  await rejectedBeforeHost(argsFor({ "--output": outsideReport }), /output and test profile must stay in out\/live-acceptance/);
  await rejectedBeforeHost(argsFor({ "--expected-profile": outsideProfile }), /output and test profile must stay in out\/live-acceptance/);
  await rejectedBeforeHost(argsFor({ "--output": outsideReport, "--expected-profile": outsideProfile }), /output and test profile must stay in out\/live-acceptance/);
  const dailyProfile = path.join(process.env.APPDATA || os.homedir(), "Codex");
  await rejectedBeforeHost(argsFor({ "--expected-profile": dailyProfile }), /output and test profile must stay in out\/live-acceptance/);
});

test("live verifier rejects prefix siblings and traversal escaping the acceptance root", async () => {
  await rejectedBeforeHost(argsFor({ "--output": path.join(siblingRoot, "report.json") }), /output and test profile must stay in out\/live-acceptance/);
  await rejectedBeforeHost(argsFor({ "--expected-profile": path.join(siblingRoot, "profile") }), /output and test profile must stay in out\/live-acceptance/);
  const escapedRoot = path.join(repository, "out", `${unique}-escaped`);
  const traversal = `${acceptanceRoot}${path.sep}..${path.sep}${path.basename(escapedRoot)}${path.sep}report.json`;
  await rejectedBeforeHost(argsFor({ "--output": traversal }), /output and test profile must stay in out\/live-acceptance/, { extraPaths: [escapedRoot] });
  await rejectedBeforeHost(argsFor({ "--expected-profile": acceptanceRoot }), /output and test profile must stay in out\/live-acceptance/);
});

function page(id, url = "app://-/index.html") {
  return { id, type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1:19335/devtools/page/${id}` };
}

test("initial target cohort records actual closures without adopting additional pages", () => {
  const result = classifyInitialTargetCohort(["initial-a", "initial-b"], [page("initial-a"), page("new-c")]);
  assert.deepEqual(result.liveInitial.map(({ id }) => id), ["initial-a"]);
  assert.deepEqual(result.closedInitialIds, ["initial-b"]);
  assert.deepEqual(result.additional.map(({ id }) => id), ["new-c"]);
  assert.equal(result.liveInitial.some(({ id }) => id === "new-c"), false);
});

test("navigation or a changed socket endpoint does not pretend an existing target closed", () => {
  const navigating = page("initial-a", "about:blank");
  const replacementSocket = { ...page("initial-b"), webSocketDebuggerUrl: "ws://127.0.0.1:19335/devtools/page/reconnected" };
  const result = classifyInitialTargetCohort(new Set(["initial-a", "initial-b"]).keys(), [navigating, replacementSocket]);
  assert.deepEqual(result.closedInitialIds, []);
  assert.deepEqual(result.liveInitial, [navigating, replacementSocket]);
  assert.deepEqual(result.additional, []);
});

test("a wholly closed initial cohort remains empty even when a new app target exists", () => {
  const result = classifyInitialTargetCohort(["initial-a", "initial-b"], [page("new-c")]);
  assert.deepEqual(result.liveInitial, []);
  assert.deepEqual(result.closedInitialIds, ["initial-a", "initial-b"]);
  assert.deepEqual(result.additional.map(({ id }) => id), ["new-c"]);
});

test("additional target observation uses the injector's app-page auxiliary exclusions", () => {
  const candidates = [
    page("app"), page("pet", "app://-/index.html?initialRoute=pet"),
    page("avatar", "app://-/index.html?initialRoute=avatar"), page("overlay", "app://-/index.html?initialRoute=overlay"),
    page("browser", "https://example.invalid/"), { ...page("worker"), type: "worker" },
  ];
  assert.deepEqual(candidates.filter(isVerifierRendererTarget).map(({ id }) => id), ["app"]);
  assert.deepEqual(classifyInitialTargetCohort([], candidates).additional.map(({ id }) => id), ["app"]);
});

const workbenchArgs = ["--run-root", untouchedRoot, "--desktop-pid", "123456789", "--desktop-port", "19336"];

test("workbench distinguishes owner-query timeouts from changed identity without echoing diagnostics", () => {
  for (const [error, reason] of [[{ killed: true, stderr: "SECRET_PROFILE" }, "owner_query_timeout_or_terminated"],
    [{ code: "ENOENT" }, "owner_query_executable_unavailable"], [{ code: "EPERM" }, "owner_query_access_rejected"],
    [new Error("SECRET_PROFILE raw command"), "process_ownership_or_creation_changed"]]) {
    assert.equal(ownershipFailureReason(error), reason);
  }
});

test("workbench transient CDP failures use fixed diagnostic codes without raw messages", () => {
  assert.equal(operationFailureReason(new Error("CDP socket closed")), "cdp_socket_closed");
  assert.equal(operationFailureReason(new Error("renderer metadata evaluation failed")), "renderer_metadata_evaluation_failed");
  assert.equal(operationFailureReason(new Error("SECRET_PROFILE raw diagnostics")), "operation_failed_raw_diagnostics_omitted");
});

test("workbench scope defaults to full and preserves explicit full and output-name", () => {
  const implicit = parseWorkbenchArguments(workbenchArgs);
  assert.equal(implicit.scope, "full");
  assert.equal(implicit.outputName, "report.json");
  assert.deepEqual(parseWorkbenchArguments([...workbenchArgs, "--scope", "full"]), implicit);
  const control = parseWorkbenchArguments([...workbenchArgs, "--scope", "control-only", "--output-name", "control-only.json"]);
  assert.equal(control.scope, "control-only");
  assert.equal(control.outputName, "control-only.json");
});

test("workbench rejects unsupported, missing and duplicate scopes without host access", async () => {
  for (const scope of ["", "partial", "FULL", "control_only"]) {
    assert.throws(() => parseWorkbenchArguments([...workbenchArgs, "--scope", scope]), /missing_or_duplicate_argument|invalid_verification_scope/);
  }
  assert.throws(() => parseWorkbenchArguments([...workbenchArgs, "--scope"]), /missing_or_duplicate_argument/);
  assert.throws(() => parseWorkbenchArguments([...workbenchArgs, "--scope", "full", "--scope", "control-only"]), /missing_or_duplicate_argument/);
  assert.throws(() => parseWorkbenchArguments([...workbenchArgs, "--output-name", "../report.json"]), /invalid_output_basename/);
  await assertNoFilesCreated();
});

test("workbench reports explicit restricted scope without granting visible playback or M0 acceptance", () => {
  for (const scope of ["full", "control-only"]) {
    const report = createWorkbenchReport(scope);
    assert.equal(report.verificationScope, scope);
    assert.equal(report.completeM0Gate, false);
    assert.equal(report.hiddenVideoPlaybackVerified, false);
    assert.equal(report.visibleVideoPlaybackVerified, false);
    assert.equal(report.mediaReferenceVerified, false);
    assert.equal(report.hostActivationRequested, false);
    assert.deepEqual(report.steps, []);
  }
  assert.match(createWorkbenchReport("control-only").scopeReason, /no_host_activation_or_visible_video_progression/);
  assert.match(createWorkbenchReport("full").scope, /programmatic-real-workbench/);
  assert.throws(() => createWorkbenchReport("partial"), /invalid_verification_scope/);
});

test("workbench media-reference contract rejects empty, changed, hidden and incomplete cohorts", () => {
  const visible = { targetIndex: 0, hidden: false, referenceUnchanged: true,
    video: { width: 1920, height: 1080, readyState: 2, errorCode: 0 } };
  const hidden = { ...visible, targetIndex: 1, hidden: true, referenceUnchanged: false };
  assert.equal(visibleMediaReferenceMatches([hidden], new Set()), false);
  assert.equal(visibleMediaReferenceMatches([visible, hidden], new Set([0])), true);
  assert.equal(visibleMediaReferenceMatches([visible], new Set([0, 1])), false);
  for (const value of [{ ...visible, referenceUnchanged: false }, { ...visible, hidden: true }, { ...visible, video: null },
    { ...visible, video: { ...visible.video, readyState: 1 } }, { ...visible, video: { ...visible.video, errorCode: 4 } }]) {
    assert.equal(visibleMediaReferenceMatches([value], new Set([0])), false);
  }
});

test("workbench control-only contract keeps activation and playback in the full-only branch", async () => {
  const source = await readFile(path.join(repository, "scripts", "verify-live-workbench.mjs"), "utf8");
  const branch = source.slice(source.indexOf('if (options.scope === "full") {\n      await step("activate-one-existing-independent-host-page"'),
    source.indexOf('await step(options.scope === "full" ? "safe-real-apply-preserves-existing-media-reference"'));
  assert.ok(branch.length > 0, "full-only host activation/playback branch is required");
  const restricted = branch.slice(branch.indexOf('} else {\n      unverified("activate-one-existing-independent-host-page"'));
  assert.match(branch, /Page\.bringToFront/);
  assert.match(branch, /real_visible_cohort_video_time_did_not_advance/);
  assert.match(restricted, /values\.every\(\(value\) => layers\(value, true\)\)/);
  assert.match(restricted, /control_only_scope_does_not_activate_host_pages/);
  assert.match(restricted, /control_only_scope_does_not_measure_visible_video_progression/);
  assert.doesNotMatch(restricted, /Page\.bringToFront|currentTime|pause\(1500\)/);
  assert.match(source, /if \(hiddenPauseControlPresent && options\.scope === "full"\)/);
  assert.match(source, /hiddenPauseUiMutationPerformed: hiddenPauseUiMutationPerformed === true/);
  assert.match(source, /if \(options\.scope === "control-only"\) requireCondition\(saved\.effects\.pauseWhenHidden === pauseWhenHiddenBefore/);
  assert.doesNotMatch(source, /defineProperty\([^\n]*hidden|document\.hidden\s*=|\.textContent\b|\.innerHTML\b/);
});

test("workbench control-only requires all-target safe layers and does not pass an empty media-reference cohort", async () => {
  const source = await readFile(path.join(repository, "scripts", "verify-live-workbench.mjs"), "utf8");
  assert.match(source, /values\.every\(\(value\) => layers\(value, false\)\)/);
  assert.match(source, /report\.mediaReferenceVerified = visibleCohort\.size > 0/);
  assert.match(source, /unverified\("safe-real-apply-preserves-existing-media-reference", "control_only_scope_has_no_naturally_visible_host_cohort"\)/);
  assert.match(source, /disk\.effects\?\.brightness === 83/);
  for (const name of ["click-existing-real-video-library-card", "brightness-input-immediately-followed-by-real-apply-click",
    "save-handshake-api-and-disk-agree", "desktop-workbench-screenshot-only", "compact-emulated-viewport-layout", "real-workbench-restore-clears-both-host-layers"]) {
    assert.ok(source.includes(`await step("${name}"`), `${name} must remain an actual operation`);
  }
  assert.match(source, /open\(reportPath, "wx"\)/);
  assert.match(source, /writeFile\(path\.join\(resolvedRun, screenshotName\)[^\n]+flag: "wx"/);
  assert.match(source, /cleanup-restore-through-verified-real-workbench/);
  assert.doesNotMatch(source, /completeM0Gate:\s*true|completeM0Gate\s*=\s*true/);
});
