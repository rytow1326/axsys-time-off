// Exposes a small, safe API to the page. The page has no direct Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  version: () => ipcRenderer.invoke("app:version"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  notify: (title, body) => ipcRenderer.invoke("app:notify", { title, body }),
  setBadge: (count) => ipcRenderer.invoke("app:set-badge", count),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  onUpdateReady: (cb) => ipcRenderer.on("app:update-ready", (_e, version) => cb(version)),
});
