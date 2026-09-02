import assert from "node:assert/strict";
import test from "node:test";
import { buildTrayMenuTemplate, createTrayController } from "../src/tray-controller.mjs";

function actions(log) {
  return {
    showWindow: () => log.push("show"),
    apply: () => log.push("apply"),
    restore: () => log.push("restore"),
    openLogs: () => log.push("logs"),
    quit: () => log.push("quit"),
  };
}

test("tray menu exposes the simplified wallpaper workflow", async () => {
  const calls = [];
  const template = buildTrayMenuTemplate(actions(calls));
  assert.deepEqual(template.filter(({ label }) => label).map(({ label }) => label), [
    "打开壁纸设置",
    "应用到 Codex",
    "恢复官方外观",
    "打开本地日志目录",
    "退出",
  ]);
  template.find(({ label }) => label === "应用到 Codex").click();
  await Promise.resolve();
  assert.deepEqual(calls, ["apply"]);
});

test("tray controller binds menu, double click, notification, and cleanup", async () => {
  const calls = [];
  let builtTemplate = null;
  class FakeTray {
    constructor(icon) {
      this.icon = icon;
      this.handlers = new Map();
      this.destroyed = false;
    }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    on(name, handler) { this.handlers.set(name, handler); }
    displayBalloon(value) { this.balloon = value; }
    destroy() { this.destroyed = true; }
  }
  const controller = createTrayController({
    TrayCtor: FakeTray,
    MenuApi: { buildFromTemplate(template) { builtTemplate = template; return template; } },
    nativeImageApi: {
      createFromDataURL() {
        return { resize: (size) => ({ size }) };
      },
    },
    actions: actions(calls),
  });

  assert.equal(controller.tray.tooltip, "Codex Wallpaper Desktop");
  assert.equal(builtTemplate.length, 7);
  controller.tray.handlers.get("double-click")();
  await Promise.resolve();
  assert.deepEqual(calls, ["show"]);
  controller.showResidentNotice();
  if (process.platform === "win32") assert.match(controller.tray.balloon.content, /系统托盘/);
  controller.destroy();
  assert.equal(controller.tray.destroyed, true);
});
