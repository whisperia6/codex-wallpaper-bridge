const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cwbDesktop", {
  windowChrome: process.platform === "win32",
  setWorkbenchTheme: (theme) => ipcRenderer.invoke("cwb:set-workbench-theme", theme),
  getState: () => ipcRenderer.invoke("cwb:get-state"),
  getUpdateState: () => ipcRenderer.invoke("cwb:get-update-state"),
  checkUpdates: () => ipcRenderer.invoke("cwb:check-updates"),
  dismissUpdate: (version) => ipcRenderer.invoke("cwb:dismiss-update", { version }),
  openUpdateUrl: (version) => ipcRenderer.invoke("cwb:open-update-url", { version }),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("cwb:update-state", listener);
    return () => ipcRenderer.off("cwb:update-state", listener);
  },
  refreshInstallations: () => ipcRenderer.invoke("cwb:refresh-installations"),
  chooseExecutable: () => ipcRenderer.invoke("cwb:choose-executable"),
  applyCodex: (options) => ipcRenderer.invoke("cwb:apply-codex", options),
  restore: (options) => ipcRenderer.invoke("cwb:restore", options),
  openControlPanel: (options) => ipcRenderer.invoke("cwb:open-control-panel", options),
  onTrayAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("cwb:tray-action", listener);
    return () => ipcRenderer.off("cwb:tray-action", listener);
  },
});
