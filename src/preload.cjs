const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cwbDesktop", {
  getState: () => ipcRenderer.invoke("cwb:get-state"),
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
