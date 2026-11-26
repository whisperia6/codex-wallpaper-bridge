import assert from "node:assert/strict";
import test from "node:test";
import {
  assertChildPath,
  assertProtectedPackageEntries,
  assertProtectedUnpackedEntries,
  windowsArtifactNames,
  COMPILED_BRIDGE_UNPACKED_FILES,
} from "../src/package-layout.mjs";

test("manual package paths stay inside the prototype output root", () => {
  assert.equal(
    assertChildPath("D:\\project\\electron-prototype", "D:\\project\\electron-prototype\\out\\app"),
    "D:\\project\\electron-prototype\\out\\app",
  );
  assert.throws(
    () => assertChildPath("D:\\project\\electron-prototype", "D:\\project\\bridge"),
    /之外/,
  );
});

test("Windows package names are stable and versioned", () => {
  assert.deepEqual(windowsArtifactNames("Lumina", "0.1.0"), {
    builderArtifactName: "Lumina-0.1.0-Setup.exe",
    installerName: "Lumina-0.1.0-Setup.exe",
    releaseDirectoryName: "release-0.1.0",
    scratchDirectoryName: ".nsis-build",
    unpackedDirectoryName: "win-unpacked",
  });
});

test("protected ASAR layout contains only compiled application entries", () => {
  const entries = [
    "/package.json",
    "/dist/main.mjs",
    "/dist/preload.cjs",
    "/dist/engine-vp8-preload.cjs",
    "/dist/bridge-utility-entry.mjs",
    "/dist/bridge-runtime/src/cli.mjs",
    "/dist/bridge-runtime/public/index.html",
    "/dist/renderer/index.html",
  ];
  assert.deepEqual(assertProtectedPackageEntries(entries), entries);
  assert.throws(
    () => assertProtectedPackageEntries([...entries, "/src/main.mjs"]),
    /源码路径/,
  );
  assert.throws(
    () => assertProtectedPackageEntries([...entries, "/dist/main.mjs.map"]),
    /源码路径/,
  );
});

test("ASAR unpack allows only the compiled bridge runtime", () => {
  const entries = [...COMPILED_BRIDGE_UNPACKED_FILES];
  assert.deepEqual(assertProtectedUnpackedEntries(entries), entries);
  assert.throws(
    () => assertProtectedUnpackedEntries([
      ...entries,
      "dist/bridge-runtime/src/cdp-injector.mjs",
    ]),
    /未批准/,
  );
  for (const entry of ['dist/bridge-runtime/src/engine-vp8-preload.cjs', 'dist/bridge-runtime/vendor/webwallgl/mediabunny-LICENSE',
    'dist/bridge-runtime/vendor/webwallgl/sources/mediabunny-1.56.0.tgz']) {
    assert.throws(() => assertProtectedUnpackedEntries(entries.filter((value) => value !== entry)), /缺少/);
  }
});
