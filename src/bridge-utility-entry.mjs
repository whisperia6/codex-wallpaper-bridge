import { pathToFileURL } from "node:url";

const cliPath = process.env.CWB_BRIDGE_CLI;
const command = process.argv[2] || "preview";
const isOneShot = command === "inject" && process.argv.includes("--once");
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
let isExitScheduled = false;

function scheduleExit(code) {
  if (isExitScheduled) return;
  isExitScheduled = true;
  setTimeout(() => process.exit(code), 40);
}

function isTerminalSuccess(message) {
  if (command === "scan") return message.trimStart().startsWith("{");
  if (command === "restore") return message.includes("已清除 Codex renderer");
  return isOneShot && message.includes("一次性注入完成");
}

console.log = (...values) => {
  originalLog(...values);
  const message = values.map(String).join(" ");
  if (isTerminalSuccess(message)) scheduleExit(0);
};
console.error = (...values) => {
  originalError(...values);
  const message = values.map(String).join(" ");
  if (message.includes("错误：")) scheduleExit(1);
};

if (!cliPath) {
  originalError("错误：缺少 CWB_BRIDGE_CLI");
  scheduleExit(1);
} else {
  import(pathToFileURL(cliPath).href).catch((error) => {
    originalError(`错误：${error.message}`);
    scheduleExit(1);
  });
}
