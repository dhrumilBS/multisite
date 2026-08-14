/* Mindi multiplayer client */
"use strict";

const socket = io();
window.socket = socket; // shared with teenpatti.js, a separate non-module script
const $ = (id) => document.getElementById(id);

// Best-effort landscape lock on mobile. The Screen Orientation API only
// grants lock() while the page is fullscreen (and iOS Safari doesn't support
// it at all), so the CSS rotate-overlay above is the real cross-device
// fallback - this just upgrades the experience where the browser allows it.
function tryLockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } catch (e) {}
}
document.addEventListener(
  "click",
  () => {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(tryLockLandscape).catch(() => {});
    } else {
      tryLockLandscape();
    }
  },
  { once: true }
);
tryLockLandscape();

// Persistent per-browser identity for the Teen Patti chip wallet - distinct
// from the per-room reconnect token below, since a wallet balance outlives
// any one room. Generated once and reused forever from this browser.
function getPlayerId() {
  try {
    let id = localStorage.getItem("player_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("player_id", id);
    }
    return id;
  } catch (e) {
    return null;
  }
}
const playerId = getPlayerId();
const SUIT_SYMBOL = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const SUIT_NAME = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const rankLabel = (r) => RANK_LABEL[r] || String(r);
const isRed = (s) => s === "H" || s === "D";

// High-quality hand-tuned SVG suit icons (crisper & more detailed than the
// flat unicode glyphs). `fill` is left to CSS (currentColor) so red/black
// theming and the trump-reveal glow keep working automatically.
const SUIT_PATH = {
  S: '<path d="M12 2.4C8.7 6.6 3.6 10 3.6 14.6a5.35 5.35 0 0 0 9.1 3.75c-.35 2.15-1.7 3.85-4.05 5.05h6.7c-2.35-1.2-3.7-2.9-4.05-5.05a5.35 5.35 0 0 0 9.1-3.75c0-4.6-5.1-8-8.4-12.2z"/>',
  H: '<path d="M12 21.4S3.3 15.7 3.3 9.5A5.45 5.45 0 0 1 12 5.55 5.45 5.45 0 0 1 20.7 9.5c0 6.2-8.7 11.9-8.7 11.9z"/>',
  D: '<path d="M12 1.3 22.3 12 12 22.7 1.7 12z"/>',
  C: '<path d="M12 1.9a3.75 3.75 0 0 0-2.05 6.9A3.75 3.75 0 1 0 8.6 15.6a3.7 3.7 0 0 0 1.85-.5c-.3 2.45-1.4 4.1-3.55 5.65h10.2c-2.15-1.55-3.25-3.2-3.55-5.65a3.7 3.7 0 0 0 1.85.5 3.75 3.75 0 1 0-1.35-6.8A3.75 3.75 0 0 0 12 1.9z"/>',
};
function suitIcon(suit, extraClass) {
  return `<svg class="suit-icon${extraClass ? " " + extraClass : ""}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${SUIT_PATH[suit]}</svg>`;
}

let state = null; // latest server view
let myCode = null;
let chatOpen = false;
let seenChat = 0;
let lastHandSeq = null; // used to fire the deal animation exactly once per new hand
let pendingFlip = null; // { cardId, rect } captured just before emitting our own playCard
let prevTrickCardIds = new Set(); // trick cards already on the table as of the last render, so re-renders don't replay their drop-in animation

// ---------- sound effects ----------
// Synthesized with the Web Audio API rather than external audio files, so
// there's no asset to host/load and it works instantly, offline, every time.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function tone(ctx, freq, start, dur, type, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak || 0.18, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}
const SFX = {
  trumpReveal() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ctx, f, t + i * 0.075, 0.4, "triangle", 0.17));
  },
  tenCaptured(good) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    if (good) {
      tone(ctx, 880, t, 0.15, "sine", 0.22);
      tone(ctx, 1318.5, t + 0.09, 0.24, "sine", 0.18);
    } else {
      tone(ctx, 440, t, 0.16, "sine", 0.16);
      tone(ctx, 349.23, t + 0.09, 0.24, "sine", 0.12);
    }
  },
  win() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => tone(ctx, f, t + i * 0.11, 0.45, "triangle", 0.2));
  },
  lose() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    [392, 349.23, 293.66, 246.94].forEach((f, i) => tone(ctx, f, t + i * 0.17, 0.55, "sawtooth", 0.11));
  },
};
// AudioContext needs a user gesture before it can play on most browsers -
// prime it on the first tap/click anywhere in the app.
document.addEventListener("pointerdown", () => getAudioCtx(), { once: true });

// ---------- helpers ----------
function show(screen) {
  ["screen-home", "screen-lobby", "screen-pending", "screen-game", "screen-teenpatti"].forEach(
    (s) => ($(s).style.display = s === screen ? (s === "screen-game" || s === "screen-teenpatti" ? "flex" : "block") : "none")
  );
}
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = "none"), ms);
}
function saveSession(code, token, name) {
  try {
    localStorage.setItem("mindi_session_" + code, JSON.stringify({ token, name, at: Date.now() }));
    localStorage.setItem("mindi_name", name);
  } catch (e) {}
}
function getSessions() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("mindi_session_")) {
        out.push({ code: k.replace("mindi_session_", ""), ...JSON.parse(localStorage.getItem(k)) });
      }
    }
  } catch (e) {}
  return out.sort((a, b) => b.at - a.at).slice(0, 5);
}
function dropSession(code) {
  try { localStorage.removeItem("mindi_session_" + code); } catch (e) {}
}

// ---------- theming ----------
const THEMES = [
  { id: "classic", label: "Classic Casino", bg: "#0b2b26", accent: "#e6b84c" },
  { id: "midnight", label: "Midnight Neon", bg: "#07061a", accent: "#5ce1ff" },
  { id: "royal", label: "Royal Purple", bg: "#1c0d24", accent: "#e0a860" },
  { id: "crimson", label: "Crimson Noir", bg: "#0a0404", accent: "#e8b23c" },
  { id: "ocean", label: "Ocean Teal", bg: "#04181c", accent: "#3fd0e0" },
  { id: "sunset", label: "Sunset Blaze", bg: "#1a0a1c", accent: "#ff8a3d" },
  { id: "forest", label: "Forest Wood", bg: "#140f06", accent: "#8fbf5c" },
  { id: "light", label: "Light / High-contrast", bg: "#e6e0cc", accent: "#b8860b" },
];
function applyTheme(id) {
  const valid = THEMES.some((t) => t.id === id) ? id : "classic";
  if (valid === "classic") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = valid;
  try { localStorage.setItem("mindi_theme", valid); } catch (e) {}
  document.querySelectorAll(".theme-swatch").forEach((el) => el.classList.toggle("active", el.dataset.themeId === valid));
}
function buildThemeGrid() {
  const grid = $("themeGrid");
  grid.innerHTML = THEMES.map(
    (t) =>
      `<div class="theme-swatch" data-theme-id="${t.id}">` +
      `<div class="sw-preview" style="background:linear-gradient(135deg, ${t.bg}, ${t.accent})"></div>` +
      `<span class="sw-label">${esc(t.label)}</span></div>`
  ).join("");
  grid.querySelectorAll(".theme-swatch").forEach((el) => {
    el.onclick = () => applyTheme(el.dataset.themeId);
  });
}
buildThemeGrid();
applyTheme(localStorage.getItem("mindi_theme") || "classic");
function openThemePicker() { $("ovTheme").style.display = "flex"; }
$("btnThemeHome").onclick = openThemePicker;
$("btnThemeGame").onclick = openThemePicker;
$("btnCloseTheme").onclick = () => ($("ovTheme").style.display = "none");
$("btnGameInfo").onclick = () => ($("ovGameInfo").style.display = "flex");
$("btnCloseGameInfo").onclick = () => ($("ovGameInfo").style.display = "none");

// ---------- home screen ----------
try { $("playerName").value = localStorage.getItem("mindi_name") || ""; } catch (e) {}

// ---------- profile (name + photo) ----------
// Server-persisted per playerId, mirrored into localStorage as a fast-paint
// cache so the avatar shows instantly on next load without waiting on a
// round trip.
let profilePhoto = null;
try {
  profilePhoto = localStorage.getItem("profile_photo_cache") || null;
} catch (e) {}

function renderProfilePreview() {
  if (profilePhoto) {
    $("profileAvatarImg").src = profilePhoto;
    $("profileAvatarImg").style.display = "block";
    $("profileAvatarFallback").style.display = "none";
  } else {
    $("profileAvatarImg").style.display = "none";
    $("profileAvatarFallback").style.display = "flex";
    $("profileAvatarFallback").textContent = ($("playerName").value.trim()[0] || "?").toUpperCase();
  }
}
renderProfilePreview();
$("playerName").addEventListener("input", () => {
  if (!profilePhoto) renderProfilePreview();
});

let profileSaveTimer = null;
function saveProfile(partial) {
  if (!playerId) return;
  socket.emit("setProfile", { playerId, ...partial }, (res) => {
    if (res && res.error) toast(res.error);
  });
}
function saveProfileNameDebounced() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => saveProfile({ name: $("playerName").value.trim() }), 600);
}
$("playerName").addEventListener("input", saveProfileNameDebounced);

if (playerId) {
  socket.emit("getProfile", { playerId }, (res) => {
    if (!res) return;
    if (res.photo && !profilePhoto) {
      profilePhoto = res.photo;
      try { localStorage.setItem("profile_photo_cache", profilePhoto); } catch (e) {}
      renderProfilePreview();
    }
    if (res.name && !$("playerName").value.trim()) {
      $("playerName").value = res.name;
      renderProfilePreview();
    }
  });
}

// Resize/crop any chosen image to a small square before it ever leaves the
// browser - keeps the data URI small (a few KB) and uniform for every avatar.
function resizeImageToDataURL(file, size, cb) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      cb(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}
// ---------- passbook (coin transaction history) ----------
function renderPassbook(res) {
  $("passbookBalance").textContent = (res && res.balance) || 0;
  const list = $("passbookList");
  const ledger = (res && res.ledger) || [];
  if (!ledger.length) {
    list.innerHTML = `<div class="passbook-empty">No coin activity yet - play a Teen Patti hand to get started.</div>`;
    return;
  }
  list.innerHTML = ledger
    .map((e) => {
      const cls = e.type === "host-grant" ? "neutral" : e.amount >= 0 ? "credit" : "debit";
      const sign = e.amount > 0 ? "+" : "";
      const balanceText = e.balanceAfter != null ? `Balance: ${e.balanceAfter}` : "Table chips only";
      const when = new Date(e.at).toLocaleString();
      return `<div class="passbook-item">
        <div class="pb-info">
          <div class="pb-note">${esc(e.note || e.type)}</div>
          <div class="pb-when">${esc(when)}</div>
        </div>
        <div>
          <div class="pb-amount ${cls}">${sign}${e.amount} coins</div>
          <div class="pb-balance">${esc(balanceText)}</div>
        </div>
      </div>`;
    })
    .join("");
}
$("btnPassbook").onclick = () => {
  if (!playerId) return;
  $("ovPassbook").style.display = "flex";
  socket.emit("getLedger", { playerId }, (res) => {
    if (res && res.error) return toast(res.error);
    renderPassbook(res);
  });
};
$("btnClosePassbook").onclick = () => ($("ovPassbook").style.display = "none");

$("btnUploadPhoto").onclick = () => $("photoFileInput").click();
$("photoFileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  resizeImageToDataURL(file, 128, (dataUrl) => {
    profilePhoto = dataUrl;
    try { localStorage.setItem("profile_photo_cache", dataUrl); } catch (e2) {}
    renderProfilePreview();
    saveProfile({ name: $("playerName").value.trim(), photo: dataUrl });
  });
  e.target.value = "";
});

// Prefill + jump to the join tab when arriving via a shared invite link (?join=CODE)
try {
  const qp = new URLSearchParams(location.search).get("join");
  if (qp && qp.length === 6) {
    $("joinCode").value = qp.toUpperCase();
    document.querySelector('.tab[data-tab="join"]').click();
    history.replaceState(null, "", location.pathname);
  }
} catch (e) {}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("tab-create").style.display = tab.dataset.tab === "create" ? "block" : "none";
    $("tab-join").style.display = tab.dataset.tab === "join" ? "block" : "none";
  };
});
["opt-players", "opt-decks", "opt-trump", "opt-speed", "opt-tp-players", "opt-tp-variant", "opt-tp-speed"].forEach((rowId) => {
  $(rowId).querySelectorAll(".opt").forEach((btn) => {
    btn.onclick = () => {
      $(rowId).querySelectorAll(".opt").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    };
  });
});
function pickedOption(rowId) {
  return $(rowId).querySelector(".opt.active").dataset.v;
}

// ---------- game selector (Mindi vs Teen Patti) ----------
function refreshWalletInfo() {
  if (pickedOption("opt-game") !== "teenpatti" || !playerId) return;
  socket.emit("walletBalance", { playerId }, (res) => {
    $("tpWalletInfo").textContent = res && typeof res.balance === "number" ? `You have ${res.balance} chips.` : "";
  });
}
$("opt-game").querySelectorAll(".opt").forEach((btn) => {
  btn.onclick = () => {
    $("opt-game").querySelectorAll(".opt").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const isTp = btn.dataset.v === "teenpatti";
    $("mindiOpts").style.display = isTp ? "none" : "block";
    $("tpOpts").style.display = isTp ? "block" : "none";
    $("brandTitle").textContent = isTp ? "Teen Patti" : "Mindi";
    $("brandSub").textContent = isTp
      ? "Blind or seen, chaal or pack. With real friends + bots."
      : "Capture the tens. Beat the table. With real friends + bots.";
    if (isTp) refreshWalletInfo();
  };
});
$("btnTpAdvancedToggle").onclick = () => {
  const open = $("tpAdvancedOpts").classList.toggle("open");
  $("tpAdvancedOpts").classList.toggle("collapsed", !open);
  $("btnTpAdvancedToggle").classList.toggle("open", open);
  $("btnTpAdvancedToggle").setAttribute("aria-expanded", String(open));
};
$("btnAdvancedToggle").onclick = () => {
  const open = $("advancedOpts").classList.toggle("open");
  $("advancedOpts").classList.toggle("collapsed", !open);
  $("btnAdvancedToggle").classList.toggle("open", open);
  $("btnAdvancedToggle").setAttribute("aria-expanded", String(open));
};

function renderResumeList() {
  const sessions = getSessions();
  $("resumeBox").style.display = sessions.length ? "block" : "none";
  $("resumeList").innerHTML = "";
  sessions.forEach((s) => {
    const div = document.createElement("div");
    div.className = "resume-item";
    div.innerHTML = `<span>Room <b style="letter-spacing:3px">${esc(s.code)}</b> · as ${esc(s.name)}</span><span style="color:#c9a24a">Resume →</span>`;
    div.onclick = () => {
      socket.emit("rejoin", { code: s.code, token: s.token }, (res) => {
        if (res.error) {
          $("homeErr").textContent = res.error + " (removing from list)";
          dropSession(s.code);
          renderResumeList();
          return;
        }
        myCode = res.code;
        applyState(res.state);
      });
    };
    $("resumeList").appendChild(div);
  });
}
renderResumeList();

function buildCreateConfig() {
  const isTp = pickedOption("opt-game") === "teenpatti";
  if (isTp) {
    return {
      gameType: "teenpatti",
      players: +pickedOption("opt-tp-players"),
      variant: pickedOption("opt-tp-variant"),
      bootAmount: +$("tpBoot").value,
      buyIn: +$("tpBuyIn").value,
      sideShowAllowed: true,
      speed: pickedOption("opt-tp-speed"),
    };
  }
  return {
    gameType: "mindi",
    players: +pickedOption("opt-players"),
    decks: +pickedOption("opt-decks"),
    trumpMode: pickedOption("opt-trump"),
    speed: pickedOption("opt-speed"),
  };
}

$("btnCreate").onclick = () => {
  const name = $("playerName").value.trim();
  const config = buildCreateConfig();

  if (!name) return ($("homeErr").textContent = "Please enter your name first.");

  socket.emit("createRoom", { name, config, playerId }, (res) => {
    if (res.error) return ($("homeErr").textContent = res.error);
    myCode = res.code;
    saveSession(res.code, res.token, name);
    applyState(res.state);
  });
};

let pendingName = null;
$("btnJoin").onclick = () => {
  const name = $("playerName").value.trim();
  const code = $("joinCode").value.trim().toUpperCase();
  if (!name) return ($("homeErr").textContent = "Please enter your name first.");
  if (code.length !== 6) return ($("homeErr").textContent = "Room codes are 6 characters.");
  socket.emit("requestJoin", { code, name, playerId }, (res) => {
    if (res.error) return ($("homeErr").textContent = res.error);
    myCode = res.code;
    pendingName = name;
    try { localStorage.setItem("mindi_name", name); } catch (e) {}
    $("pendingCode").textContent = res.code;
    show("screen-pending");
  });
};
$("btnCancelPending").onclick = () => {
  socket.emit("cancelJoinRequest", {}, () => {
    myCode = null;
    show("screen-home");
  });
};
socket.on("joinApproved", (res) => {
  myCode = res.code;
  saveSession(res.code, res.token, pendingName || $("playerName").value.trim());
  applyState(res.state);
});
socket.on("joinRejected", (msg) => {
  myCode = null;
  show("screen-home");
  toast((msg && msg.reason) || "The host declined your request.");
});

// ---------- lobby ----------
$("btnCopyCode").onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(myCode).then(() => toast("Code copied!"));
};
$("btnCopyLink").onclick = () => {
  const link = location.origin + "/?join=" + myCode;
  if (navigator.share) {
    navigator.share({ url: link, title: "Join my Mindi room" }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(() => toast("Invite link copied!"));
  }
};
$("btnStart").onclick = () => {
  socket.emit("startGame", {}, (res) => {
    if (res && res.error) $("lobbyErr").textContent = res.error;
  });
};
$("btnLeaveLobby").onclick = () => {
  socket.emit("saveExit", {}, () => {
    state = null;
    show("screen-home");
    renderResumeList();
  });
};

function renderLobby() {
  $("lobbyCode").textContent = state.code;
  const c = state.config;
  const isTp = c.gameType === "teenpatti";
  if (isTp) {
    const variantLabel = { classic: "Classic", muflis: "Muflis (lowest wins)", ak47: "AK47 (A,K,4,7 wild)", joker: "Joker wild" }[c.variant] || c.variant;
    $("lobbyCfg").innerHTML =
      `<span>${c.players} players</span>` +
      `<span>Variant: ${variantLabel}</span>` +
      `<span>Boot ${c.bootAmount} · Buy-in ${c.buyIn}</span>` +
      `<span>Speed: ${c.speed}</span>`;
  } else {
    $("lobbyCfg").innerHTML =
      `<span>${c.players} players (${c.players / 2}v${c.players / 2})</span>` +
      `<span>${c.decks} deck${c.decks > 1 ? "s" : ""} · ${c.decks * 4} tens</span>` +
      `<span>Trump: ${{ cut: "First cut", hidden: "Hidden (Band)", random: "Open random", none: "No trump" }[c.trumpMode]}</span>` +
      `<span>Speed: ${c.speed}</span>`;
  }
  const isHost = state.seats[state.you] && state.seats[state.you].isHost;
  const seatsEl = $("lobbySeats");
  seatsEl.innerHTML = "";
  state.seats.forEach((s, i) => {
    const div = document.createElement("div");
    const myTeam = state.you % 2;
    div.className = "seat-card " + (isTp ? "" : i % 2 === myTeam ? "teamA" : "teamB");
    let who = s.name
      ? `<span class="who">${esc(s.name)}${i === state.you ? " (you)" : ""}${s.isBot ? " 🤖" : ""}</span>`
      : `<span class="who" style="color:#6f9a91">Empty seat</span>`;
    let right = "";
    if (s.isHost) right = `<span class="tag">HOST</span>`;
    else if (s.name && !s.connected && !s.isBot) right = `<span class="off">offline</span>`;
    else if (!s.name && isHost) right = `<button class="tiny" data-bot="${i}">+ Bot</button>`;
    div.innerHTML = who + right;
    if (s.avatar) {
      const whoEl = div.querySelector(".who");
      if (whoEl) {
        const img = document.createElement("img");
        img.className = "seat-card-avatar";
        img.alt = "";
        img.src = s.avatar;
        whoEl.insertBefore(img, whoEl.firstChild);
      }
    }
    seatsEl.appendChild(div);
  });
  seatsEl.querySelectorAll("[data-bot]").forEach((b) => {
    b.onclick = () => socket.emit("addBot", { seat: +b.dataset.bot }, () => {});
  });
  $("btnStart").style.display = isHost ? "block" : "none";
  $("lobbyWait").style.display = isHost ? "none" : "block";

  const pend = state.pendingJoins || [];
  $("lobbyPending").style.display = isHost && pend.length ? "block" : "none";
  if (isHost && pend.length) {
    $("pendingList").innerHTML = pend
      .map(
        (p) =>
          `<div class="pending-item"><span>${esc(p.name)}</span><span class="btnrow-inline">` +
          `<button class="tiny accept" data-approve="${p.reqId}">Accept</button>` +
          `<button class="tiny reject" data-reject="${p.reqId}">Reject</button></span></div>`
      )
      .join("");
    $("pendingList").querySelectorAll("[data-approve]").forEach((b) => {
      b.onclick = () => socket.emit("approveJoin", { reqId: b.dataset.approve }, (r) => r && r.error && toast(r.error));
    });
    $("pendingList").querySelectorAll("[data-reject]").forEach((b) => {
      b.onclick = () => socket.emit("rejectJoin", { reqId: b.dataset.reject }, (r) => r && r.error && toast(r.error));
    });
  }
}

// ---------- game rendering ----------
// Seats sit around an ellipse in real seating order - starting with "you"
// at the bottom (6 o'clock) and going seat-by-seat around the table, which
// is exactly the opponent/mine/opponent/mine alternation since teams are
// assigned by seat parity (seat % 2). Percentages are relative to the
// table-area's own box, so the ellipse reshapes to fit portrait phones and
// wide desktops alike without any breakpoint-specific math.
function seatAngle(seat, you, n) {
  const k = (seat - you + n) % n;
  return (180 + k * (360 / n)) % 360; // degrees, 0 = top, clockwise; turn order runs clockwise around the table
}
function seatPos(angleDeg, rx, ry) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: 50 + rx * Math.sin(rad), y: 50 - ry * Math.cos(rad) };
}
// Trick cards rest in a small ring near the felt's center, each one biased
// toward the side of the table its player is sitting on - so a card looks
// like it was played *from* that seat, no matter how many players there are.
function trickSlotPos(angleDeg) {
  return seatPos(angleDeg, 15, 13);
}
// Fans a hand row's cards into a shallow curved arc (like a real card fan)
// by setting a --rot/--lift custom property per card, picked up by the
// .hand-row/.tp-hand-row .card CSS rules. Uses the same angle-then-trig
// approach as seatPos above, just applied to per-card rotation/lift instead
// of ring position.
function applyHandFan(rowEl) {
  const cards = rowEl.querySelectorAll(":scope > .card");
  const m = cards.length;
  const spread = m <= 1 ? 0 : Math.min(34, 2.4 * (m - 1)); // total degrees, capped
  const radius = 140; // px - how much the fan's ends dip relative to its center
  cards.forEach((el, i) => {
    const angle = m <= 1 ? 0 : -spread / 2 + (spread * i) / (m - 1);
    const lift = (1 - Math.cos((angle * Math.PI) / 180)) * radius;
    el.style.setProperty("--rot", angle.toFixed(2) + "deg");
    el.style.setProperty("--lift", lift.toFixed(2) + "px");
  });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
// Replaces a ".avatar" element's initial-letter content with a real photo -
// sets img.src via a DOM property, never by string-interpolating the data
// URI into an innerHTML template, since this data comes from OTHER players
// (server-validated, but this is defense in depth).
function setSeatAvatar(container, avatarDataUrl) {
  if (!avatarDataUrl) return;
  const avatarEl = container.querySelector(".avatar");
  if (!avatarEl) return;
  avatarEl.textContent = "";
  const img = document.createElement("img");
  img.className = "avatar-photo";
  img.alt = "";
  img.src = avatarDataUrl;
  avatarEl.appendChild(img);
}
function cardHTML(card, cls) {
  const red = isRed(card.suit) ? " red" : "";
  const ten = card.rank === 10 ? " ten" : "";
  const rk = rankLabel(card.rank);
  return `<div class="card${red}${ten} ${cls || ""}" data-cid="${card.id}">
    <div class="tl"><span class="rank">${rk}</span>${suitIcon(card.suit, "corner")}</div>
    ${suitIcon(card.suit, "watermark")}
    <div class="br"><span class="rank">${rk}</span>${suitIcon(card.suit, "corner")}</div>
  </div>`;
}

function renderGame() {
  const g = state.game;
  const n = state.config.players;
  const you = state.you;
  const names = state.seats.map((s) => s.name || "?");

  $("giMeta").textContent = `${n}p · ${state.config.decks} deck${state.config.decks > 1 ? "s" : ""} · room ${state.code}`;

  // badges
  let trumpTxt;
  if (state.config.trumpMode === "none") trumpTxt = "None";
  else if (!g.trumpSet) trumpTxt = "Not cut yet";
  else if (g.trumpSuit)
    trumpTxt = `<span style="color:${isRed(g.trumpSuit) ? "#f08a7e" : "#dfe9e6"};font-size:16px">${SUIT_SYMBOL[g.trumpSuit]}</span> ${SUIT_NAME[g.trumpSuit]}${!g.trumpRevealed ? " (only you know)" : ""}`;
  else trumpTxt = "Hidden 🂠";
  $("bTrump").innerHTML = trumpTxt;

  const myTeam = you % 2;
  const yourTens = g.captured[myTeam].tens.length;
  const oppTens = g.captured[1 - myTeam].tens.length;
  $("bTens").innerHTML = `<span class="t-you">${yourTens}</span>:<span class="t-opp">${oppTens}</span> <small style="color:#8fb5ac">/${g.totalTens}</small>`;
  $("bMatch").innerHTML = `<span class="t-you">${state.matchScore[myTeam]}</span>:<span class="t-opp">${state.matchScore[1 - myTeam]}</span>`;
  $("btnLastTrick").style.display = g.lastTrick ? "inline-block" : "none";

  // seats - placed one by one around the table in real seating order
  // (starting at "you", bottom-center, then seat-by-seat around), which
  // naturally alternates opponent/mine/opponent/mine since teams are
  // assigned by seat parity.
  const ring = $("seatsRing");
  ring.innerHTML = "";
  const RX = 45, RY = 41;

  function renderSeat(seat) {
    const isTurn = state.phase === "playing" && g.turnSeat === seat && !state.paused;
    const s = state.seats[seat];
    const mine = seat % 2 === myTeam;
    const div = document.createElement("div");
    div.className = `seat${isTurn ? " turn" : ""}${seat === you ? " me" : ""} ${mine ? "team-mine" : "team-opp"}`;
    if (seat === you) {
      div.innerHTML = `<div class="avatar">You${isTurn ? " · your turn" : ""}</div>`;
    } else {
      div.innerHTML = `
        <div class="avatar">${esc(names[seat][0] || "?")}</div>
        <div class="nm">${esc(names[seat])}${s.isBot ? " 🤖" : ""}</div>
        <div class="sub">${g.counts[seat]} cards${g.cutBy === seat ? " · ✂" : ""}${!s.connected && !s.isBot ? ' <span class="offline">offline</span>' : ""}</div>`;
      setSeatAvatar(div, s.avatar);
    }
    return div;
  }
  for (let k = 0; k < n; k++) {
    const seat = (you + k) % n;
    const angle = seatAngle(seat, you, n);
    const pos = seatPos(angle, seat === you ? RX * 0.7 : RX, seat === you ? RY * 1.12 : RY);
    const el = renderSeat(seat);
    el.style.left = pos.x + "%";
    el.style.top = pos.y + "%";
    ring.appendChild(el);
  }

  // trick cards - each one rests biased toward its player's seat, so the
  // table always reads as "this card came from that seat". The whole layer
  // is rebuilt every render (trick can be re-rendered for unrelated state
  // changes), so cards already on the table before this render skip the
  // drop-in animation entirely - only the newly-played card gets it.
  const trickLayer = $("trickLayer");
  trickLayer.innerHTML = "";
  const nextTrickCardIds = new Set();
  g.trick.forEach((t) => {
    const angle = seatAngle(t.seat, you, n);
    const pos = trickSlotPos(angle);
    const rad = (angle * Math.PI) / 180;
    const isNew = !prevTrickCardIds.has(t.card.id);
    nextTrickCardIds.add(t.card.id);
    const wrap = document.createElement("div");
    wrap.className = "trick-card";
    wrap.dataset.side = t.seat % 2 === myTeam ? "mine" : "opp";
    wrap.style.left = pos.x + "%";
    wrap.style.top = pos.y + "%";
    if (!isNew) wrap.style.animation = "none";
    wrap.style.setProperty("--fx", Math.round(Math.sin(rad) * 90) + "px");
    wrap.style.setProperty("--fy", Math.round(-Math.cos(rad) * 90) + "px");
    wrap.innerHTML = cardHTML(t.card, "sm");
    trickLayer.appendChild(wrap);

    // Our own just-played card gets a real FLIP from its old hand position
    // instead of the generic CSS slide-in used for everyone else's plays.
    if (isNew && t.seat === you && pendingFlip && pendingFlip.cardId === t.card.id) {
      const newRect = wrap.getBoundingClientRect();
      const oldRect = pendingFlip.rect;
      const dx = oldRect.left + oldRect.width / 2 - (newRect.left + newRect.width / 2);
      const dy = oldRect.top + oldRect.height / 2 - (newRect.top + newRect.height / 2);
      wrap.style.animation = "none";
      wrap.style.opacity = "0.6";
      wrap.style.transform = `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(.6)`;
      void wrap.offsetWidth; // force reflow so the transition below actually animates
      wrap.style.transition = "transform .28s ease-out, opacity .28s ease-out";
      requestAnimationFrame(() => {
        wrap.style.transform = "translate(-50%,-50%)";
        wrap.style.opacity = "1";
      });
      pendingFlip = null;
    }
  });
  prevTrickCardIds = nextTrickCardIds;

  // status line
  let status;
  if (state.paused) status = "Paused - waiting for a player…";
  else if (state.phase === "handEnd") status = "Hand complete";
  else if (state.phase === "trumpSelect")
    status = g.chooser === you ? "Pick the hidden trump" : `${esc(names[g.chooser])} is choosing the trump…`;
  else if (g.trick.length === n) status = "Resolving trick…";
  else if (g.turnSeat === you)
    status = g.trick.length === 0 ? "You lead - play any card" : `Follow ${SUIT_NAME[g.trick[0].card.suit]} if you can`;
  else status = `${esc(names[g.turnSeat])} is thinking…`;
  $("statusLine").innerHTML = status;

  // hand
  const legal = new Set(g.legal || []);
  const row = $("handRow");
  const myTurn = state.phase === "playing" && g.turnSeat === you && !state.paused;
  const newHand = lastHandSeq !== null && state.handSeq !== lastHandSeq;
  lastHandSeq = state.handSeq;
  row.className = "hand-row" + (g.hand.length > 13 ? " many overlap" : g.hand.length > 9 ? " overlap" : "");
  row.innerHTML = g.hand
    .map((c) => {
      let cls = "";
      if (myTurn) cls = legal.has(c.id) ? "playable" : "disabled";
      return cardHTML(c, cls);
    })
    .join("");
  applyHandFan(row);
  if (newHand) {
    [...row.children].forEach((el, i) => {
      el.classList.add("dealt");
      el.style.animationDelay = i * 35 + "ms";
    });
  }
  if (myTurn) {
    row.querySelectorAll(".card.playable").forEach((el) => {
      el.onclick = () => {
        pendingFlip = { cardId: +el.dataset.cid, rect: el.getBoundingClientRect() };
        socket.emit("playCard", { cardId: +el.dataset.cid }, (res) => {
          if (res && res.error) {
            toast(res.error);
            pendingFlip = null;
          }
        });
      };
    });
  }

  // overlays
  $("ovTrump").style.display = state.phase === "trumpSelect" && g.chooser === you ? "flex" : "none";
  if (state.phase === "trumpSelect" && g.chooser === you) {
    const counts = {};
    g.hand.forEach((c) => (counts[c.suit] = (counts[c.suit] || 0) + 1));
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    $("trumpHint").textContent = `Tip: your longest suit is ${SUIT_NAME[best]} (${counts[best]} cards)`;
  }

  const humanOffline = state.seats.filter((s) => s.name && !s.isBot && !s.connected);
  const showPause = state.paused && (state.phase === "playing" || state.phase === "trumpSelect");
  $("ovPaused").style.display = showPause ? "flex" : "none";
  if (showPause) {
    $("pausedWho").textContent = humanOffline.length
      ? humanOffline.map((s) => s.name).join(", ") + " disconnected."
      : "A player disconnected.";
    const isHost = state.seats[you].isHost;
    const act = $("pausedActions");
    act.innerHTML = "";
    if (isHost) {
      humanOffline.forEach((s) => {
        const b = document.createElement("button");
        b.className = "dark";
        b.style.marginTop = "8px";
        b.textContent = `Hand ${s.name}'s seat to a bot`;
        b.onclick = () => socket.emit("addBot", { seat: s.seat }, (r) => r && r.error && toast(r.error));
        act.appendChild(b);
      });
    }
    const exitB = document.createElement("button");
    exitB.className = "dark";
    exitB.style.marginTop = "8px";
    exitB.textContent = "Save & exit (come back later)";
    exitB.onclick = doSaveExit;
    act.appendChild(exitB);
  }

  // match end (the whole match, not just one hand - server auto-deletes the room after this)
  $("ovMatchEnd").style.display = state.phase === "matchEnd" && state.matchResult ? "flex" : "none";
  if (state.phase === "matchEnd" && state.matchResult) {
    const mr = state.matchResult;
    const wonMatch = mr.winner === myTeam;
    $("meTitle").textContent = wonMatch ? "You won the match!" : "Opponents won the match";
    $("meTitle").style.color = wonMatch ? "#7ee0a3" : "#f08a7e";
    $("meScore").textContent = `Final score - You ${mr.score[myTeam]} : ${mr.score[1 - myTeam]} Them (first to ${mr.target})`;
  }

  // hand end
  $("ovHandEnd").style.display = state.phase === "handEnd" && g.result ? "flex" : "none";
  if (state.phase === "handEnd" && g.result) {
    const r = g.result;
    const won = r.winner === myTeam;
    $("heTitle").textContent = r.winner === null ? "It's a draw" : won ? "Your team wins!" : "Opponents win";
    $("heTitle").style.color = r.winner === null ? "#f3e3b3" : won ? "#7ee0a3" : "#f08a7e";
    $("heReason").textContent = r.reason;
    const teamsEl = $("heTeams");
    teamsEl.innerHTML = [myTeam, 1 - myTeam]
      .map((team, idx) => {
        const cap = g.captured[team];
        const tens = cap.tens.map((c) => `<span style="color:${isRed(c.suit) ? "#f08a7e" : "#dfe9e6"}">10${SUIT_SYMBOL[c.suit]}</span>`).join("");
        const members = state.seats.filter((_, i) => i % 2 === team).map((s) => esc(s.name || "?")).join(", ");
        return `<div class="he-team ${idx === 0 ? "you" : "opp"}">
          <div class="t">${idx === 0 ? "Your team" : "Opponents"}</div>
          <div class="big">${cap.tens.length} <small style="font-size:13px">tens</small></div>
          <div class="small">${cap.tricks} tricks</div>
          <div class="tens">${tens}</div>
          <div class="small" style="margin-top:5px">${members}</div>
        </div>`;
      })
      .join("");
    $("heMatch").textContent = `Match score - You ${state.matchScore[myTeam]} : ${state.matchScore[1 - myTeam]} Them`;
    const isHost = state.seats[you].isHost;
    $("btnNextHand").style.display = isHost ? "block" : "none";
    $("btnEndRoom").style.display = isHost ? "block" : "none";
    $("heWait").style.display = isHost ? "none" : "block";
  }

  // chat
  renderChat();
}

function renderChat() {
  const msgs = state.chat || [];
  const box = $("chatMsgs");
  box.innerHTML = msgs.map((m) => `<div class="m"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join("");
  box.scrollTop = box.scrollHeight;
  if (!chatOpen && msgs.length > seenChat) $("chatDot").style.display = "inline-block";
  if (chatOpen) seenChat = msgs.length;
}

// ---------- trump reveal moment ----------
function showTrumpReveal(suit) {
  SFX.trumpReveal();
  const ov = $("ovTrumpReveal");
  const card = $("trumpRevealCard");
  card.className = "trump-reveal-card" + (isRed(suit) ? " red" : "");
  card.innerHTML = suitIcon(suit);
  $("trumpRevealLabel").textContent = `Trump revealed - ${SUIT_NAME[suit]}!`;
  ov.style.display = "flex";
  ov.classList.remove("show");
  void ov.offsetWidth; // restart animation if triggered again quickly
  ov.classList.add("show");
  clearTimeout(showTrumpReveal._t);
  showTrumpReveal._t = setTimeout(() => {
    ov.classList.remove("show");
    setTimeout(() => (ov.style.display = "none"), 350);
  }, 2700);
}

// suit choose
document.querySelectorAll(".suitbtn").forEach((b) => {
  b.onclick = () => socket.emit("chooseTrump", { suit: b.dataset.s }, (r) => r && r.error && toast(r.error));
});

// last trick
$("btnLastTrick").onclick = () => {
  const lt = state.game && state.game.lastTrick;
  if (!lt) return;
  const names = state.seats.map((s) => s.name || "?");
  $("ltTitle").textContent = `Last trick - won by ${names[lt.winner]}`;
  $("ltCards").innerHTML = lt.cards
    .map((t) => `<div class="lt-item">${cardHTML(t.card, t.seat === lt.winner ? "win" : "")}<div class="nm">${esc(names[t.seat])}</div></div>`)
    .join("");
  $("ovLastTrick").style.display = "flex";
};
$("btnCloseLT").onclick = () => ($("ovLastTrick").style.display = "none");

// hand end buttons
$("btnNextHand").onclick = () => socket.emit("nextHand", {}, (r) => r && r.error && toast(r.error));
$("btnEndRoom").onclick = () => {
  if (confirm("End the room for everyone? The save will be deleted.")) {
    socket.emit("endRoom", {}, () => {
      dropSession(myCode);
      state = null;
      show("screen-home");
      renderResumeList();
    });
  }
};

$("btnMatchHome").onclick = () => {
  dropSession(myCode);
  state = null;
  show("screen-home");
  renderResumeList();
};

// save & exit
function doSaveExit() {
  socket.emit("saveExit", {}, () => {
    toast("Progress saved - resume any time from the home screen.");
    state = null;
    show("screen-home");
    renderResumeList();
  });
}
$("btnExitGame").onclick = doSaveExit;

// chat wiring
$("btnChat").onclick = () => {
  chatOpen = !chatOpen;
  $("chatPanel").style.display = chatOpen ? "flex" : "none";
  if (chatOpen) {
    $("chatDot").style.display = "none";
    seenChat = (state && state.chat && state.chat.length) || 0;
  }
};
$("btnCloseChat").onclick = () => {
  chatOpen = false;
  $("chatPanel").style.display = "none";
};
function sendChat() {
  const t = $("chatText").value.trim();
  if (!t) return;
  socket.emit("chat", { text: t });
  $("chatText").value = "";
}
$("btnSendChat").onclick = sendChat;
$("chatText").addEventListener("keydown", (e) => e.key === "Enter" && sendChat());

// ---------- state routing ----------
function applyState(s, extra) {
  const prev = state;
  state = s;
  if (extra && extra.roomEnded) {
    toast("The host ended the room.");
    dropSession(myCode);
    state = null;
    show("screen-home");
    renderResumeList();
    return;
  }
  if (s.phase === "lobby") {
    show("screen-lobby");
    renderLobby();
  } else if (s.config.gameType === "teenpatti") {
    show("screen-teenpatti");
    if (window.renderTeenPatti) window.renderTeenPatti(s, extra);
  } else {
    show("screen-game");
    renderGame();

    const myTeam = s.you % 2;

    // A ten just landed in someone's capture pile - play the "earned 10
    // points" sting (a brighter tone for our team, a duller one for theirs).
    if (prev && prev.game && s.game) {
      const prevTotal = prev.game.captured[0].tens.length + prev.game.captured[1].tens.length;
      const newTotal = s.game.captured[0].tens.length + s.game.captured[1].tens.length;
      if (newTotal > prevTotal) {
        const gainedOurs = s.game.captured[myTeam].tens.length > prev.game.captured[myTeam].tens.length;
        SFX.tenCaptured(gainedOurs);
      }
    }

    // Hand just finished - win/lose fanfare (once, on the transition).
    if (s.phase === "handEnd" && s.game && s.game.result && !(prev && prev.phase === "handEnd")) {
      const r = s.game.result;
      if (r.winner === myTeam) SFX.win();
      else if (r.winner !== null) SFX.lose();
    }

    // Whole match just finished - bigger fanfare, once, on the transition.
    if (s.phase === "matchEnd" && s.matchResult && !(prev && prev.phase === "matchEnd")) {
      if (s.matchResult.winner === myTeam) SFX.win();
      else SFX.lose();
    }

    if (extra && extra.trumpJustRevealed && s.game && s.game.trumpSuit) {
      showTrumpReveal(s.game.trumpSuit);
    }
  }
}

socket.on("state", (s) => {
  const { trickWon, trumpJustRevealed, roomEnded, matchEnded, ...view } = s;
  applyState(view, { trickWon, trumpJustRevealed, roomEnded, matchEnded });
});

// auto-rejoin after transient disconnects
socket.on("connect", () => {
  if (myCode) {
    try {
      const sess = JSON.parse(localStorage.getItem("mindi_session_" + myCode) || "null");
      if (sess) socket.emit("rejoin", { code: myCode, token: sess.token }, (res) => {
        if (!res.error) applyState(res.state);
      });
    } catch (e) {}
  }
});
socket.on("disconnect", () => {
  if (state) toast("Connection lost - reconnecting…", 4000);
});
