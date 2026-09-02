const { app, utilityProcess } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const prototypeRoot = path.resolve(__dirname, "..");
const bridgeRoot = path.join(prototypeRoot, "bridge-runtime");
const cliPath = path.join(bridgeRoot, "src", "cli.mjs");
const utilityEntryPath = path.join(prototypeRoot, "src", "bridge-utility-entry.mjs");

app.whenReady().then(() => {
  const child = utilityProcess.fork(utilityEntryPath, ["scan"], {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      CWB_BRIDGE_CLI: cliPath,
    },
    stdio: "pipe",
    serviceName: "Codex Wallpaper Bridge Smoke Test",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    const artifactRoot = path.join(prototypeRoot, "screenshots");
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(path.join(artifactRoot, "utility-smoke-output.txt"), JSON.stringify({ code, output }, null, 2), "utf8");
    process.stdout.write(output);
    app.exit(code);
  });
});
