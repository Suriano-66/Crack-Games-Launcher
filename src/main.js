const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Suppression robuste sous Windows : certains fichiers (cache .connector,
 * jars en lecture seule) refusent d'être effacés. On réessaie, on retire
 * l'attribut lecture seule, puis on nettoie fichier par fichier.
 */
function rmSafe(target) {
  if (!fs.existsSync(target)) return true;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    return true;
  } catch (e) {
    console.warn("[fs] suppression difficile :", target, e.code);
  }
  // Deuxième passage : on force les permissions puis on supprime un par un
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
      try { fs.rmdirSync(p); } catch {}
    } else {
      try { fs.chmodSync(p, 0o666); } catch {}
      try { fs.unlinkSync(p); } catch (e) {
        console.warn("[fs] fichier verrouillé, ignoré :", path.basename(p));
      }
    }
  };
  walk(target);
  return !fs.existsSync(target);
}

/** Copie robuste : retire la cible en lecture seule / verrouillée avant d'écrire. */
function copySafe(src, dest) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.existsSync(dest)) {
        try { fs.chmodSync(dest, 0o666); } catch {}
        try { fs.unlinkSync(dest); } catch {}
      }
      fs.copyFileSync(src, dest);
      return true;
    } catch (e) {
      if (attempt === 2) {
        const err = new Error("locked-files");
        err.step = "locked";
        err.detail = path.basename(dest);
        throw err;
      }
    }
  }
}
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
let mcSession = null; // session Minecraft en cache (évite le rate-limit Microsoft)
let mcSessionAt = 0;

// ---------- Utilitaires ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function fmtErr(e) {
  if (typeof e === "string") return e;
  if (e?.step === "session" || e?.message === "session-expired") {
    return "Ta session Microsoft a expiré. Clique sur ton pseudo en haut à droite puis « Se déconnecter », et reconnecte-toi.";
  }
  if (e?.step === "locked" || e?.code === "EPERM" || e?.code === "EBUSY") {
    return "Des fichiers du jeu sont verrouillés (" + (e.detail || "mods") +
      "). Ferme Minecraft s'il est ouvert, ferme l'explorateur de fichiers sur le dossier du jeu, puis réessaie.";
  }
  const raw = e?.message || e?.reason || e?.name || JSON.stringify(e);
  const s = String(raw).toLowerCase();
  if (s.includes("closed") || s.includes("cancel"))
    return "Fenêtre de connexion fermée avant la fin.";
  if (s.includes("own") || s.includes("entitle") || s.includes("profile") || s.includes("gamepass"))
    return "Aucun profil Minecraft trouvé sur ce compte. Si tu as le Game Pass : lance d'abord le launcher officiel Minecraft une fois avec ce compte et crée ton pseudo Java, puis réessaie.";
  if (s.includes("xsts") || s.includes("child") || s.includes("under"))
    return "Compte Xbox invalide : compte enfant sans famille, ou profil Xbox inexistant. Connecte-toi une fois sur minecraft.net / xbox.com avec ce compte.";
  if (s.includes("429") || s.includes("too many"))
    return "Trop de requêtes vers les serveurs Microsoft. Attends 5 à 10 minutes puis réessaie.";
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
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#0d0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // le rendu ne voit pas les objets internes d'Electron
      nodeIntegration: false,   // pas d'accès à Node depuis la page
      sandbox: true,            // le processus de rendu est mis en bac à sable
      webviewTag: false,        // pas de <webview>
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Verrouillage de la navigation : la page ne peut ni naviguer ailleurs,
  // ni ouvrir de fenêtre. Les liens externes passent par le navigateur système.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Refuse toute demande de permission (caméra, micro, géoloc...)
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

app.setAppUserModelId("com.crackgames.launcher");

app.whenReady().then(() => {
  createWindow();
  initAutoUpdate();
  initRPC();
});
app.on("window-all-closed", () => app.quit());

ipcMain.on("window:minimize", () => win.minimize());
ipcMain.on("window:close", () => win.close());
ipcMain.handle("config:get", () => ({ ...CONFIG, appVersion: app.getVersion() }));
ipcMain.on("open:link", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on("open:gamedir", () => {
  fs.mkdirSync(GAME_DIR(), { recursive: true });
  shell.openPath(GAME_DIR());
});

// ---------- Mise à jour automatique ----------
let updateState = { status: "idle", version: null, percent: 0 };
function initAutoUpdate() {
  if (!app.isPackaged) return; // seulement sur la version installée
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  // Le téléchargement différentiel (blockmap) se bloque souvent avec GitHub :
  // on force le téléchargement complet, plus fiable.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Journalisation : console + fichier + affichage dans la bannière
  const logFile = path.join(app.getPath("userData"), "update.log");
  const writeLog = (level, m) => {
    const line = `[${new Date().toISOString()}] ${level} ${m}`;
    console.log("[update]", m);
    try { fs.appendFileSync(logFile, line + "\n"); } catch {}
    try { win?.webContents.send("update:log", { line: String(m).slice(0, 160) }); } catch {}
  };
  autoUpdater.logger = {
    info: (m) => writeLog("INFO", m),
    warn: (m) => writeLog("WARN", m),
    error: (m) => writeLog("ERROR", m),
    debug: () => {},
  };
  writeLog("INFO", "Version installée : " + app.getVersion());

  // Ouvrir le fichier de log depuis l'interface
  ipcMain.on("update:openlog", () => shell.openPath(logFile));

  // État courant de la mise à jour, mémorisé pour que l'interface puisse le
  // demander à tout moment (évite de perdre un événement arrivé trop tôt).
  const send = (channel, payload) => {
    try { win?.webContents.send(channel, payload); } catch {}
  };
  autoUpdater.on("update-available", (info) => {
    updateState = { status: "available", version: info.version, percent: 0 };
    send("update:available", { version: info.version });
  });
  autoUpdater.on("download-progress", (p) => {
    const percent = Math.round(p.percent);
    if (updateState.status !== "ready") updateState = { ...updateState, status: "downloading", percent };
    send("update:progress", { percent });
  });
  autoUpdater.on("update-downloaded", () => {
    updateState = { ...updateState, status: "ready", percent: 100 };
    send("update:ready");
  });
  autoUpdater.on("error", (e) => {
    console.error("[update] erreur :", e?.message || e);
    send("update:error", { message: String(e?.message || e).slice(0, 200) });
  });

  // L'interface peut réclamer l'état à jour dès qu'elle est prête (rattrapage)
  ipcMain.handle("update:get", () => updateState);

  ipcMain.on("update:install", () => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error("[update] installation impossible :", e?.message || e);
      send("update:error", { message: "Installation impossible : " + e?.message });
    }
  });

  // On lance la 1re vérification une fois la page chargée, pour être sûr que
  // l'interface reçoive bien l'événement « mise à jour disponible ».
  const runCheck = () => autoUpdater.checkForUpdates().catch((e) =>
    console.error("[update] vérification impossible :", e?.message || e)
  );
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => setTimeout(runCheck, 1500));
  } else {
    setTimeout(runCheck, 1500);
  }

  // Revérifie régulièrement (toutes les 10 min) et quand le joueur revient
  // sur le launcher — la mise à jour apparaît alors sans avoir à le relancer.
  setInterval(runCheck, 10 * 60 * 1000);
  let lastFocusCheck = 0;
  win.on("focus", () => {
    if (updateState.status === "ready") return;
    const now = Date.now();
    if (now - lastFocusCheck < 60 * 1000) return; // pas plus d'1 fois/min
    lastFocusCheck = now;
    runCheck();
  });
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
const DEFAULT_SETTINGS = {
  ram: parseInt(CONFIG.memory?.max) || 4,
  volume: 15,          // volume des vidéos de fond (%)
  bgPaused: false,     // vidéos de fond en pause
  fullscreen: false,   // jeu en plein écran
  width: 1280,
  height: 720,
  closeLauncher: false // réduire le launcher pendant le jeu
};
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE(), {}) };
}
ipcMain.handle("settings:get", () => ({
  ...getSettings(),
  totalRam: Math.max(4, Math.round(os.totalmem() / 1024 ** 3)),
}));
ipcMain.handle("settings:set", (_e, s) => {
  writeJson(SETTINGS_FILE(), { ...getSettings(), ...s });
  return getSettings();
});

// Répare un serveur : supprime son instance, tout sera retéléchargé
ipcMain.handle("game:repair", (_e, serverId) => {
  try {
    if (!serverId || /[\\/.]/.test(serverId)) throw new Error("Serveur invalide");
    rmSafe(instanceDir(serverId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: fmtErr(e) };
  }
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
    mcSession = mc;
    mcSessionAt = Date.now();
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
  mcSession = mc;
  mcSessionAt = Date.now();
  const profile = { name: mc.profile.name, uuid: mc.profile.id };
  saveAccount(profile, authResult.save());
  return profile;
}

// Session Minecraft valable ~24h : on la met en cache 6h pour éviter le rate-limit.
// Si elle est périmée, on rafraîchit le compte ; en dernier recours on demande
// une reconnexion (au lieu d'afficher une erreur trompeuse).
async function getMc() {
  if (mcSession && Date.now() - mcSessionAt < 6 * 3600 * 1000) return mcSession;

  // 1re tentative avec la session courante
  if (authResult) {
    try {
      mcSession = await authResult.getMinecraft();
      mcSessionAt = Date.now();
      return mcSession;
    } catch (e) {
      console.warn("[auth] session expirée, rafraîchissement...", e?.message || e);
    }
  }

  // 2e tentative : on rejoue le refresh token du compte courant
  try {
    const db = loadAccounts();
    if (!db.current) throw new Error("no-account");
    await refreshAccount(db.current);
    if (mcSession) return mcSession;
  } catch (e) {
    console.error("[auth] rafraîchissement impossible :", e?.message || e);
  }

  const err = new Error("session-expired");
  err.step = "session";
  throw err;
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
    // Paramètre unique pour contourner le cache de GitHub : toujours la dernière version
    const bust = (CONFIG.serversUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
    const res = await fetch(CONFIG.serversUrl + bust, { cache: "no-store" });
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
  // 1) Endpoint frais du backend (pas de cache CDN → apparition quasi immédiate)
  if (CONFIG.apiUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000); // backend endormi (Render) : on n'attend pas
      const res = await fetch(CONFIG.apiUrl.replace(/\/$/, "") + "/api/news", {
        cache: "no-store", signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.news)) return { ok: true, news: j.news };
      }
    } catch {}
  }
  // 2) Repli sur raw GitHub (~5 min de cache, mais toujours disponible)
  try {
    if (CONFIG.newsUrl) {
      const bust = (CONFIG.newsUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
      const res = await fetch(CONFIG.newsUrl + bust, { cache: "no-store" });
      if (res.ok) return { ok: true, news: (await res.json()).news };
    }
  } catch {}
  // 3) Dernier recours : fichier local livré avec le launcher
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

// Domaines autorisés pour TOUT téléchargement du launcher.
// Empêche qu'un servers.json compromis fasse télécharger depuis n'importe où.
const TRUSTED_HOSTS = [
  "github.com", "objects.githubusercontent.com", "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "piston-data.mojang.com", "piston-meta.mojang.com", "libraries.minecraft.net",
  "resources.download.minecraft.net", "launchermeta.mojang.com",
  "maven.neoforged.net", "maven.minecraftforge.net", "maven.fabricmc.net",
  "meta.fabricmc.net", "api.adoptium.net", "github.githubassets.com",
];

function assertTrustedUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("URL invalide : " + url); }
  if (u.protocol !== "https:") throw new Error("Téléchargement non sécurisé (HTTPS requis) : " + url);
  const host = u.hostname.toLowerCase();
  const ok = TRUSTED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  if (!ok) throw new Error("Domaine non autorisé : " + host);
  return u;
}

async function downloadFile(url, dest, onPct) {
  assertTrustedUrl(url); // HTTPS + domaine de confiance obligatoires
  const res = await fetch(url, { redirect: "follow" });
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

/** Nom de fichier sûr : pas de chemin, pas de traversée de dossier. */
function safeName(name) {
  return path.basename(String(name)).replace(/[^A-Za-z0-9._+\-]/g, "_");
}

/** Dossier d'instance d'un serveur, avec identifiant assaini (pas de traversée). */
function instanceDir(serverId) {
  const id = String(serverId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) throw new Error("Identifiant de serveur invalide");
  return path.join(GAME_DIR(), "instances", id);
}

/** Empêche d'écrire hors du dossier autorisé (zip slip / path traversal). */
function safeJoin(baseDir, entry) {
  const target = path.resolve(baseDir, entry);
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Chemin non autorisé : " + entry);
  }
  return target;
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

// ---------- NeoForge (version épinglable, dernière version par défaut) ----------
async function neoforgeConfig(server, root, send) {
  const metaRes = await fetch(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
  );
  if (!metaRes.ok) throw new Error("Impossible de récupérer les versions NeoForge");
  const meta = await metaRes.text();
  const all = [...meta.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

  // NeoForge 21.1.x correspond à Minecraft 1.21.1
  const parts = server.version.split(".");
  const prefix = `${parts[1]}.${parts[2] || 0}.`;
  const candidates = all.filter((v) => v.startsWith(prefix) && !v.includes("beta"));
  if (!candidates.length) throw new Error("Pas de NeoForge pour Minecraft " + server.version);

  // Version précise du serveur si fournie, sinon la plus récente
  const ver = server.loader.version || candidates[candidates.length - 1];
  if (!all.includes(ver)) throw new Error("Version NeoForge introuvable : " + ver);

  const jar = path.join(root, "versions", `neoforge-${ver}`, "neoforge-installer.jar");
  if (!fs.existsSync(jar)) {
    fs.mkdirSync(path.dirname(jar), { recursive: true });
    await downloadFile(
      `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`,
      jar,
      (p) => send("loader", p, 100)
    );
  }
  await ensureNeoforgeLibraries(root, jar, send);

  return {
    version: { number: server.version, type: "release", custom: `neoforge-${ver}` },
    forge: jar,
  };
}

// Pré-télécharge les librairies de l'installeur NeoForge que MCLC oublie
// (ex: binarypatcher-x.x.x-fatjar.jar) + copie le maven embarqué
async function ensureNeoforgeLibraries(root, jar, send) {
  const dir = path.dirname(jar);
  const profileFile = path.join(dir, "install_profile.json");

  if (!fs.existsSync(profileFile)) {
    const extract = require("extract-zip");
    const tmp = path.join(dir, "installer-extract");
    await extract(jar, { dir: tmp });
    // Jars embarqués dans l'installeur (universal, etc.)
    const maven = path.join(tmp, "maven");
    if (fs.existsSync(maven)) {
      fs.cpSync(maven, path.join(root, "libraries"), { recursive: true, force: false });
    }
    fs.copyFileSync(path.join(tmp, "install_profile.json"), profileFile);
    rmSafe(tmp);
  }

  const profile = JSON.parse(fs.readFileSync(profileFile, "utf-8"));
  const libs = (profile.libraries || []).filter((l) => l.downloads?.artifact?.url && l.downloads.artifact.path);
  for (let i = 0; i < libs.length; i++) {
    const a = libs[i].downloads.artifact;
    const libsRoot = path.join(root, "libraries");
    const dest = safeJoin(libsRoot, a.path.replace(/\\/g, "/")); // pas de traversée

    send("loader", i + 1, libs.length);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await downloadFile(a.url, dest);
  }
}

// ---------- Pack de mods : détection + installation ----------

/** Empreinte attendue du pack distant (version + ETag/taille du zip). */
async function packRemoteTag(server) {
  let remoteTag = "";
  try {
    assertTrustedUrl(server.modsZip.url);
    const head = await fetch(server.modsZip.url, { method: "HEAD" });
    if (head.ok) {
      remoteTag =
        (head.headers.get("etag") || "").replace(/"/g, "") +
        "-" + (head.headers.get("content-length") || "");
    }
  } catch {}
  return String(server.modsZip.version || "") + "|" + remoteTag;
}

/** Le pack installé est-il à jour ? */
ipcMain.handle("pack:check", async (_e, server) => {
  try {
    if (!server?.modsZip?.url) return { ok: true, needsUpdate: false, installed: true };
    const root = instanceDir(server.id);
    const marker = path.join(root, "mods", ".pack-version");
    const installed = fs.existsSync(marker);
    const want = await packRemoteTag(server);
    const have = installed ? fs.readFileSync(marker, "utf-8") : null;
    return { ok: true, needsUpdate: have !== want, installed };
  } catch (e) {
    return { ok: false, error: fmtErr(e) };
  }
});

/** Installe (ou met à jour) le pack de mods. */
async function installPack(server, send) {
  if (!server.modsZip?.url) return false;
  const root = instanceDir(server.id);
  fs.mkdirSync(root, { recursive: true });
  const modsDir = path.join(root, "mods");
  const marker = path.join(modsDir, ".pack-version");
  const want = await packRemoteTag(server);
  const have = fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : null;
  if (have === want) return false; // déjà à jour

  rmSafe(modsDir);
  fs.mkdirSync(modsDir, { recursive: true });
  const zipPath = path.join(root, "modpack.zip");
  send("modpack", 0, 100);
  await downloadFile(server.modsZip.url, zipPath, (p) => send("modpack", p, 100));

  const extract = require("extract-zip");
  const tmp = path.join(root, "modpack-extract");
  rmSafe(tmp);
  await extract(zipPath, { dir: tmp });

  // Le zip peut contenir les .jar à la racine ou dans un dossier mods/
  const src = fs.existsSync(path.join(tmp, "mods")) ? path.join(tmp, "mods") : tmp;
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith(".jar")) copySafe(path.join(src, f), safeJoin(modsDir, safeName(f)));
  }
  // Le reste (options.txt, config/, resourcepacks/...) sans écraser l'existant
  for (const entry of fs.readdirSync(tmp)) {
    if (entry === "mods") continue;
    const from = path.join(tmp, entry);
    const to = safeJoin(root, safeName(entry)); // jamais hors de l'instance
    if (fs.statSync(from).isDirectory()) {
      fs.cpSync(from, to, { recursive: true, force: false });
    } else if (!entry.endsWith(".jar") && !fs.existsSync(to)) {
      copySafe(from, to);
    }
  }
  rmSafe(tmp);
  try { fs.unlinkSync(zipPath); } catch {}

  // Manifeste anti-triche
  const manifest = { files: {} };
  for (const f of fs.readdirSync(modsDir)) {
    if (f.endsWith(".jar")) manifest.files[f] = sha256(path.join(modsDir, f));
  }
  writeJson(path.join(root, ".mods-manifest.json"), manifest);
  fs.writeFileSync(marker, want);
  return true;
}

/** Mise à jour du pack déclenchée par le bouton du launcher. */
ipcMain.handle("pack:update", async (_e, server) => {
  try {
    const send = (type, task, total) =>
      win.webContents.send("game:progress", { type, task, total });
    const updated = await installPack(server, send);
    return { ok: true, updated };
  } catch (e) {
    console.error("[pack:update]", e);
    return { ok: false, error: fmtErr(e) };
  }
});

// ---------- Lancement du jeu ----------
ipcMain.handle("game:launch", async (_evt, server) => {
  if (!authResult) return { ok: false, error: "Non connecté" };
  if (server.maintenance) return { ok: false, error: "Ce serveur est en maintenance." };
  try {
    const send = (type, task, total) =>
      win.webContents.send("game:progress", { type, task, total });

    const mc = await getMc();
    const root = instanceDir(server.id);
    fs.mkdirSync(root, { recursive: true });

    // 1. Java auto
    send("java", 0, 100);
    const javaPath = await ensureJava(server.version, (p) => send("java", p, 100));

    // 2a. Pack de mods (installé/mis à jour si nécessaire)
    if (server.modsZip?.url) await installPack(server, send);

    // 2b. Mods individuels
    if (Array.isArray(server.mods) && server.mods.length) {
      const modsDir = path.join(root, "mods");
      fs.mkdirSync(modsDir, { recursive: true });
      for (let i = 0; i < server.mods.length; i++) {
        const m = server.mods[i];
        send("mods", i + 1, server.mods.length);
        const base = safeName(m.name.endsWith(".jar") ? m.name : m.name + ".jar");
        const f = safeJoin(modsDir, base);
        if (fs.existsSync(f)) continue;
        assertTrustedUrl(m.url); // HTTPS + domaine de confiance
        const r = await fetch(m.url);
        if (!r.ok) throw new Error("Mod introuvable : " + m.name);
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      }
    }

    // 2c. Anti-triche : le dossier mods doit correspondre exactement au pack officiel
    {
      const manifestFile = path.join(root, ".mods-manifest.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = readJson(manifestFile, { files: {} });
        const modsDir = path.join(root, "mods");
        // Mods individuels (server.mods) ajoutés au manifeste s'ils n'y sont pas
        if (Array.isArray(server.mods)) {
          let changed = false;
          for (const m of server.mods) {
            const name = m.name.endsWith(".jar") ? m.name : m.name + ".jar";
            const p = path.join(modsDir, name);
            if (fs.existsSync(p) && !manifest.files[name]) {
              manifest.files[name] = sha256(p);
              changed = true;
            }
          }
          if (changed) writeJson(manifestFile, manifest);
        }
        let tampered = false;
        // Jars inconnus → supprimés (xray, cheats...)
        for (const f of fs.readdirSync(modsDir)) {
          if (!f.endsWith(".jar")) continue;
          const p = path.join(modsDir, f);
          if (!manifest.files[f]) {
            console.warn("[anti-triche] mod non autorisé supprimé :", f);
            fs.rmSync(p, { force: true });
          } else if (sha256(p) !== manifest.files[f]) {
            tampered = true; // jar officiel modifié
          }
        }
        // Jars officiels manquants ?
        for (const name of Object.keys(manifest.files)) {
          if (!fs.existsSync(path.join(modsDir, name))) tampered = true;
        }
        if (tampered) {
          // Réinitialisation : le pack sera retéléchargé proprement
          rmSafe(modsDir);
          rmSafe(manifestFile);
          return {
            ok: false,
            error: "Des fichiers de mods modifiés ont été détectés. Ils ont été réinitialisés : clique à nouveau sur JOUER.",
          };
        }
      }
    }

    // 3. Modloader (forge / neoforge / fabric / quilt)
    let loaderConfig = null;
    const loaderType = server.loader?.type;
    if (loaderType === "neoforge") {
      send("loader", 0, 100);
      loaderConfig = await neoforgeConfig(server, root, send);
      send("loader", 100, 100);
    } else if (loaderType && loaderType !== "vanilla") {
      send("loader", 0, 100);
      const { loader } = require("tomate-loaders");
      loaderConfig = await loader(loaderType).getMCLCLaunchConfig({
        gameVersion: server.version,
        rootPath: root,
      });
      send("loader", 100, 100);
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
      window: settings.fullscreen
        ? { fullscreen: true }
        : { width: settings.width || 1280, height: settings.height || 720 },
      ...(loaderConfig || {}),
      ...(supportsQuickPlay
        ? { quickPlay: { type: "multiplayer", identifier: `${server.ip}:${server.port}` } }
        : { server: { host: server.ip, port: String(server.port) } }),
    };

    const launcher = new Client();
    launcher.on("progress", (e) => send(e.type, e.task, e.total));
    launcher.on("debug", (l) => console.log("[MCLC]", l));
    launcher.on("data", (l) => {
      process.stdout.write("[MC] " + l);
      win.webContents.send("game:started");
      if (getSettings().closeLauncher && !win.isMinimized()) win.minimize();
      setRPC("Joue sur " + server.name, server.ip);
    });
    launcher.on("close", (code) => {
      win.webContents.send("game:closed", code);
      if (win.isMinimized()) win.restore();
      setRPC("Sur le launcher");
    });

    await launcher.launch(opts);
    return { ok: true };
  } catch (e) {
    console.error("[game:launch]", e);
    return { ok: false, error: fmtErr(e) };
  }
});
