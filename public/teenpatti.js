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
let tpRaiseAmount = null; // player-selected raise cost, clamped to g.raiseBounds each render
let tpRaiseTurnKey = null; // resets tpRaiseAmount back to the minimum whenever a new turn starts
let tpCoinRequestSent = false; // guards against spamming "ask host" while a request is already in flight
let tpCoinRequests = []; // host-side queue: [{seat, name}], de-duplicated by seat
let tpLastState = null; // so the coin-request panel's own buttons can re-render after acting

// Every "state" push triggers a full re-render (no diffing anywhere in this
// app) - that's fine for the felt/pot text, but rebuilding the seat ring and
// action buttons from scratch on every push (including ones that don't touch
// either) is what reads as "flicker" after an action: the buttons blink out
// and back in even when the legal-action list didn't change. These signature
// caches let the ring/action-row DOM stay untouched when the data driving
// them is identical to last render.
let tpLastRingSig = null;
let tpLastPot = null;
let tpAnimatedHandSeq = null; // last handSeq the win animation has already played for
let tpLastHandSig = null; // skips rebuilding your own card row when it hasn't actually changed
let tpLastActionSig = null; // skips rebuilding the action button row when it hasn't actually changed
let tpLastExtra = null; // mirrors tpLastState so cached-DOM click handlers always re-render with the latest push

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
  tpLastState = state;
  tpLastExtra = extra;
  const g = state.game;
  const you = state.you;
  const n = state.config.players;
  const names = state.seats.map((s) => s.name || "?");

  $("tpGameMeta").textContent = `${n}p · ${TP_VARIANT_LABEL[state.config.variant] || state.config.variant} · room ${state.code}`;
  $("tpBPot").textContent = g.pot;
  $("tpBStake").textContent = g.currentStake;
  $("tpBStack").textContent = g.seats[you] ? g.seats[you].stack : 0;
  const potEl = $("tpPotAmount");
  potEl.textContent = g.pot;
  // A little "bump" whenever the pot actually grows (a bet landed) - cheap
  // visual feedback for a bet at the table itself, not tied to the seat ring.
  if (tpLastPot !== null && g.pot > tpLastPot) {
    potEl.classList.remove("bump");
    void potEl.offsetWidth; // restart the animation even if it's still playing
    potEl.classList.add("bump");
  }
  tpLastPot = g.pot;

  // hand-end context, needed by both the seat ring (reveal/win-flash) and
  // the status line/animation below
  const handEndActive = state.phase === "handEnd" && !!g.result;
  const revealMap = {};
  if (handEndActive && g.result.showdownReveal) g.result.showdownReveal.forEach((rv) => (revealMap[rv.seat] = rv));
  const winnerSeats = handEndActive && g.result.winners ? g.result.winners.map((w) => w.seat) : [];

  // seats - same ring layout math as Mindi's table (seatAngle/seatPos from client.js)
  const ring = $("tpSeatsRing");
  const RX = 45, RY = 41;
  // Chip leader - the seated player currently holding the most chips at the
  // table. Only meaningful with 2+ seated players, otherwise everyone would
  // trivially "lead".
  const seatedStacks = [];
  for (let i = 0; i < n; i++) {
    if (state.seats[i] && state.seats[i].name) seatedStacks.push(g.seats[i].stack);
  }
  const maxStack = seatedStacks.length > 1 ? Math.max(...seatedStacks) : -1;
  const lastWinners = state.lastHandWinners || [];
  const posBySeat = {};
  const seatEntries = [];
  for (let k = 0; k < n; k++) {
    const seat = (you + k) % n;
    const angle = seatAngle(seat, you, n);
    const pos = seatPos(angle, seat === you ? RX * 0.7 : RX, seat === you ? RY * 1.12 : RY);
    posBySeat[seat] = pos;
    const gs = g.seats[seat];
    const identity = state.seats[seat];
    const isTurn = state.phase === "betting" && g.turnSeat === seat && !state.paused;
    const isLastWinner = lastWinners.includes(seat);
    const isChipLeader = maxStack > 0 && gs.stack === maxStack;
    const isWinFlash = winnerSeats.includes(seat);
    const reveal = revealMap[seat];

    const statusBits = [];
    if (!gs.active) statusBits.push("out");
    else if (gs.folded) statusBits.push("packed");
    else {
      statusBits.push(gs.isBlind ? "blind" : "seen");
      if (gs.isAllIn) statusBits.push("all-in");
    }

    const classes = [
      "seat",
      isTurn && "turn",
      seat === you && "me",
      isLastWinner && "last-winner",
      isChipLeader && "chip-leader",
      gs.folded && "folded",
      gs.isAllIn && "all-in",
      isWinFlash && "win-flash",
    ]
      .filter(Boolean)
      .join(" ");

    const badges =
      (isLastWinner ? '<span class="seat-badge win-badge" title="Won the last hand">&#127942;</span>' : "") +
      (isChipLeader ? '<span class="seat-badge chip-badge" title="Chip leader">&#128176;</span>' : "");

    // Live wager for the current betting round - shown instead of only the
    // total stack, so a raise/chaal is visible at the seat itself.
    const betBadge =
      state.phase === "betting" && gs.active && !gs.folded && gs.contributed > 0
        ? `<div class="seat-bet">${gs.contributed}</div>`
        : "";

    // Showdown reveal - a small face-up fan above the seat instead of a
    // modal listing every hand. Only seats the server actually revealed
    // (real showdown participants) ever get cards here.
    const miniCards = reveal
      ? `<div class="tp-mini-cards" title="${esc(tpDescribeEval(reveal.evaluation))}">${reveal.cards
          .map((c) => cardHTML(c, "xs"))
          .join("")}</div>`
      : "";

    const inner =
      seat === you
        ? `${miniCards}<div class="avatar">You${isTurn ? " · your turn" : ""}</div>${badges}<div class="sub">${gs.stack} chips · ${statusBits.join(", ")}</div>${betBadge}`
        : `${miniCards}<div class="avatar">${esc(names[seat][0] || "?")}</div>${badges}
        <div class="nm">${esc(names[seat])}${identity.isBot ? " 🤖" : ""}</div>
        <div class="sub">${gs.stack} chips · ${statusBits.join(", ")}${!identity.connected && !identity.isBot ? ' <span class="offline">offline</span>' : ""}</div>${betBadge}`;

    seatEntries.push({ seat, classes, inner, pos, avatar: identity.avatar });
  }

  const ringSig = JSON.stringify({
    you,
    n,
    entries: seatEntries.map((e) => ({ c: e.classes, i: e.inner, x: e.pos.x, y: e.pos.y, a: e.avatar })),
  });
  if (ringSig !== tpLastRingSig) {
    tpLastRingSig = ringSig;
    ring.innerHTML = "";
    seatEntries.forEach((e) => {
      const div = document.createElement("div");
      div.className = e.classes;
      div.innerHTML = e.inner;
      div.style.left = e.pos.x + "%";
      div.style.top = e.pos.y + "%";
      ring.appendChild(div);
      if (e.seat !== you) setSeatAvatar(div, e.avatar);
    });
  }

  // Win animation - chips fly from the pot to the winning seat(s), once per
  // hand (guarded by handSeq so it doesn't replay on unrelated re-renders
  // like an incoming chat message while everyone waits for "Next hand").
  if (handEndActive && winnerSeats.length && tpAnimatedHandSeq !== state.handSeq) {
    tpAnimatedHandSeq = state.handSeq;
    tpPlayWinAnimation(winnerSeats.map((s) => posBySeat[s]).filter(Boolean));
  }

  // status line - hand-end result is announced here instead of a popup
  let status;
  if (state.paused) status = "Paused - waiting for a player…";
  else if (handEndActive) {
    const r = g.result;
    if (!r.winners || r.winners.length === 0) status = "No hand was dealt";
    else {
      const won = r.winners.some((w) => w.seat === you);
      const title = won ? "You won the pot!" : `${esc(names[r.winners[0].seat])} wins the pot`;
      status = r.reason ? `${title} — ${r.reason}` : title;
    }
  } else if (g.sideShowRequest && g.sideShowRequest.status === "pending") {
    status =
      g.sideShowRequest.target === you
        ? `${esc(names[g.sideShowRequest.requester])} wants a side-show`
        : `Side-show requested between ${esc(names[g.sideShowRequest.requester])} and ${esc(names[g.sideShowRequest.target])}…`;
  } else if (g.turnSeat === you) status = "Your turn";
  else status = `${esc(names[g.turnSeat])} is thinking…`;
  $("tpStatusLine").textContent = status;
  $("tpStatusLine").classList.toggle("win", handEndActive && winnerSeats.length > 0);

  // your hand - only touch the DOM when blind/seen state or the actual cards
  // change. Without this, every state push (including ones triggered by
  // other seats acting) tears your own card row down and rebuilds it, which
  // is what reads as flicker right after you take your own turn.
  const myState = g.seats[you];
  const row = $("tpHandRow");
  const handSig =
    !myState || !myState.hasCards ? "none" : myState.isBlind ? "blind" : "seen:" + myState.cards.map((c) => c.id).join(",");
  if (handSig !== tpLastHandSig) {
    tpLastHandSig = handSig;
    if (!myState || !myState.hasCards) {
      row.innerHTML = "";
    } else if (myState.isBlind) {
      row.innerHTML = tpCardBackHTML() + tpCardBackHTML() + tpCardBackHTML();
    } else {
      row.innerHTML = myState.cards.map((c) => cardHTML(c)).join("");
    }
    applyHandFan(row);
  }

  // actions - built straight from the server's legal-action list for this seat
  const actRow = $("tpActionRow");
  const raiseType = (g.legal || []).find((t) => t === "blind-raise" || t === "seen-raise");

  if (raiseType && g.raiseBounds) {
    const turnKey = `${state.code}-${state.handSeq}-${g.turnSeat}`;
    if (tpRaiseTurnKey !== turnKey) {
      tpRaiseTurnKey = turnKey;
      tpRaiseAmount = g.raiseBounds.min;
    }
    tpRaiseAmount = Math.min(g.raiseBounds.max, Math.max(g.raiseBounds.min, tpRaiseAmount));
  }

  // Skip rebuilding the button row unless what it actually depends on
  // changed. Without this, every incoming state push - including ones from
  // other seats acting, or unrelated chat/timer pushes - tears the buttons
  // down and rebuilds them from scratch, which is what reads as a flicker
  // right after you take your own action.
  const actionSig = JSON.stringify({
    legal: g.legal || [],
    raiseType,
    raiseAmount: tpRaiseAmount,
    bounds: g.raiseBounds || null,
  });
  if (actionSig !== tpLastActionSig) {
    tpLastActionSig = actionSig;
    actRow.innerHTML = "";

    // Raise +/- stepper - lets the player dial in a raise between the
    // server's minimum legal raise and its cap of 2x that minimum, rather
    // than always raising by the fixed minimum amount.
    if (raiseType && g.raiseBounds) {
      const canStep = g.raiseBounds.max > g.raiseBounds.min;
      const stepper = document.createElement("div");
      stepper.className = "tp-raise-stepper";
      stepper.innerHTML =
        `<button type="button" class="tiny raise-step-minus"${canStep ? "" : " disabled"}>&minus;</button>` +
        `<span class="raise-amount">${tpRaiseAmount}</span>` +
        `<button type="button" class="tiny raise-step-plus"${canStep ? "" : " disabled"}>+</button>`;
      // No partial creeping - "-" drops straight back to the minimum legal
      // raise, "+" jumps straight to the maximum (which is exactly double
      // the minimum, per raiseCostBounds() server-side). Re-render off
      // tpLastState/tpLastExtra (not the closured state/extra) so this
      // handler still targets the latest push even if this DOM was cached
      // from an earlier render.
      stepper.querySelector(".raise-step-minus").onclick = () => {
        tpRaiseAmount = g.raiseBounds.min;
        renderTeenPatti(tpLastState, tpLastExtra);
      };
      stepper.querySelector(".raise-step-plus").onclick = () => {
        tpRaiseAmount = g.raiseBounds.max;
        renderTeenPatti(tpLastState, tpLastExtra);
      };
      actRow.appendChild(stepper);
    }

    (g.legal || []).forEach((type) => {
      const btn = document.createElement("button");
      btn.className = (type === "pack" ? "dark" : "gold") + ` tp-act-${type}`;
      btn.textContent = type === raiseType ? `${TP_ACTION_LABEL[type]} to ${tpRaiseAmount}` : TP_ACTION_LABEL[type] || type;
      btn.onclick = () => tpEmit(TP_ACTION_EVENT[type] || type, type === raiseType ? { amount: tpRaiseAmount } : undefined);
      actRow.appendChild(btn);
    });
  }

  // out-of-coins banner - independent of whose turn it is, since running out
  // isn't a turn action. tableStacks (not the current hand's live stack) is
  // the authoritative "chips available" figure across hands.
  const outBox = $("tpOutOfCoins");
  const myStackNow = (state.tableStacks && state.tableStacks[you]) || 0;
  if (myStackNow <= 0 && !tpCoinRequestSent) {
    outBox.style.display = "flex";
    outBox.innerHTML = `<span>You're out of coins.</span>`;
    const btn = document.createElement("button");
    btn.className = "tiny";
    btn.textContent = "Ask host for more";
    btn.onclick = () => {
      window.socket.emit("tpRequestCoins", {}, (res) => {
        if (res && res.error) return toast(res.error);
        tpCoinRequestSent = true;
        toast("Request sent to the host.");
        renderTeenPatti(state, extra);
      });
    };
    outBox.appendChild(btn);
  } else if (myStackNow > 0) {
    tpCoinRequestSent = false;
    outBox.style.display = "none";
  } else {
    outBox.style.display = "none";
  }

  // host-side: pending "please add coins" requests from other players
  renderTpCoinRequests(state);

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

  // hand end - no modal: the winner/reveal already played out on the table
  // above (status line + mini-cards + chip-fly), so the sticky bottom bar
  // just swaps from legal-action buttons to Next hand/End room.
  $("tpActionRow").style.display = handEndActive ? "none" : "flex";
  $("tpHandEndBar").style.display = handEndActive ? "flex" : "none";
  if (handEndActive) {
    const isHost = state.seats[you].isHost;
    $("tpBtnNextHand").style.display = isHost ? "" : "none";
    $("tpBtnEndRoom").style.display = isHost ? "" : "none";
    $("tpHeWait").style.display = isHost ? "none" : "inline-block";
  }

  renderTpChat(state);
}

// Chips fly from the pot's fixed screen position (see .tp-pot-center in
// style.css) to each winning seat's position - a set-then-move trick: the
// chip is placed at the pot first, then given its destination a tick later
// so the CSS `transition: left/top` on .tp-chip-fly actually animates it.
function tpPlayWinAnimation(targetPositions) {
  const fx = $("tpChipFx");
  if (!fx || !targetPositions.length) return;
  const potPos = { x: 50, y: 42 };
  targetPositions.forEach((toPos, wi) => {
    for (let i = 0; i < 6; i++) {
      const chip = document.createElement("div");
      chip.className = "tp-chip-fly";
      chip.style.left = potPos.x + "%";
      chip.style.top = potPos.y + "%";
      chip.style.opacity = "1";
      fx.appendChild(chip);
      const jitterX = (Math.random() * 8 - 4);
      const jitterY = (Math.random() * 8 - 4);
      const delay = wi * 60 + i * 45;
      setTimeout(() => {
        chip.style.left = toPos.x + jitterX + "%";
        chip.style.top = toPos.y + jitterY + "%";
        chip.style.opacity = "0";
      }, delay);
      setTimeout(() => chip.remove(), delay + 850);
    }
  });
}

function renderTpCoinRequests(state) {
  const box = $("tpCoinRequests");
  const isHost = state.seats[state.you] && state.seats[state.you].isHost;
  // A request only makes sense while its seat is still actually broke -
  // drop it silently if someone else already topped them up.
  tpCoinRequests = tpCoinRequests.filter((r) => ((state.tableStacks && state.tableStacks[r.seat]) || 0) <= 0);
  if (!isHost || !tpCoinRequests.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "flex";
  box.innerHTML = "";
  tpCoinRequests.forEach((req) => {
    const row = document.createElement("div");
    row.className = "tp-coin-request-item";
    row.innerHTML =
      `<span class="txt-name">${esc(req.name)} is out of coins</span>` +
      `<input type="number" min="1" step="1" value="${state.config.buyIn || 500}" />` +
      `<button class="tiny accept">Add</button>` +
      `<button class="tiny reject">Dismiss</button>`;
    const input = row.querySelector("input");
    row.querySelector(".accept").onclick = () => {
      const amount = Math.floor(Number(input.value));
      if (!amount || amount <= 0) return toast("Enter a valid amount.");
      tpEmit("addCoins", { targetSeat: req.seat, amount });
      tpCoinRequests = tpCoinRequests.filter((r) => r.seat !== req.seat);
      if (tpLastState) renderTpCoinRequests(tpLastState);
    };
    row.querySelector(".reject").onclick = () => {
      tpCoinRequests = tpCoinRequests.filter((r) => r.seat !== req.seat);
      if (tpLastState) renderTpCoinRequests(tpLastState);
    };
    box.appendChild(row);
  });
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
$("tpBtnExitGame").onclick = doSaveExit;

// Host-only: relayed from server.js when some other seat hits 0 chips and
// asks for a top-up. Queued client-side only - not part of persisted room
// state, since it's a transient notification, not game state.
window.socket.on("tpCoinRequest", ({ seat, name }) => {
  if (!tpCoinRequests.some((r) => r.seat === seat)) tpCoinRequests.push({ seat, name });
  if (tpLastState) renderTpCoinRequests(tpLastState);
});

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
