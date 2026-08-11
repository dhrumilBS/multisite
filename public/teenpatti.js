/* Teen Patti client renderer - loaded after client.js, which exposes the
   shared `socket` on window and a handful of reusable globals ($, esc,
   cardHTML, toast, show, doSaveExit, openThemePicker, seatAngle, seatPos,
   renderResumeList) as plain function declarations. */
"use strict";

const TP_CATEGORY_NAMES = ["High Card", "Pair", "Color", "Sequence", "Pure Sequence", "Trail"];
const TP_VARIANT_LABEL = { classic: "Classic", muflis: "Muflis (lowest wins)", ak47: "AK47 (A,K,4,7 wild)", joker: "Joker wild" };
const TP_ACTION_LABEL = {
  see: "Look at cards",
  "blind-chaal": "Chaal (blind)",
  "seen-chaal": "Chaal",
  "blind-raise": "Raise (blind)",
  "seen-raise": "Raise",
  pack: "Pack",
  show: "Show",
  "side-show-request": "Side-show",
};
const TP_ACTION_EVENT = {
  see: "seeCards",
  "blind-chaal": "placeBet",
  "seen-chaal": "placeBet",
  "blind-raise": "raise",
  "seen-raise": "raise",
  pack: "pack",
  show: "show",
  "side-show-request": "requestSideShow",
};

let tpChatOpen = false;
let tpSeenChat = 0;

function tpCardBackHTML() {
  return `<div class="card tp-back"></div>`;
}

function tpDescribeEval(ev) {
  if (!ev) return "";
  const name = TP_CATEGORY_NAMES[ev.category] || "?";
  return ev.isWild ? `${name} (wild)` : name;
}

function tpEmit(eventAction, payload) {
  window.socket.emit("tpAction", { action: eventAction, payload: payload || {} }, (res) => {
    if (res && res.error) toast(res.error);
  });
}

function renderTeenPatti(state, extra) {
  const g = state.game;
  const you = state.you;
  const n = state.config.players;
  const names = state.seats.map((s) => s.name || "?");

  $("tpGameMeta").textContent = `${n}p · ${TP_VARIANT_LABEL[state.config.variant] || state.config.variant} · room ${state.code}`;
  $("tpBPot").textContent = g.pot;
  $("tpBStake").textContent = g.currentStake;
  $("tpBStack").textContent = g.seats[you] ? g.seats[you].stack : 0;
  $("tpPotAmount").textContent = g.pot;

  // seats - same ring layout math as Mindi's table (seatAngle/seatPos from client.js)
  const ring = $("tpSeatsRing");
  ring.innerHTML = "";
  const RX = 45, RY = 41;
  for (let k = 0; k < n; k++) {
    const seat = (you + k) % n;
    const angle = seatAngle(seat, you, n);
    const pos = seatPos(angle, seat === you ? RX * 0.7 : RX, seat === you ? RY * 1.12 : RY);
    const gs = g.seats[seat];
    const identity = state.seats[seat];
    const isTurn = state.phase === "betting" && g.turnSeat === seat && !state.paused;
    const div = document.createElement("div");
    div.className = `seat${isTurn ? " turn" : ""}${seat === you ? " me" : ""}`;

    const statusBits = [];
    if (!gs.active) statusBits.push("out");
    else if (gs.folded) statusBits.push("packed");
    else {
      statusBits.push(gs.isBlind ? "blind" : "seen");
      if (gs.isAllIn) statusBits.push("all-in");
    }

    if (seat === you) {
      div.innerHTML = `<div class="avatar">You${isTurn ? " · your turn" : ""}</div><div class="sub">${gs.stack} chips · ${statusBits.join(", ")}</div>`;
    } else {
      div.innerHTML = `
        <div class="avatar">${esc(names[seat][0] || "?")}</div>
        <div class="nm">${esc(names[seat])}${identity.isBot ? " 🤖" : ""}</div>
        <div class="sub">${gs.stack} chips · ${statusBits.join(", ")}${!identity.connected && !identity.isBot ? ' <span class="offline">offline</span>' : ""}</div>`;
    }
    div.style.left = pos.x + "%";
    div.style.top = pos.y + "%";
    ring.appendChild(div);
  }

  // status line
  let status;
  if (state.paused) status = "Paused - waiting for a player…";
  else if (state.phase === "handEnd") status = "Hand complete";
  else if (g.sideShowRequest && g.sideShowRequest.status === "pending") {
    status =
      g.sideShowRequest.target === you
        ? `${esc(names[g.sideShowRequest.requester])} wants a side-show`
        : `Side-show requested between ${esc(names[g.sideShowRequest.requester])} and ${esc(names[g.sideShowRequest.target])}…`;
  } else if (g.turnSeat === you) status = "Your turn";
  else status = `${esc(names[g.turnSeat])} is thinking…`;
  $("tpStatusLine").textContent = status;

  // your hand
  const myState = g.seats[you];
  const row = $("tpHandRow");
  if (!myState || !myState.hasCards) {
    row.innerHTML = "";
  } else if (myState.isBlind) {
    row.innerHTML = tpCardBackHTML() + tpCardBackHTML() + tpCardBackHTML();
  } else {
    row.innerHTML = myState.cards.map((c) => cardHTML(c)).join("");
  }

  // actions - built straight from the server's legal-action list for this seat
  const actRow = $("tpActionRow");
  actRow.innerHTML = "";
  (g.legal || []).forEach((type) => {
    const btn = document.createElement("button");
    btn.className = type === "pack" ? "dark" : "gold";
    btn.textContent = TP_ACTION_LABEL[type] || type;
    btn.onclick = () => tpEmit(TP_ACTION_EVENT[type] || type);
    actRow.appendChild(btn);
  });

  // side-show response overlay
  const pendingForMe = g.sideShowRequest && g.sideShowRequest.status === "pending" && g.sideShowRequest.target === you;
  $("tpOvSideShow").style.display = pendingForMe ? "flex" : "none";
  if (pendingForMe) {
    $("tpSideShowText").textContent = `${names[g.sideShowRequest.requester]} wants to compare hands. Accepting reveals both hands - the weaker one packs.`;
  }

  // paused overlay
  const humanOffline = state.seats.filter((s) => s.name && !s.isBot && !s.connected);
  $("tpOvPaused").style.display = state.paused ? "flex" : "none";
  if (state.paused) {
    $("tpPausedWho").textContent = humanOffline.length
      ? humanOffline.map((s) => s.name).join(", ") + " disconnected."
      : "A player disconnected.";
    const isHost = state.seats[you].isHost;
    const act = $("tpPausedActions");
    act.innerHTML = "";
    if (isHost) {
      humanOffline.forEach((s) => {
        const b = document.createElement("button");
        b.className = "dark";
        b.style.marginTop = "8px";
        b.textContent = `Hand ${s.name}'s seat to a bot`;
        b.onclick = () => window.socket.emit("addBot", { seat: s.seat }, (r) => r && r.error && toast(r.error));
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

  // hand end
  $("tpOvHandEnd").style.display = state.phase === "handEnd" && g.result ? "flex" : "none";
  if (state.phase === "handEnd" && g.result) {
    const r = g.result;
    const won = (r.winners || []).some((w) => w.seat === you);
    $("tpHeTitle").textContent =
      !r.winners || r.winners.length === 0
        ? "No hand was dealt"
        : won
        ? "You won the pot!"
        : `${esc(names[r.winners[0].seat])} wins the pot`;
    $("tpHeReason").textContent = r.reason || "";
    $("tpHeReveal").innerHTML = (r.showdownReveal || [])
      .map(
        (rv) =>
          `<div class="tp-reveal-item"><div class="nm">${esc(names[rv.seat])} - ${tpDescribeEval(rv.evaluation)}</div>` +
          `<div class="cards">${rv.cards.map((c) => cardHTML(c, "sm")).join("")}</div></div>`
      )
      .join("");
    const isHost = state.seats[you].isHost;
    $("tpBtnNextHand").style.display = isHost ? "block" : "none";
    $("tpBtnEndRoom").style.display = isHost ? "block" : "none";
    $("tpHeWait").style.display = isHost ? "none" : "block";
  }

  renderTpChat(state);
}

function renderTpChat(state) {
  const msgs = state.chat || [];
  const box = $("tpChatMsgs");
  box.innerHTML = msgs.map((m) => `<div class="m"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join("");
  box.scrollTop = box.scrollHeight;
  if (!tpChatOpen && msgs.length > tpSeenChat) $("tpChatDot").style.display = "inline-block";
  if (tpChatOpen) tpSeenChat = msgs.length;
}

// ---------- static wiring ----------
$("tpBtnChat").onclick = () => {
  tpChatOpen = !tpChatOpen;
  $("tpChatPanel").style.display = tpChatOpen ? "flex" : "none";
  if (tpChatOpen) $("tpChatDot").style.display = "none";
};
$("tpBtnCloseChat").onclick = () => {
  tpChatOpen = false;
  $("tpChatPanel").style.display = "none";
};
function tpSendChat() {
  const t = $("tpChatText").value.trim();
  if (!t) return;
  window.socket.emit("chat", { text: t });
  $("tpChatText").value = "";
}
$("tpBtnSendChat").onclick = tpSendChat;
$("tpChatText").addEventListener("keydown", (e) => e.key === "Enter" && tpSendChat());

$("tpBtnTheme").onclick = openThemePicker;
$("tpBtnSaveExit").onclick = doSaveExit;

$("tpBtnSideShowAccept").onclick = () => tpEmit("respondSideShow", { accept: true });
$("tpBtnSideShowDecline").onclick = () => tpEmit("respondSideShow", { accept: false });

$("tpBtnNextHand").onclick = () => tpEmit("nextHand", {});
$("tpBtnEndRoom").onclick = () => {
  if (confirm("End the table for everyone? Chips settle back to each player's wallet.")) {
    window.socket.emit("endRoom", {}, () => {
      show("screen-home");
      renderResumeList();
    });
  }
};

window.renderTeenPatti = renderTeenPatti;
