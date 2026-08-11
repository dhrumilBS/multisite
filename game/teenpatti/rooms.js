// Teen Patti room lifecycle, authoritative betting state machine, and
// per-player views. Generic room-shell concerns (seats, join/approve/reject,
// reconnect tokens, disk persistence) live in ../common/roomShell, same as
// Mindi's ../rooms.js - this module owns everything specific to betting
// rounds: dealing, blind/seen play, chaal/raise/pack, side-show, showdown,
// and settling table chips back to the persistent wallet.
"use strict";

const Shell = require("../common/roomShell");
const Wallet = require("../wallet");
const TP = require("./logic");
const Bot = require("./bot");

Shell.registerGameType("teenpatti", { pausablePhases: ["dealing", "betting", "showdown"] });

const rooms = Shell.rooms;
const VARIANTS = ["classic", "muflis", "ak47", "joker"];

function variantConfig(config) {
  const wild = config.variant === "ak47" ? "ak47" : config.variant === "joker" ? "joker" : "none";
  return { wild, jokerCount: config.jokerCount === 2 ? 2 : 1, muflis: config.variant === "muflis" };
}

// ---------- Room creation / joining ----------
function createRoom(hostName, config, playerId) {
  const players = Shell.clampRange(config.players, 3, 7, 6);
  const variant = Shell.clampChoice(config.variant, VARIANTS, "classic");
  const jokerCount = config.jokerCount === 2 ? 2 : 1;
  const bootAmount = Shell.clampRange(config.bootAmount, 1, 1000, 10);
  const buyIn = Shell.clampRange(config.buyIn, bootAmount * 10, 200000, Math.max(500, bootAmount * 20));
  const speed = Shell.clampChoice(config.speed, ["relaxed", "normal", "fast"], "normal");
  const sideShowAllowed = config.sideShowAllowed !== false;

  if (playerId) {
    const debited = Wallet.debit(playerId, buyIn);
    if (debited.error) return { error: `Buy-in failed: ${debited.error}` };
  }

  const { room, token, seat } = Shell.createRoomShell(hostName, "teenpatti", players, {
    variant,
    jokerCount,
    bootAmount,
    buyIn,
    speed,
    sideShowAllowed,
  });
  room.tableStacks = new Array(players).fill(buyIn);
  room.seats[0].playerId = playerId || null;
  Shell.saveRoom(room);
  return { room, token, seat };
}

function requestJoinRoom(code, name, socketId, playerId) {
  return Shell.requestJoinRoom(code, name, socketId, playerId);
}

function approveJoinRequest(room, reqId) {
  const res = Shell.approveJoinRequest(room, reqId);
  if (res.error) return res;
  const seat = room.seats[res.seat];
  if (seat.playerId) {
    const debited = Wallet.debit(seat.playerId, room.config.buyIn);
    if (debited.error) {
      // Can't afford the buy-in - release the seat back to open.
      room.seats[res.seat] = { name: null, token: null, isBot: false, connected: false };
      Shell.saveRoom(room);
      return { error: "Insufficient chip balance for the buy-in." };
    }
  }
  return res;
}

function loadRoom(code) {
  return Shell.loadRoom(code);
}

// ---------- Seats / bots / disconnects ----------
function botifySeat(room, seat) {
  Shell.botifySeat(room, seat, Shell.BOT_NAMES);
  Shell.maybeResume(room);
  Shell.saveRoom(room);
}

function fillWithBots(room) {
  for (let i = 0; i < room.seats.length; i++) {
    if (!room.seats[i].name) botifySeat(room, i);
  }
}

function maybeResume(room) {
  Shell.maybeResume(room);
}

// A human dropping mid-betting-round auto-packs their seat instead of
// freezing the whole table (unlike Mindi, where any disconnect pauses play) -
// their table chips stay put and they can rejoin before the room is closed.
function markDisconnected(room, seat) {
  if (!room.seats[seat] || room.seats[seat].isBot) return;
  room.seats[seat].connected = false;
  const g = room.game;
  if (room.phase === "betting" && g && g.seats[seat] && g.seats[seat].active && !g.seats[seat].folded) {
    const wasTurn = g.turnSeat === seat;
    const wasSideShowTarget = g.sideShowRequest && g.sideShowRequest.status === "pending" && g.sideShowRequest.target === seat;
    foldSeat(g, seat, "disconnected");
    if (wasSideShowTarget) g.sideShowRequest = null;
    const activeSeats = g.seats.map((s, i) => i).filter((i) => g.seats[i].active && !g.seats[i].folded);
    if (activeSeats.length === 1) {
      endHandUncontested(room, activeSeats[0]);
    } else {
      if (wasTurn || wasSideShowTarget) g.turnSeat = nextActiveSeat(g, seat);
      Shell.saveRoom(room);
    }
    return;
  }
  Shell.setDisconnected(room, seat);
}

// ---------- Turn order helpers ----------
// All-in seats are skipped for turn purposes - they've already committed
// everything they can and have no more decisions to make until showdown.
function nextActiveSeat(g, from) {
  const n = g.seats.length;
  for (let k = 1; k <= n; k++) {
    const idx = (from + k) % n;
    if (g.seats[idx].active && !g.seats[idx].folded && !g.seats[idx].isAllIn) return idx;
  }
  return from;
}

function previousActiveSeat(g, from) {
  const n = g.seats.length;
  for (let k = 1; k <= n; k++) {
    const idx = (from - k + n) % n;
    if (idx !== from && g.seats[idx].active && !g.seats[idx].folded) return idx;
  }
  return null;
}

function foldSeat(g, seat, reason) {
  const s = g.seats[seat];
  s.folded = true;
  s.lastAction = reason;
}

function syncStacks(room) {
  room.game.seats.forEach((s, i) => {
    room.tableStacks[i] = s.stack;
  });
}

// ---------- Dealing ----------
function startFirstHand(room) {
  dealHand(room, Math.floor(Math.random() * room.config.players));
}

function dealHand(room, dealer) {
  const n = room.config.players;
  const variant = variantConfig(room.config);
  const deck = TP.shuffle(TP.buildDeck(variant));
  let idx = 0;
  const seats = [];
  let pot = 0;
  for (let i = 0; i < n; i++) {
    const seated = !!room.seats[i].name;
    const stackBefore = room.tableStacks[i] || 0;
    const active = seated && stackBefore > 0;
    const boot = active ? Math.min(room.config.bootAmount, stackBefore) : 0;
    seats.push({
      stack: stackBefore - boot,
      cards: active ? [deck[idx++], deck[idx++], deck[idx++]] : [],
      isBlind: true,
      folded: !active,
      isAllIn: false,
      contributed: 0,
      lastAction: null,
      active,
    });
    pot += boot;
  }

  room.handSeq = (room.handSeq || 0) + 1;
  room.game = {
    phase: "betting",
    pot,
    currentStake: room.config.bootAmount,
    bootAmount: room.config.bootAmount,
    turnSeat: 0,
    dealer,
    variant,
    seats,
    sideShowRequest: null,
    lastBettor: null,
    revealed: [],
    result: null,
    checksInARow: 0,
  };

  const activeCount = seats.filter((s) => s.active).length;
  if (activeCount < 2) {
    room.game.phase = "handEnd";
    room.phase = "handEnd";
    if (activeCount === 1) {
      const winner = seats.findIndex((s) => s.active);
      seats[winner].stack += pot;
      room.game.result = {
        potAwarded: pot,
        winners: [{ seat: winner, share: pot }],
        perSeat: { [winner]: { contributed: 0, received: pot, netDelta: pot, stackAfter: seats[winner].stack } },
        showdownReveal: [],
        reason: "Only one player has chips left - hand awarded uncontested.",
      };
    } else {
      room.game.result = {
        potAwarded: pot,
        winners: [],
        perSeat: {},
        showdownReveal: [],
        reason: "Not enough players with chips to deal a hand.",
      };
    }
    syncStacks(room);
    Shell.saveRoom(room);
    return;
  }

  room.game.turnSeat = nextActiveSeat(room.game, dealer);
  room.phase = "betting";
  syncStacks(room);
  Shell.saveRoom(room);
}

function nextHand(room, seat) {
  if (!room.seats[seat] || room.seats[seat].token !== room.hostToken) {
    return { error: "Only the host can deal the next hand." };
  }
  if (room.phase !== "handEnd") return { error: "Cannot deal next hand now." };
  dealHand(room, (room.game.dealer + 1) % room.config.players);
  return { ok: true };
}

// ---------- Betting actions ----------
function requireTurn(room, seat) {
  if (!room.game) return { error: "No hand in progress." };
  if (room.phase !== "betting") return { error: "Not in a betting round." };
  if (room.paused) return { error: "Game is paused." };
  const g = room.game;
  if (g.sideShowRequest && g.sideShowRequest.status === "pending") return { error: "A side-show request is pending." };
  if (g.turnSeat !== seat) return { error: "Not your turn." };
  const s = g.seats[seat];
  if (!s.active || s.folded) return { error: "You are not in this hand." };
  return null;
}

function payChips(g, s, amount) {
  const pay = Math.min(amount, s.stack);
  s.stack -= pay;
  s.contributed += pay;
  g.pot += pay;
  if (s.stack === 0) s.isAllIn = true;
  return pay;
}

function afterAction(room, seat) {
  const g = room.game;
  const activeSeats = g.seats.map((s, i) => i).filter((i) => g.seats[i].active && !g.seats[i].folded);
  if (activeSeats.length === 1) {
    endHandUncontested(room, activeSeats[0]);
    return;
  }
  // If everyone left in the hand is all-in, no more betting decisions are
  // possible - go straight to comparing hands instead of hunting for a next
  // turn that can never come (simple-cap all-in handling, no side pots).
  const stillDeciding = activeSeats.filter((i) => !g.seats[i].isAllIn);
  if (stillDeciding.length === 0) {
    resolveShowdown(room, activeSeats);
    return;
  }
  g.turnSeat = nextActiveSeat(g, seat);
  syncStacks(room);
  Shell.saveRoom(room);
}

function seeCards(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  const s = room.game.seats[seat];
  if (!s.isBlind) return { error: "Already seen." };
  s.isBlind = false;
  s.lastAction = "see";
  Shell.saveRoom(room);
  return { ok: true }; // seeing doesn't cost chips or end the turn
}

function placeBet(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  const g = room.game;
  const s = g.seats[seat];
  const paid = payChips(g, s, TP.toCall(s, g.currentStake));
  g.currentStake = TP.nextStakeAfterAction(s, s.contributed, g.currentStake);
  s.lastAction = s.isBlind ? "blind-chaal" : "seen-chaal";
  g.lastBettor = seat;
  // Track consecutive free "checks" (nothing paid) so a betting round that
  // reaches parity can't stall forever - see the anti-stall rule below.
  g.checksInARow = paid > 0 ? 0 : (g.checksInARow || 0) + 1;
  afterAction(room, seat);
  return { ok: true };
}

function raise(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  const g = room.game;
  const s = g.seats[seat];
  const cost = TP.toCall(s, g.currentStake) + TP.liveStakeFor(s, g.currentStake);
  payChips(g, s, cost);
  g.currentStake = TP.nextStakeAfterAction(s, s.contributed, g.currentStake);
  s.lastAction = s.isBlind ? "blind-raise" : "seen-raise";
  g.lastBettor = seat;
  g.checksInARow = 0;
  afterAction(room, seat);
  return { ok: true };
}

function pack(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  foldSeat(room.game, seat, "pack");
  room.game.checksInARow = 0;
  afterAction(room, seat);
  return { ok: true };
}

function show(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  const g = room.game;
  const activeSeats = g.seats.map((s, i) => i).filter((i) => g.seats[i].active && !g.seats[i].folded);
  if (activeSeats.length !== 2) return { error: "Show is only available with two players left." };
  const s = g.seats[seat];
  payChips(g, s, TP.toCall(s, g.currentStake));
  s.lastAction = "show";
  g.checksInARow = 0;
  resolveShowdown(room, activeSeats);
  return { ok: true };
}

function requestSideShow(room, seat) {
  const err = requireTurn(room, seat);
  if (err) return err;
  if (!room.config.sideShowAllowed) return { error: "Side-show is disabled for this table." };
  const g = room.game;
  const s = g.seats[seat];
  if (s.isBlind) return { error: "You must see your cards before requesting a side-show." };
  const activeSeats = g.seats.filter((x) => x.active && !x.folded).length;
  if (activeSeats <= 2) return { error: "Side-show needs at least three players still in - use show instead." };
  const target = previousActiveSeat(g, seat);
  if (target == null || g.seats[target].isBlind) return { error: "No eligible side-show target." };
  const cost = TP.toCall(s, g.currentStake);
  payChips(g, s, cost);
  g.currentStake = TP.nextStakeAfterAction(s, s.contributed, g.currentStake);
  s.lastAction = "side-show-request";
  g.sideShowRequest = { requester: seat, target, cost, status: "pending" };
  g.checksInARow = 0;
  Shell.saveRoom(room);
  return { ok: true }; // turn holds here until the target responds
}

function respondSideShow(room, seat, payload) {
  const g = room.game;
  const req = g.sideShowRequest;
  if (!req || req.status !== "pending") return { error: "No pending side-show request." };
  if (req.target !== seat) return { error: "This side-show request isn't for you." };
  const accept = !!(payload && payload.accept);
  g.checksInARow = 0;

  if (!accept) {
    req.status = "declined";
    g.sideShowRequest = null;
    afterAction(room, req.requester);
    return { ok: true };
  }

  req.status = "accepted";
  const a = TP.evaluateHand(g.seats[req.requester].cards, g.variant);
  const b = TP.evaluateHand(g.seats[req.target].cards, g.variant);
  const cmp = TP.compareHands(a, b, g.variant);
  const loser = cmp > 0 ? req.target : req.requester; // exact tie -> requester loses
  g.revealed.push(
    { seat: req.requester, cards: g.seats[req.requester].cards, evaluation: a },
    { seat: req.target, cards: g.seats[req.target].cards, evaluation: b }
  );
  foldSeat(g, loser, "side-show-lost");
  g.sideShowRequest = null;
  afterAction(room, req.requester);
  return { ok: true };
}

function endHandUncontested(room, winnerSeat) {
  const g = room.game;
  g.seats[winnerSeat].stack += g.pot;
  const perSeat = {};
  g.seats.forEach((s, i) => {
    if (s.active) {
      perSeat[i] = {
        contributed: s.contributed,
        received: i === winnerSeat ? g.pot : 0,
        netDelta: (i === winnerSeat ? g.pot : 0) - s.contributed,
        stackAfter: s.stack,
      };
    }
  });
  g.result = {
    potAwarded: g.pot,
    winners: [{ seat: winnerSeat, share: g.pot }],
    perSeat,
    showdownReveal: g.revealed,
    reason: "All others packed.",
  };
  g.phase = "handEnd";
  room.phase = "handEnd";
  syncStacks(room);
  Shell.saveRoom(room);
}

function resolveShowdown(room, seatIds) {
  const g = room.game;
  const evals = seatIds.map((i) => ({ seat: i, evaluated: TP.evaluateHand(g.seats[i].cards, g.variant) }));
  let winners = [evals[0]];
  for (let i = 1; i < evals.length; i++) {
    const cmp = TP.compareHands(evals[i].evaluated, winners[0].evaluated, g.variant);
    if (cmp > 0) winners = [evals[i]];
    else if (cmp === 0) winners.push(evals[i]);
  }
  const share = Math.floor(g.pot / winners.length);
  const remainder = g.pot - share * winners.length;

  const perSeat = {};
  g.seats.forEach((s, i) => {
    if (s.active) perSeat[i] = { contributed: s.contributed, received: 0, netDelta: 0, stackAfter: s.stack };
  });
  winners.forEach((w, idx) => {
    const amt = share + (idx === 0 ? remainder : 0);
    g.seats[w.seat].stack += amt;
    perSeat[w.seat].received = amt;
  });
  Object.keys(perSeat).forEach((k) => {
    perSeat[k].netDelta = perSeat[k].received - perSeat[k].contributed;
    perSeat[k].stackAfter = g.seats[k].stack;
  });

  evals.forEach((e) => g.revealed.push({ seat: e.seat, cards: g.seats[e.seat].cards, evaluation: e.evaluated }));

  const winnerNames = winners.map((w) => TP.describeHand(w.evaluated)).join(" & ");
  const loserEval = evals.find((e) => !winners.some((w) => w.seat === e.seat));
  const reason =
    winners.length > 1
      ? `Split pot - tied on ${winnerNames}`
      : `${TP.describeHand(winners[0].evaluated)} beats ${TP.describeHand(loserEval.evaluated)}`;

  g.result = {
    potAwarded: g.pot,
    winners: winners.map((w, idx) => ({ seat: w.seat, share: share + (idx === 0 ? remainder : 0) })),
    perSeat,
    showdownReveal: g.revealed,
    reason,
  };
  g.phase = "handEnd";
  room.phase = "handEnd";
  syncStacks(room);
  Shell.saveRoom(room);
}

// ---------- Legal actions / bot turn driver ----------
function legalActionsFor(room, seat) {
  if (!room.game || room.phase !== "betting" || room.paused) return [];
  const g = room.game;
  if (g.sideShowRequest && g.sideShowRequest.status === "pending") return [];
  if (g.turnSeat !== seat) return [];
  const s = g.seats[seat];
  if (!s.active || s.folded) return [];

  const activeCount = g.seats.filter((x) => x.active && !x.folded).length;
  const acts = [];
  if (s.isBlind) {
    acts.push("see", "blind-chaal", "blind-raise", "pack");
  } else {
    acts.push("seen-chaal", "seen-raise", "pack");
    if (activeCount === 2) acts.push("show");
    if (room.config.sideShowAllowed && activeCount > 2) {
      const target = previousActiveSeat(g, seat);
      if (target != null && !g.seats[target].isBlind) acts.push("side-show-request");
    }
  }

  // Anti-stall: once every active seat has had a free "check" at the current
  // stake with nothing changing, a plain chaal/call is no longer offered -
  // forces a raise/show/side-show/pack instead of an unbounded check-around
  // loop (a bet that's already at parity costs nothing to keep matching).
  if ((g.checksInARow || 0) >= activeCount && acts.length > 1) {
    const chaalType = s.isBlind ? "blind-chaal" : "seen-chaal";
    const idx = acts.indexOf(chaalType);
    if (idx !== -1) acts.splice(idx, 1);
  }
  return acts;
}

const actions = {
  seeCards: (room, seat) => seeCards(room, seat),
  placeBet: (room, seat) => placeBet(room, seat),
  raise: (room, seat) => raise(room, seat),
  pack: (room, seat) => pack(room, seat),
  show: (room, seat) => show(room, seat),
  requestSideShow: (room, seat) => requestSideShow(room, seat),
  respondSideShow: (room, seat, payload) => respondSideShow(room, seat, payload),
  nextHand: (room, seat) => nextHand(room, seat),
};

function applyBotDecision(room, seat, decision) {
  switch (decision.type) {
    case "see":
      return seeCards(room, seat);
    case "blind-chaal":
    case "seen-chaal":
      return placeBet(room, seat);
    case "blind-raise":
    case "seen-raise":
      return raise(room, seat);
    case "show":
      return show(room, seat);
    case "side-show-request":
      return requestSideShow(room, seat);
    default:
      return pack(room, seat);
  }
}

function runBotTurn(room, seat) {
  const legal = legalActionsFor(room, seat);
  if (!legal.length) return;
  const decision = Bot.botDecideAction(seat, room.game, room.config, legal);
  const res = applyBotDecision(room, seat, decision);
  if (decision.type === "see" && res && res.ok && room.game && room.phase === "betting" && room.game.turnSeat === seat) {
    runBotTurn(room, seat); // seeing doesn't end the turn - immediately decide the follow-up action
  }
}

// Synchronous single-step driver used by bot-vs-bot self-play tests (no
// timers involved) - resolves whatever is currently blocking the betting
// round: a pending side-show response, or the seat-to-act's turn. Returns
// false if there's nothing to drive right now.
function driveOneStep(room) {
  if (!room.game || room.phase !== "betting") return false;
  const g = room.game;
  if (g.sideShowRequest && g.sideShowRequest.status === "pending") {
    const accept = Bot.decideSideShowResponse(g.sideShowRequest.target, g);
    respondSideShow(room, g.sideShowRequest.target, { accept });
    return true;
  }
  runBotTurn(room, g.turnSeat);
  return true;
}

const SPEEDS = { relaxed: 1600, normal: 1000, fast: 550 };
function speedOf(room) {
  return SPEEDS[room.config.speed] || SPEEDS.normal;
}

function pump(room, ctx) {
  ctx.clearTimer();
  if (!room.game || room.paused) {
    ctx.broadcast();
    return;
  }
  if (room.phase !== "betting") {
    ctx.broadcast();
    return; // handEnd waits on the host's "next hand"; dealing/showdown are instantaneous
  }

  const g = room.game;
  if (g.sideShowRequest && g.sideShowRequest.status === "pending") {
    const target = room.seats[g.sideShowRequest.target];
    if (target && target.isBot) {
      ctx.setTimer(() => {
        if (room.paused || !room.game || !room.game.sideShowRequest) return;
        const accept = Bot.decideSideShowResponse(room.game.sideShowRequest.target, room.game);
        respondSideShow(room, room.game.sideShowRequest.target, { accept });
        pump(room, ctx);
      }, speedOf(room));
    }
    ctx.broadcast();
    return;
  }

  const seat = g.turnSeat;
  const seatInfo = room.seats[seat];
  if (seatInfo && seatInfo.isBot) {
    ctx.setTimer(() => {
      if (room.paused || room.phase !== "betting") return;
      runBotTurn(room, seat);
      pump(room, ctx);
    }, speedOf(room));
  }
  ctx.broadcast();
}

// ---------- Settlement ----------
// Called when the host closes the table: cash every human seat's current
// table stack back out against their buy-in, in one atomic wallet write.
// Table chips otherwise stay at the table across hands and disconnects -
// they're only settled to the wallet when the room actually ends.
function settleAndClose(room) {
  const deltas = {};
  room.seats.forEach((seat, i) => {
    if (seat.playerId) {
      const finalStack = room.tableStacks[i] || 0;
      deltas[seat.playerId] = (deltas[seat.playerId] || 0) + (finalStack - room.config.buyIn);
    }
  });
  if (Object.keys(deltas).length) Wallet.settle(deltas);
}

// ---------- Per-player redacted view ----------
function viewFor(room, seat) {
  const seats = room.seats.map((s, i) => ({
    name: s.name,
    isBot: s.isBot,
    connected: s.isBot ? true : s.connected,
    seat: i,
    isHost: s.token && s.token === room.hostToken,
  }));
  const isHostSeat = !!(room.seats[seat] && room.seats[seat].token && room.seats[seat].token === room.hostToken);
  const base = {
    code: room.code,
    config: room.config,
    phase: room.phase,
    paused: room.paused,
    seats,
    you: seat,
    tableStacks: room.tableStacks,
    handSeq: room.handSeq || 0,
    pendingJoins: isHostSeat
      ? room.pendingJoins.map((p) => ({ reqId: p.reqId, name: p.name, requestedAt: p.requestedAt }))
      : [],
    chat: room.chat.slice(-50),
  };
  const g = room.game;
  if (!g) return base;

  const revealedSeats = new Set(g.revealed.map((r) => r.seat));
  const gameSeats = g.seats.map((s, i) => ({
    stack: s.stack,
    contributed: s.contributed,
    isBlind: s.isBlind,
    folded: s.folded,
    isAllIn: s.isAllIn,
    active: s.active,
    lastAction: s.lastAction,
    hasCards: s.cards.length > 0,
    cards: i === seat || revealedSeats.has(i) ? s.cards : null,
  }));

  return {
    ...base,
    game: {
      phase: g.phase,
      pot: g.pot,
      currentStake: g.currentStake,
      bootAmount: g.bootAmount,
      turnSeat: g.turnSeat,
      dealer: g.dealer,
      variant: g.variant,
      seats: gameSeats,
      sideShowRequest: g.sideShowRequest,
      result: g.result,
      legal: legalActionsFor(room, seat),
    },
  };
}

module.exports = {
  rooms,
  createRoom,
  requestJoinRoom,
  approveJoinRequest,
  rejectJoinRequest: Shell.rejectJoinRequest,
  rejoinRoom: Shell.rejoinRoom,
  loadRoom,
  deleteRoom: Shell.deleteRoom,
  listSavedRooms: Shell.listSavedRooms,
  saveRoom: Shell.saveRoom,
  markDisconnected,
  maybeResume,
  botifySeat,
  fillWithBots,
  startFirstHand,
  nextHand,
  legalActionsFor,
  actions,
  pump,
  driveOneStep,
  settleAndClose,
  viewFor,
};
