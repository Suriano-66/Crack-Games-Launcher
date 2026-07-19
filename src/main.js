const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { Auth } = require("msmc");
const { Client } = require("minecraft-launcher-core");

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8")
);

const GAME_DIR = () => path.join(app.getPath("appData"), ".crackgames");
const ACCOUNTS_FILE = () => path.join(app.getPath("userData"), "accounts.json");
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

let win = null;
let authResult = null; // session msmc active
let rpc = null; // Discord Rich Presence

// ---------- Utilitaires ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function fmtErr(e) {
  if (typeof e === "string") return e;
  const raw = e?.message || e?.reason || e?.name || JSON.stringify(e);
  const s = String(raw).toLowerCase();
  if (s.includes("closed") || s.includes("cancel"))
    return "Fenêtre de connexion fermée avant la fin.";
  if (s.includes("own") || s.includes("entitle") || s.includes("profile") || s.includes("gamepass"))
    return "Aucun profil Minecraft trouvé sur ce compte. Si tu as le Game Pass : lance d'abord le launcher officiel Minecraft une fois avec ce compte et crée ton pseudo Java, puis réessaie.";
  if (s.includes("xsts") || s.includes("child") || s.includes("under"))
    return "Compte Xbox invalide : compte enfant sans famille, ou profil Xbox inexistant. Connecte-toi une fois sur minecraft.net / xbox.com avec ce compte.";
  if (s.includes("fetch") || s.includes("network") || s.includes("enotfound"))
    return "Problème de connexion internet.";
  return String(raw);
}

// ---------- Fenêtre ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: "#0d0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdate();
  initRPC();
});
app.on("window-all-closed", () => app.quit());

ipcMain.on("window:minimize", () => win.minimize());
ipcMain.on("window:close", () => win.close());
ipcMain.handle("config:get", () => CONFIG);
ipcMain.on("open:link", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on("open:gamedir", () => {
  fs.mkdirSync(GAME_DIR(), { recursive: true });
  shell.openPath(GAME_DIR());
});

// ---------- Mise à jour automatique ----------
function initAutoUpdate() {
  if (!app.isPackaged) return; // seulement sur la version installée
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;

  autoUpdater.on("update-available", (info) =>
    win.webContents.send("update:available", { version: info.version })
  );
  autoUpdater.on("download-progress", (p) =>
    win.webContents.send("update:progress", { percent: Math.round(p.percent) })
  );
  autoUpdater.on("update-downloaded", () =>
    win.webContents.send("update:ready")
  );
  autoUpdater.on("error", (e) => console.error("[update]", e));

  ipcMain.on("update:install", () => autoUpdater.quitAndInstall());
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);
}

// ---------- Discord Rich Presence ----------
function initRPC() {
  if (!CONFIG.discordAppId) return;
  try {
    const RPC = require("discord-rpc");
    rpc = new RPC.Client({ transport: "ipc" });
    rpc.on("ready", () => setRPC("Sur le launcher"));
    rpc.login({ clientId: CONFIG.discordAppId }).catch(() => (rpc = null));
  } catch { rpc = null; }
}
function setRPC(details, state) {
  if (!rpc) return;
  rpc.setActivity({
    details,
    state: state || undefined,
    startTimestamp: Date.now(),
    largeImageKey: "logo",
    largeImageText: "Crack Games",
  }).catch(() => {});
}

// ---------- Paramètres ----------
const DEFAULT_SETTINGS = { ram: parseInt(CONFIG.memory?.max) || 4 };
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE(), {}) };
}
ipcMain.handle("settings:get", () => getSettings());
ipcMain.handle("settings:set", (_e, s) => {
  writeJson(SETTINGS_FILE(), { ...getSettings(), ...s });
  return getSettings();
});

// ---------- Comptes (multi-comptes) ----------
function loadAccounts() {
  return readJson(ACCOUNTS_FILE(), { accounts: [], current: null });
}
function saveAccount(profile, token) {
  const db = loadAccounts();
  const i = db.accounts.findIndex((a) => a.uuid === profile.uuid);
  const entry = { name: profile.name, uuid: profile.uuid, token };
  if (i >= 0) db.accounts[i] = entry;
  else db.accounts.push(entry);
  db.current = profile.uuid;
  writeJson(ACCOUNTS_FILE(), db);
}

ipcMain.handle("accounts:list", () => {
  const db = loadAccounts();
  return {
    current: db.current,
    accounts: db.accounts.map((a) => ({ name: a.name, uuid: a.uuid })),
  };
});

ipcMain.handle("auth:login", async () => {
  try {
    const auth = new Auth("select_account");
    authResult = await auth.launch("electron");
    const mc = await authResult.getMinecraft();
    const profile = { name: mc.profile.name, uuid: mc.profile.id };
    saveAccount(profile, authResult.save());
    return { ok: true, profile };
  } catch (e) {
    console.error("[auth:login]", e);
    return { ok: false, error: fmtErr(e) };
  }
});

async function refreshAccount(uuid) {
  const db = loadAccounts();
  const acc = db.accounts.find((a) => a.uuid === uuid);
  if (!acc) throw new Error("Compte introuvable");
  const auth = new Auth("select_account");
  authResult = await auth.refresh(acc.token);
  const mc = await authResult.getMinecraft();
  const profile = { name: mc.profile.name, uuid: mc.profile.id };
  saveAccount(profile, authResult.save());
  return profile;
}

ipcMain.handle("auth:restore", async () => {
  try {
    const db = loadAccounts();
    if (!db.current) return { ok: false };
    const profile = await refreshAccount(db.current);
    return { ok: true, profile };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("auth:switch", async (_e, uuid) => {
  try {
    const profile = await refreshAccount(uuid);
    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: fmtErr(e) };
  }
});

ipcMain.handle("auth:logout", async () => {
  const db = loadAccounts();
  db.accounts = db.accounts.filter((a) => a.uuid !== db.current);
  db.current = db.accounts[0]?.uuid || null;
  writeJson(ACCOUNTS_FILE(), db);
  authResult = null;
  if (db.current) {
    try {
      const profile = await refreshAccount(db.current);
      return { ok: true, profile };
    } catch {}
  }
  return { ok: true, profile: null };
});

// ---------- Serveurs ----------
ipcMain.handle("servers:get", async () => {
  try {
    const res = await fetch(CONFIG.serversUrl, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, source: "remote", servers: data.servers.filter((s) => s.visible) };
    }
  } catch {}
  try {
    const local = readJson(path.join(__dirname, "..", "servers.json"), null);
    return { ok: true, source: "local", servers: local.servers.filter((s) => s.visible) };
  } catch (e) {
    return { ok: false, error: fmtErr(e) };
  }
});

// Ping des serveurs : statut en ligne + nombre de joueurs
ipcMain.handle("servers:ping", async (_e, list) => {
  const { status } = require("minecraft-server-util");
  const out = {};
  await Promise.all(
    list.map(async (s) => {
      try {
        const r = await status(s.ip, s.port || 25565, { timeout: 3000 });
        out[s.id] = { online: true, players: r.players.online, max: r.players.max };
      } catch {
        out[s.id] = { online: false };
      }
    })
  );
  return out;
});

// ---------- Actualités ----------
ipcMain.handle("news:get", async () => {
  try {
    if (CONFIG.newsUrl) {
      const res = await fetch(CONFIG.newsUrl, { cache: "no-store" });
      if (res.ok) return { ok: true, news: (await res.json()).news };
    }
  } catch {}
  const local = readJson(path.join(__dirname, "..", "news.json"), { news: [] });
  return { ok: true, news: local.news };
});

// ---------- Java automatique ----------
function javaMajorFor(version) {
  const parts = version.split(".").map(Number);
  const minor = parts[1] || 0, patch = parts[2] || 0;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

async function downloadFile(url, dest, onPct) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Téléchargement impossible : " + url);
  const total = Number(res.headers.get("content-length")) || 0;
  const ws = fs.createWriteStream(dest);
  let done = 0;
  for await (const chunk of res.body) {
    done += chunk.length;
    ws.write(Buffer.from(chunk));
    if (total && onPct) onPct(Math.round((done / total) * 100));
  }
  await new Promise((r) => ws.end(r));
}

async function ensureJava(version, onPct) {
  const major = javaMajorFor(version);
  const dir = path.join(GAME_DIR(), "runtime", "java" + major);
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const find = () => {
    if (!fs.existsSync(dir)) return null;
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, "bin", exe);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  let j = find();
  if (j) return j;

  fs.mkdirSync(dir, { recursive: true });
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/x64/jre/hotspot/normal/eclipse`;
  const zipPath = path.join(dir, "java.zip");
  await downloadFile(url, zipPath, onPct);
  const extract = require("extract-zip");
  await extract(zipPath, { dir });
  fs.unlinkSync(zipPath);
  j = find();
  if (!j) throw new Error("Java " + major + " téléchargé mais introuvable après extraction");
  return j;
}

// ---------- Lancement du jeu ----------
ipcMain.handle("game:launch", async (_evt, server) => {
  if (!authResult) return { ok: false, error: "Non connecté" };
  if (server.maintenance) return { ok: false, error: "Ce serveur est en maintenance." };
  try {
    const send = (type, task, total) =>
      win.webContents.send("game:progress", { type, task, total });

    const mc = await authResult.getMinecraft();
    const root = path.join(GAME_DIR(), "instances", server.id);
    fs.mkdirSync(root, { recursive: true });

    // 1. Java auto
    send("java", 0, 100);
    const javaPath = await ensureJava(server.version, (p) => send("java", p, 100));

    // 2. Mods
    if (Array.isArray(server.mods) && server.mods.length) {
      const modsDir = path.join(root, "mods");
      fs.mkdirSync(modsDir, { recursive: true });
      for (let i = 0; i < server.mods.length; i++) {
        const m = server.mods[i];
        send("mods", i + 1, server.mods.length);
        const f = path.join(modsDir, m.name.endsWith(".jar") ? m.name : m.name + ".jar");
        if (fs.existsSync(f)) continue;
        const r = await fetch(m.url);
        if (!r.ok) throw new Error("Mod introuvable : " + m.name);
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      }
    }

    // 3. Forge
    let forgePath;
    if (server.loader?.type === "forge" && server.loader.installerUrl) {
      forgePath = path.join(root, "forge-installer.jar");
      if (!fs.existsSync(forgePath)) {
        send("forge", 0, 100);
        await downloadFile(server.loader.installerUrl, forgePath, (p) => send("forge", p, 100));
      }
    }

    // 4. Lancement
    const settings = getSettings();
    const [maj, min] = server.version.split(".").map(Number);
    const supportsQuickPlay = maj > 1 || (maj === 1 && min >= 20);

    const opts = {
      authorization: mc.mclc(),
      root,
      javaPath,
      version: { number: server.version, type: "release" },
      memory: { max: settings.ram + "G", min: "2G" },
      ...(forgePath ? { forge: forgePath } : {}),
      ...(supportsQuickPlay
        ? { quickPlay: { type: "multiplayer", identifier: `${server.ip}:${server.port}` } }
        : { server: { host: server.ip, port: String(server.port) } }),
    };

    const launcher = new Client();
    launcher.on("progress", (e) => send(e.type, e.task, e.total));
    launcher.on("data", () => {
      win.webContents.send("game:started");
      setRPC("Joue sur " + server.name, server.ip);
    });
    launcher.on("close", (code) => {
      win.webContents.send("game:closed", code);
      setRPC("Sur le launcher");
    });

    await launcher.launch(opts);
    return { ok: true };
  } catch (e) {
    console.error("[game:launch]", e);
    return { ok: false, error: fmtErr(e) };
  }
});
