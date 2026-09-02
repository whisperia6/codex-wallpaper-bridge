const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cwbDesktop", {
  getState: () => ipcRenderer.invoke("cwb:get-state"),
  refreshInstallations: () => ipcRenderer.invoke("cwb:refresh-installations"),
  chooseExecutable: () => ipcRenderer.invoke("cwb:choose-executable"),
  launchCodex: (options) => ipcRenderer.invoke("cwb:launch-codex", options),
  injectOnce: (options) => ipcRenderer.invoke("cwb:inject-once", options),
  restore: (options) => ipcRenderer.invoke("cwb:restore", options),
  exportDiagnostics: (options) => ipcRenderer.invoke("cwb:export-diagnostics", options),
  openControlPanel: (options) => ipcRenderer.invoke("cwb:open-control-panel", options),
  revealDiagnostics: (diagnosticPath) => ipcRenderer.invoke("cwb:reveal-diagnostics", diagnosticPath),
  onTrayAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("cwb:tray-action", listener);
    return () => ipcRenderer.off("cwb:tray-action", listener);
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("cwb:log", listener);
    return () => ipcRenderer.off("cwb:log", listener);
  },
});
