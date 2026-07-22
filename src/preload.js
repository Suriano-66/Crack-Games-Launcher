const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  openLink: (url) => ipcRenderer.send("open:link", url),
  openGameDir: () => ipcRenderer.send("open:gamedir"),

  // Auth / comptes
  login: () => ipcRenderer.invoke("auth:login"),
  restore: () => ipcRenderer.invoke("auth:restore"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  switchAccount: (uuid) => ipcRenderer.invoke("auth:switch", uuid),
  listAccounts: () => ipcRenderer.invoke("accounts:list"),

  // Serveurs / actus
  getServers: () => ipcRenderer.invoke("servers:get"),
  pingServers: (list) => ipcRenderer.invoke("servers:ping", list),
  getNews: () => ipcRenderer.invoke("news:get"),

  // Paramètres
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),

  // Jeu
  launch: (server) => ipcRenderer.invoke("game:launch", server),
  repair: (serverId) => ipcRenderer.invoke("game:repair", serverId),
  checkPack: (server) => ipcRenderer.invoke("pack:check", server),
  updatePack: (server) => ipcRenderer.invoke("pack:update", server),
  onProgress: (cb) => ipcRenderer.on("game:progress", (_e, d) => cb(d)),
  onStarted: (cb) => ipcRenderer.on("game:started", () => cb()),
  onClosed: (cb) => ipcRenderer.on("game:closed", (_e, code) => cb(code)),

  // Mises à jour
  onUpdateAvailable: (cb) => ipcRenderer.on("update:available", (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on("update:progress", (_e, d) => cb(d)),
  onUpdateReady: (cb) => ipcRenderer.on("update:ready", () => cb()),
  onUpdateError: (cb) => ipcRenderer.on("update:error", (_e, d) => cb(d)),
  onUpdateLog: (cb) => ipcRenderer.on("update:log", (_e, d) => cb(d)),
  openUpdateLog: () => ipcRenderer.send("update:openlog"),
  installUpdate: () => ipcRenderer.send("update:install"),
  getUpdateStatus: () => ipcRenderer.invoke("update:get"),
  onGameLog: (cb) => ipcRenderer.on("game:log", (_e, m) => cb(m)),
  onGameCrashed: (cb) => ipcRenderer.on("game:crashed", (_e, d) => cb(d)),
  openGameLog: () => ipcRenderer.send("open:gamelog"),
});
