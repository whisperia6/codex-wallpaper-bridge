const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALgSURBVFhH1ZY9aBRBFMevtEyTzO7dLqv4gRBBI0JUlAQ/ICKYgBiUoKgEokhQYmOqXCOChR+FpNEqhWhhsJAIFsHGq4KFggiChYVgI1barfOfnd3b3fnP3J7HFT74EXL3n/dm3nvz5mr/rQ01hvaLhhjPo7/qjw1Gg54Xelf8UKz5oRc7aEnNLRGJzXppbxZF0YB02PQC8ZsEcxOIZWxcu+rekFYv8H5S5xXBxuuBOKtdVjcRiov/dGoroqlddzYE5056Q2bzvg5htyTtnU8+cmBrfGJ6d8bo+A6qK4NG1qFMU53eoeaT50fiVx8vx5/jBYM3X2bjSwsH6boU1RP1+h4dsmhIEVsEtg+H8cPnUzRwmZX1c/Hw3i3UD5BZWNUh25acnqcezt5+m6PBbGz8mneWxcgChgcTguWXp2mQTqxuXKD+FHJG6NCJyQ/lBDOFM9dGqXOAXnj2bsbaE+DmnSOGT0Xgfdeh02lHRBKWeqQXzZjXHZvcpZqQafO6PFkZ8LAwAWpYdghw7Wz6D3+uG3pbL2QT0g/8KSY4M7vPcPbCVVfJk9fTxhqUkWn90L+hNpC8cqZgbvGQ4ezuyilDl2fx3nFjDT5j2mw8IxVMwBoQd5xpUx6QWYGDMC1untoAxi8THJWNVXaGGmMMM320rRG3flw11hye2En1eHPUBjCEmACgi8sO0QflSYfgbF5gw/gur01B86sNwOS9/MpErKYAG7v9+KT6Hn/ZyQHGN/OLqSuv/yYd3v4OYPeuQeMCm8Ibwvwa7wGGAhMC1JDd706Uh1UBefV16LZhV1QsQUOyScfAyV3BZZz3OmTRXFkAKMfSowkaNAU1t6U9g50+NdermAfjeL45ppoQDw7+t3V7gfIryEym6Cld3DutQufbDKI+bALBB3SIaoZZTRx1j0x7pZMz02N63XBaATlsPjkbrhuDI5Slyk92mbm1bM73w5Ks4LagRG3weXeprtX+AsG6Lr5ynmOWAAAAAElFTkSuQmCC";

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
    { label: "应用到 Codex", click: wrapAction(actions.apply, onError) },
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
  tray.setToolTip("Codex Wallpaper Desktop");
  tray.setContextMenu(MenuApi.buildFromTemplate(buildTrayMenuTemplate(actions, onError)));
  tray.on("double-click", wrapAction(actions.showWindow, onError));

  return {
    tray,
    showResidentNotice() {
      if (process.platform !== "win32" || typeof tray.displayBalloon !== "function") return;
      tray.displayBalloon({
        title: "Codex Wallpaper Desktop 仍在运行",
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
