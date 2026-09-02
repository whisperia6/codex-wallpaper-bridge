import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 180_000;
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(value) {
  return String(value || "").replace(ANSI_PATTERN, "");
}

export function parseControlUrl(output) {
  const match = stripAnsi(output).match(/控制与预览[：:]\s*(https?:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
  return match?.[1] || null;
}

export function buildBridgeArguments(command, port) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1024 || normalizedPort > 65535) {
    throw new Error("CDP 端口必须在 1024 到 65535 之间");
  }
  if (command === "inject") {
    return ["inject", "--cdp-port", String(normalizedPort), "--once", "--no-open"];
  }
  if (command === "restore") return ["restore", "--cdp-port", String(normalizedPort)];
  if (command === "preview") return ["preview", "--cdp-port", String(normalizedPort), "--no-open"];
  throw new Error(`不支持的桥接命令：${command}`);
}

export function resolveBridgeRoot({ isPackaged, appPath, resourcesPath }) {
  return isPackaged
    ? path.join(resourcesPath, "app.asar.unpacked", "dist", "bridge-runtime")
    : path.join(appPath, "bridge-runtime");
}

export function resolveBridgeUtilityPath({ isPackaged, compiledRoot, resourcesPath }) {
  return isPackaged
    ? path.join(resourcesPath, "app.asar.unpacked", "dist", "bridge-utility-entry.mjs")
    : path.join(compiledRoot, "bridge-utility-entry.mjs");
}

function createBridgeProcess({ executablePath, bridgeRoot, args, processFactory }) {
  const cliPath = path.join(bridgeRoot, "src", "cli.mjs");
  if (processFactory) {
    return {
      cliPath,
      child: processFactory(cliPath, args, { cwd: bridgeRoot }),
    };
  }
  return {
    cliPath,
    child: spawn(executablePath, [cliPath, ...args], {
      cwd: bridgeRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }),
  };
}

export async function runBridgeCommand({
  executablePath,
  bridgeRoot,
  command,
  port,
  onLog = () => {},
  timeoutMs = COMMAND_TIMEOUT_MS,
  processFactory,
}) {
  const cliPath = path.join(bridgeRoot, "src", "cli.mjs");
  await access(cliPath);
  const args = buildBridgeArguments(command, port);
  const { child } = createBridgeProcess({ executablePath, bridgeRoot, args, processFactory });
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    const text = stripAnsi(chunk.toString("utf8"));
    stdout += text;
    onLog({ stream: "stdout", text });
  });
  child.stderr?.on("data", (chunk) => {
    const text = stripAnsi(chunk.toString("utf8"));
    stderr += text;
    onLog({ stream: "stderr", text });
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`桥接命令 ${command} 超过 ${Math.ceil(timeoutMs / 1000)} 秒`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(error?.report || error?.type || "桥接进程异常"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `桥接命令退出码 ${code}`));
    });
  });
}

export async function startBridgePreview({
  executablePath,
  bridgeRoot,
  port,
  onLog = () => {},
  processFactory,
}) {
  const cliPath = path.join(bridgeRoot, "src", "cli.mjs");
  await access(cliPath);
  const args = buildBridgeArguments("preview", port);
  const { child } = createBridgeProcess({ executablePath, bridgeRoot, args, processFactory });
  let output = "";

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("壁纸控制页启动超时"));
    }, 30_000);
    const consume = (stream) => (chunk) => {
      const text = stripAnsi(chunk.toString("utf8"));
      output += text;
      onLog({ stream, text });
      const parsedUrl = parseControlUrl(output);
      if (parsedUrl) {
        clearTimeout(timer);
        resolve(parsedUrl);
      }
    };
    child.stdout?.on("data", consume("stdout"));
    child.stderr?.on("data", consume("stderr"));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(error?.report || error?.type || "壁纸控制进程异常"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`壁纸控制页提前退出（${code}）：${output.trim()}`));
    });
  });

  return { child, url };
}
