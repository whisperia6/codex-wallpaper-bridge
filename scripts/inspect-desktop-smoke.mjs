import { WebSocket } from "ws";

const port = Number(process.argv[2] || 9455);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("调试端口必须在 1024 到 65535 之间");
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page" && entry.title === "Codex Wallpaper Desktop");
if (!target?.webSocketDebuggerUrl) throw new Error("没有找到桌面主窗口 CDP target");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("连接桌面 CDP 超时")), 5_000);
  socket.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.once("error", reject);
});

const expression = `JSON.stringify({
  title: document.title,
  status: document.querySelector('#statusText')?.textContent || null,
  controlState: document.querySelector('#controlState span')?.textContent || null,
  frameSrc: document.querySelector('#controlFrame')?.src || null,
  log: document.querySelector('#logOutput')?.textContent || null
})`;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("读取桌面状态超时")), 5_000);
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result.result.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression,
      returnByValue: true,
    },
  }));
});

socket.close();
console.log(result);
