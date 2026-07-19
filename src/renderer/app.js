const $ = (id) => document.getElementById(id);

let servers = [];
let selected = null;
let config = null;
let pingTimer = null;

// ---------- Fenêtre ----------
$("btn-min").onclick = () => launcher.minimize();
$("btn-close").onclick = () => launcher.close();

// ---------- Fond animé : particules connectées ----------
(() => {
  const canvas = $("bg-canvas");
  const ctx = canvas.getContext("2d");
  let pts = [];

  function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const count = Math.floor((innerWidth * innerHeight) / 18000);
    pts = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
    }));
  }
  addEventListener("resize", resize);
  resize();

  (function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        const d = Math.hypot(dx, dy);
        if (d < 130) {
          ctx.strokeStyle = `rgba(255,255,255,${0.14 * (1 - d / 130)})`;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      }
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(pts[i].x - 1, pts[i].y - 1, 2, 2);
    }
    requestAnimationFrame(frame);
  })();
})();

// ---------- Mise à jour automatique ----------
launcher.onUpdateAvailable((d) => {
  $("update-banner").classList.remove("hidden");
  $("update-text").textContent = `Mise à jour ${d.version} en cours de téléchargement...`;
});
launcher.onUpdateProgress((d) => {
  $("update-text").textContent = `Téléchargement de la mise à jour... ${d.percent}%`;
});
launcher.onUpdateReady(() => {
  $("update-banner").classList.remove("hidden");
  $("update-text").textContent = "Mise à jour prête !";
  $("btn-update").classList.remove("hidden");
});
$("btn-update").onclick = () => launcher.installUpdate();

// ---------- Liens ----------
(async () => {
  config = await launcher.getConfig();
  if (config.appVersion) $("app-version").textContent = "v" + config.appVersion;
  document.querySelectorAll(".btn-link").forEach((b) => {
    const url = config.links?.[b.dataset.link];
    if (!url) { b.style.display = "none"; return; }
    b.onclick = () => launcher.openLink(url);
  });
})();

// ---------- Paramètres ----------
$("btn-settings").onclick = async () => {
  const s = await launcher.getSettings();
  $("ram-slider").value = s.ram;
  $("ram-value").textContent = s.ram + " Go";
  $("settings-modal").classList.remove("hidden");
};
$("ram-slider").oninput = (e) => {
  $("ram-value").textContent = e.target.value + " Go";
};
$("ram-slider").onchange = (e) => {
  launcher.setSettings({ ram: parseInt(e.target.value) });
};
$("btn-gamedir").onclick = () => launcher.openGameDir();
$("btn-close-settings").onclick = () => $("settings-modal").classList.add("hidden");
$("settings-modal").onclick = (e) => {
  if (e.target === $("settings-modal")) $("settings-modal").classList.add("hidden");
};

// ---------- Connexion / comptes ----------
async function onLoggedIn(profile) {
  $("player-chip").classList.remove("hidden");
  $("player-name").textContent = profile.name;
  $("player-head").src = `https://mc-heads.net/avatar/${profile.uuid}/22`;
  $("screen-login").classList.remove("active");
  $("screen-main").classList.add("active");
  await loadServers();
  await loadNews();
}

function showLogin() {
  $("screen-main").classList.remove("active");
  $("screen-login").classList.add("active");
  $("account-menu").classList.add("hidden");
  $("player-chip").classList.add("hidden");
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

$("btn-login").onclick = async () => {
  const btn = $("btn-login");
  const status = $("login-status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Connexion à Microsoft...";
  const res = await launcher.login();
  btn.disabled = false;
  if (res.ok) {
    status.textContent = "";
    onLoggedIn(res.profile);
  } else {
    status.className = "status error";
    status.textContent = "Échec de la connexion : " + res.error;
  }
};

// Menu multi-comptes
$("player-chip").onclick = async (e) => {
  e.stopPropagation();
  const menu = $("account-menu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  const db = await launcher.listAccounts();
  menu.innerHTML = "";
  db.accounts.forEach((a) => {
    const item = document.createElement("div");
    item.className = "item" + (a.uuid === db.current ? " active" : "");
    item.innerHTML = `<img src="https://mc-heads.net/avatar/${a.uuid}/24" /> ${a.name}`;
    item.onclick = async () => {
      menu.classList.add("hidden");
      if (a.uuid === db.current) return;
      $("progress-text").textContent = "Changement de compte...";
      const res = await launcher.switchAccount(a.uuid);
      $("progress-text").textContent = "";
      if (res.ok) onLoggedIn(res.profile);
    };
    menu.appendChild(item);
  });
  const add = document.createElement("div");
  add.className = "item sep";
  add.textContent = "+ Ajouter un compte";
  add.onclick = async () => {
    menu.classList.add("hidden");
    const res = await launcher.login();
    if (res.ok) onLoggedIn(res.profile);
  };
  menu.appendChild(add);
  const out = document.createElement("div");
  out.className = "item sep danger";
  out.textContent = "⏻ Se déconnecter";
  out.onclick = async () => {
    menu.classList.add("hidden");
    const res = await launcher.logout();
    if (res.profile) onLoggedIn(res.profile);
    else showLogin();
  };
  menu.appendChild(out);
  menu.classList.remove("hidden");
};
document.addEventListener("click", () => $("account-menu").classList.add("hidden"));

// Reconnexion automatique au démarrage
(async () => {
  const status = $("login-status");
  status.textContent = "Vérification de la session...";
  const res = await launcher.restore();
  status.textContent = "";
  if (res.ok) onLoggedIn(res.profile);
})();

// ---------- Actualités ----------
async function loadNews() {
  const res = await launcher.getNews();
  const list = $("news-list");
  list.innerHTML = "";
  if (!res.ok || !res.news?.length) {
    list.innerHTML = '<div class="news-item"><div class="n-content">Aucune actualité pour le moment.</div></div>';
    return;
  }
  res.news.forEach((n) => {
    const el = document.createElement("div");
    el.className = "news-item";
    el.innerHTML =
      `<div class="n-title">${n.title}</div>` +
      `<div class="n-date">${n.date || ""}</div>` +
      `<div class="n-content">${n.content}</div>`;
    list.appendChild(el);
  });
}

// ---------- Serveurs ----------
async function loadServers() {
  const res = await launcher.getServers();
  if (!res.ok) return;
  servers = res.servers;
  const list = $("server-list");
  list.innerHTML = "";
  servers.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "server-card" + (s.maintenance ? " maintenance" : "");
    card.dataset.id = s.id;
    card.innerHTML =
      (s.maintenance ? '<span class="maintenance-badge">MAINTENANCE</span>' : "") +
      (s.logo ? `<img class="card-logo" src="${logoSrc(s.logo)}" />` : "") +
      `<div class="name">${s.name}</div>` +
      `<div class="desc">${s.description || ""}</div>` +
      `<span class="version">${s.version}</span>` +
      `<div class="server-status"><span class="dot" id="dot-${s.id}"></span><span id="players-${s.id}">...</span></div>`;
    card.style.animationDelay = `${i * 90}ms`; // apparition en cascade
    card.onclick = () => selectServer(s, card);
    list.appendChild(card);
  });
  pingAll();
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(pingAll, 30000);
}

async function pingAll() {
  if (!servers.length) return;
  const res = await launcher.pingServers(
    servers.map((s) => ({ id: s.id, ip: s.ip, port: s.port }))
  );
  for (const s of servers) {
    const dot = $("dot-" + s.id), txt = $("players-" + s.id);
    if (!dot || !txt) continue;
    const st = res[s.id];
    if (st?.online) {
      dot.className = "dot on";
      txt.textContent = `${st.players}/${st.max} joueurs`;
    } else {
      dot.className = "dot off";
      txt.textContent = "Hors ligne";
    }
  }
}

// ---------- Fond par serveur : vidéo (se fige à la fin) ou diaporama photos ----------
let activeLayer = null;
let vidToggle = false, imgToggle = false;
let slideTimer = null;
const isVideoUrl = (u) => /\.(mp4|webm|mov)(\?|#|$)/i.test(u);

function swapTo(next) {
  const prev = activeLayer;
  next.classList.add("visible");
  if (prev && prev !== next) {
    prev.classList.remove("visible");
    if (prev.tagName === "VIDEO") setTimeout(() => prev.pause(), 1300);
  }
  activeLayer = next;
}

function showVideo(url) {
  if (activeLayer?.dataset.src === url) return;
  vidToggle = !vidToggle;
  const el = $(vidToggle ? "bg-video-a" : "bg-video-b");
  el.src = url;
  el.dataset.src = url;
  el.currentTime = 0;
  el.muted = false;
  el.volume = 0.5; // son de la vidéo
  el.play().catch(() => {}); // se joue une fois puis se fige sur la dernière image
  swapTo(el);
}

function showImage(url) {
  if (activeLayer?.dataset.src === url) return;
  imgToggle = !imgToggle;
  const el = $(imgToggle ? "bg-img-a" : "bg-img-b");
  el.src = url;
  el.dataset.src = url;
  swapTo(el);
}

let currentBgKey = null;
function setBackground(bg) {
  const key = JSON.stringify(bg || null);
  if (key === currentBgKey) return; // même fond, pas de transition
  currentBgKey = key;
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }

  // Transition en fondu noir : on assombrit, on change le fond, on rouvre
  const fade = $("bg-fade");
  fade.classList.add("visible");
  setTimeout(() => {
    if (!bg || (Array.isArray(bg) && bg.length === 0)) {
      if (activeLayer) {
        if (activeLayer.tagName === "VIDEO") activeLayer.pause();
        activeLayer.classList.remove("visible");
        activeLayer = null;
      }
    } else if (Array.isArray(bg)) {
      // Diaporama photos : fondu toutes les 7 secondes
      let idx = 0;
      const next = () => { showImage(bg[idx % bg.length]); idx++; };
      next();
      if (bg.length > 1) slideTimer = setInterval(next, 7000);
    } else {
      isVideoUrl(bg) ? showVideo(bg) : showImage(bg);
    }
    setTimeout(() => fade.classList.remove("visible"), 250);
  }, 580);
}

// URL absolue ou fichier local dans le dossier assets/
function logoSrc(logo) {
  return /^https?:\/\//.test(logo) ? logo : "../../assets/" + logo;
}

function selectServer(s, card) {
  selected = s;
  document.querySelectorAll(".server-card").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  setBackground(s.background || null);
  $("news-panel").classList.add("slide-away"); // les news s'effacent vers le haut

  // Le logo du haut est remplacé par celui du serveur, avec le bounce
  const zone = $("logo-zone"), servLogo = $("logo-server");
  if (s.logo) {
    servLogo.src = logoSrc(s.logo);
    $("logo-img").classList.add("hidden");
    $("logo-text").classList.add("hidden");
    servLogo.classList.remove("hidden");
  } else {
    servLogo.classList.add("hidden");
    $("logo-img").classList.remove("hidden");
    $("logo-text").classList.remove("hidden");
  }
  zone.style.animation = "none";
  void zone.offsetWidth; // force le redémarrage de l'animation bounce
  zone.style.animation = "";
  if (s.maintenance) {
    $("btn-play").disabled = true;
    $("progress-text").textContent = "⚠ " + s.name + " est en maintenance.";
  } else {
    $("btn-play").disabled = false;
    $("progress-text").textContent = "";
  }
}

$("btn-refresh")?.addEventListener("click", loadServers);

// ---------- Lancement ----------
const PROGRESS_LABELS = {
  java: "Installation de Java",
  mods: "Téléchargement des mods",
  modpack: "Téléchargement du pack de mods",
  loader: "Installation du modloader",
  forge: "Téléchargement de Forge",
  assets: "Téléchargement des ressources",
  natives: "Téléchargement des fichiers natifs",
  classes: "Téléchargement des librairies",
  "classes-custom": "Téléchargement des librairies",
  "assets-copy": "Copie des ressources",
};

$("btn-play").onclick = async () => {
  if (!selected) return;
  const btn = $("btn-play");
  btn.disabled = true;
  $("progress-text").textContent = "Préparation de " + selected.name + "...";
  const res = await launcher.launch(selected);
  if (!res.ok) {
    btn.disabled = false;
    $("progress-text").textContent = "Erreur : " + res.error;
  }
};

launcher.onProgress((d) => {
  const pct = d.total ? Math.round((d.task / d.total) * 100) : 0;
  const label = PROGRESS_LABELS[d.type] || "Téléchargement (" + d.type + ")";
  $("progress-fill").style.width = pct + "%";
  $("progress-text").textContent = `${label} — ${pct}%`;
});

launcher.onStarted(() => {
  $("progress-fill").style.width = "100%";
  $("progress-text").textContent = "Jeu lancé, bon jeu !";
});

launcher.onClosed(() => {
  $("btn-play").disabled = selected?.maintenance || false;
  $("progress-fill").style.width = "0%";
  $("progress-text").textContent = "";
});
