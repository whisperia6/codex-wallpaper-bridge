export const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAATCSURBVFhHvZdZTyJREIXnh/tkYowP/gQTH33UxCUmGpUoxrgrIOKGqKDgVQEFWaQmX2Wq59o2Lc7DnKTTnV6qTp1a7u1fv0Lo9XruJ0e323WtVst1Op0vz6KOsL8A8p/xT857vZ60Wi1pt9t6zREGz19fX+X9/T3yuY+BCWCoUqlIuVyW29tbOTs7k5OTEymVSvLw8CDX19f6rNPp6PucIdFoNOTj4yNsLoA6Jy/hBwYcN5tNdX58fCx3d3d6/fLyIs/Pz0qA8+Pjoz67v78X5/6a63a78vb21lcJrYl+BGCO0VqtJvV6XQ/IcJ+zHUiNU8jwDuoQvW8HJaJIxBLAyM7OjhrmGkNI+/T0pAaJGodESd5RBkLValUODg702kDN8E0YsQRubm7k6uoqyCPOiBRJyTuOgBHzQT2cn58rOQMkwuhLgA8zmYxGi3FIYJR0nJ6earQAo6hjjpCZdyjKfD6vZOMQEPBbigIjOnKLAa6pBZxwjWGe4Yh8m3PSgBoQQiFSB+k4KIF6ve5wQE6RLZVKqWMkLxaLksvl1BFRkQKixwlETAnyjVoAIihGR0AiDkogkUg4jPHy2tqaFAoF/Zj80+sQo6jGxsZkaGhI9vb21CEkrNB4H1VQwJTjHkrEQQkkk0lnfb2/vy+JREKmpqb0mqhxghLZbFZGR0dleHhYnfMNNcBzc0T0lh7U4hwHJVAsFh3yEen6+roOnMnJSVlcXJRkMqlGyT2yQujo6EgNQ4pnTEZSyDVkiB5yvOPPgygogWaz6ZCL6l5YWNBUYJC0LC8vB4MIBz4ghYPLy0uVG0K8S/uiJiQ44qAESqWSs56nanFsH6MAxmhFv6cBxTk3N6cFSgpoW4hzpjgh5g+jKCiBVCrlyBfOOSgyumF7e1sVQeLQR3pOp9MyMjIiMzMzSh5CkEcNvv8ueqAEGo2GDiLkJP+wp5CIBAWswHhu08z6nXoYHx/XzoEwBDho5bBiUVAC+XxeB5Hl3hwS1dLSkkb25+VPH+OAzpifn9czUaMk0pPSQaAEcrkc2ykttIuLi2DCzc7OqtHDw0NVA+O8Y5OO1NhCRUFyjey2RA8CJZDNZh3SIvvKyoq2GqsgkeMYaXFAQREZOebgHiqQDjqE923V/G4CGpTA7u6upgDjRMxMsFmOUaYj6eAdf/wyF1DLdj98SxDA35TEQQmk02lHdOTfRinOiZ7cQoAeB0SNI0sJxCYmJmR1dVUVgiQ2KMq4rZghqAFySzQYQFYO7jEdIWMKAAxPT0/r1Nza2tJO8Vc9vkXNgbugUCg4IiSv4fUbNSzvFJZPgrViY2NDNjc3PzmjHlAn3DVRUAKZTMaRQ0hYBSMnRomMoqS1yL0tLhBDZuqFEW65xw6Ew4H0QzCK7QYOWXqtj20dgATkbLTaZpS2oxht0eH78JoRh2AxstWQgw5ABaKwLThgRpisnHHMLKA+bEJCdtAZAJQAwCl5wyDREB15hwAGSQdE/Fzbdtz+hAw/VgDY3g9D5NYGie0FANH5u1/uEzlEv9t49EPwa+b/niEv0drYRWIIhZ3gnHsQHmTlC+OTcx/8ZrfbbTqDZZr9oqNVq9Xql19t6qdcLrtKpeJqtZr+qoffiTp8f78BgA7itbHywkMAAAAASUVORK5CYII=";

function wrapAction(action, onError) {
  return () => {
    Promise.resolve()
      .then(action)
      .catch(onError);
  };
}

export function buildTrayMenuTemplate(actions, onError = () => {}) {
  return [
    { label: "打开壁纸设置", click: wrapAction(actions.showWindow, onError) },
    { type: "separator" },
    { label: "应用壁纸", click: wrapAction(actions.apply, onError) },
    { label: "恢复官方外观", click: wrapAction(actions.restore, onError) },
    { label: "打开本地日志目录", click: wrapAction(actions.openLogs, onError) },
    { type: "separator" },
    { label: "退出", click: wrapAction(actions.quit, onError) },
  ];
}

export function createTrayController({
  TrayCtor,
  MenuApi,
  nativeImageApi,
  actions,
  onError = () => {},
}) {
  const icon = nativeImageApi
    .createFromDataURL(TRAY_ICON_DATA_URL)
    .resize({ width: 16, height: 16 });
  const tray = new TrayCtor(icon);
  tray.setToolTip("Lumina");
  tray.setContextMenu(MenuApi.buildFromTemplate(buildTrayMenuTemplate(actions, onError)));
  tray.on("double-click", wrapAction(actions.showWindow, onError));

  return {
    tray,
    showResidentNotice() {
      if (process.platform !== "win32" || typeof tray.displayBalloon !== "function") return;
      tray.displayBalloon({
        title: "Lumina 仍在运行",
        content: "已驻留系统托盘；双击图标可重新打开。",
        iconType: "info",
        noSound: true,
      });
    },
    destroy() {
      tray.destroy();
    },
  };
}
