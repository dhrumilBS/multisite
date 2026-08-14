// Mindi room lifecycle, authoritative game state, and per-player views.
// Generic room-shell concerns (seats, join/approve/reject, reconnect tokens,
// disk persistence) live in ./common/roomShell and are re-exported here
// unchanged so existing callers (server.js, test/*.js) keep working exactly
// as before.
"use strict";

const Shell = require("./common/roomShell");
const Profiles = require("./profiles");
const {
  buildDeck,
  shuffle,
  sortHand,
  isTen,
  trickWinner,
  legalCards,
  computeResult,
  matchWinTarget,
} = require("./logic");
const { botChooseTrump } = require("./bot");

Shell.registerGameType("mindi", { pausablePhases: ["playing", "trumpSelect"] });

const rooms = Shell.rooms;

// ---------- Room creation / joining ----------
function createRoom(hostName, config, playerId) {
  const players = Shell.clampChoice(config.players, [4, 6, 8], 4);
  const decks = Shell.clampChoice(config.decks, [3, 4, 5], 3);
  const trumpMode = Shell.clampChoice(config.trumpMode, ["cut", "hidden", "random", "none"], "cut");
  const speed = Shell.clampChoice(config.speed, ["relaxed", "normal", "fast"], "normal");
  const { room, token, seat } = Shell.createRoomShell(hostName, "mindi", players, { decks, trumpMode, speed }, playerId);
  room.matchScore = { 0: 0, 1: 0 };
  room.matchResult = null;
  Shell.saveRoom(room);
  return { room, token, seat };
}

function loadRoom(code) {
  const room = Shell.loadRoom(code);
  if (room && room.matchResult === undefined) room.matchResult = null;
  return room;
}

function markDisconnected(room, seat) {
  Shell.setDisconnected(room, seat);
}

function maybeResume(room) {
  Shell.maybeResume(room);
}

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

// ---------- Game flow ----------
function startHand(room, dealer, carryScore) {
  const cfg = room.config;
  const deck = shuffle(buildDeck(cfg.decks, cfg.players));
  const per = deck.length / cfg.players;
  const hands = [];
  for (let i = 0; i < cfg.players; i++) {
    hands.push(sortHand(deck.slice(i * per, (i + 1) * per)));
  }
  const leadSeat = (dealer + 1) % cfg.players;
  let trumpSuit = null;
  let trumpRevealed = false;
  let phase = "playing";
  const chooser = cfg.trumpMode === "hidden" ? leadSeat : null;

  if (cfg.trumpMode === "random") {
    trumpSuit = ["S", "H", "D", "C"][Math.floor(Math.random() * 4)];
    trumpRevealed = true;
  } else if (cfg.trumpMode === "hidden") {
    if (room.seats[chooser].isBot) {
      trumpSuit = botChooseTrump(hands[chooser]);
    } else {
      phase = "trumpSelect";
    }
  }

  if (!carryScore) room.matchScore = { 0: 0, 1: 0 };
  room.handSeq = (room.handSeq || 0) + 1;
  room.game = {
    hands,
    trick: [],
    leadSeat,
    turnSeat: leadSeat,
    trumpSuit,
    trumpRevealed,
    captured: { 0: { tens: [], tricks: 0 }, 1: { tens: [], tricks: 0 } },
    dealer,
    lastTrick: null,
    totalTens: 4 * cfg.decks,
    result: null,
    cutBy: null,
    chooser,
  };
  room.phase = phase;
  Shell.saveRoom(room);
}

function chooseTrump(room, seat, suit) {
  if (room.phase !== "trumpSelect") return { error: "Not choosing trump right now." };
  if (room.game.chooser !== seat) return { error: "You are not the trump chooser." };
  if (!["S", "H", "D", "C"].includes(suit)) return { error: "Invalid suit." };
  room.game.trumpSuit = suit;
  room.phase = "playing";
  Shell.saveRoom(room);
  return { ok: true };
}

// Reveal hidden trump if the player to act cannot follow suit
function checkTrumpReveal(room) {
  const g = room.game;
  if (
    room.config.trumpMode === "hidden" &&
    g.trumpSuit &&
    !g.trumpRevealed &&
    g.trick.length > 0
  ) {
    const hand = g.hands[g.turnSeat];
    const leadSuit = g.trick[0].card.suit;
    if (!hand.some((c) => c.suit === leadSuit)) {
      g.trumpRevealed = true;
      Shell.saveRoom(room);
      return true;
    }
  }
  return false;
}

function playCard(room, seat, cardId) {
  const g = room.game;
  if (room.phase !== "playing") return { error: "Not in play." };
  if (room.paused) return { error: "Game is paused." };
  if (g.turnSeat !== seat) return { error: "Not your turn." };
  if (g.trick.length >= room.config.players) return { error: "Trick resolving." };
  const hand = g.hands[seat];
  const card = hand.find((c) => c.id === cardId);
  if (!card) return { error: "Card not in hand." };
  const legal = legalCards(hand, g.trick);
  if (!legal.some((c) => c.id === cardId)) return { error: "You must follow suit." };

  const following = g.trick.length === 0 || card.suit === g.trick[0].card.suit;
  if (!following && room.config.trumpMode === "cut" && !g.trumpSuit) {
    g.trumpSuit = card.suit;
    g.trumpRevealed = true;
    g.cutBy = seat;
  }

  g.hands[seat] = hand.filter((c) => c.id !== cardId);
  g.trick.push({ seat, card });
  g.turnSeat = (seat + 1) % room.config.players;
  Shell.saveRoom(room);
  return { ok: true, trickComplete: g.trick.length === room.config.players };
}

function resolveTrick(room) {
  const g = room.game;
  const trumpActive = g.trumpRevealed && !!g.trumpSuit;
  const winner = trickWinner(g.trick, g.trumpSuit, trumpActive);
  const team = winner % 2;
  const tens = g.trick.filter((t) => isTen(t.card)).map((t) => t.card);
  g.captured[team].tens.push(...tens);
  g.captured[team].tricks += 1;
  g.lastTrick = { cards: g.trick, winner };
  g.trick = [];
  g.leadSeat = winner;
  g.turnSeat = winner;

  const handOver = g.hands.every((h) => h.length === 0);
  if (handOver) {
    g.result = computeResult(g.captured, g.totalTens);
    if (g.result.winner !== null) {
      room.matchScore[g.result.winner] += 1;
    }
    const target = matchWinTarget(room.config.decks);
    const matchWinner = room.matchScore[0] >= target ? 0 : room.matchScore[1] >= target ? 1 : null;
    if (matchWinner !== null) {
      room.matchResult = { winner: matchWinner, score: { ...room.matchScore }, target };
      room.phase = "matchEnd";
    } else {
      room.phase = "handEnd";
    }
  }
  Shell.saveRoom(room);
  return { winner, handOver };
}

function nextHand(room) {
  if (room.phase !== "handEnd") return { error: "Cannot deal next hand now." };
  const dealer = (room.game.dealer + 1) % room.config.players;
  startHand(room, dealer, true);
  return { ok: true };
}

// ---------- Per-player redacted view ----------
function viewFor(room, seat) {
  const g = room.game;
  const seats = room.seats.map((s, i) => ({
    name: s.name,
    isBot: s.isBot,
    connected: s.isBot ? true : s.connected,
    seat: i,
    isHost: s.token && s.token === room.hostToken,
    avatar: !s.isBot && s.playerId ? Profiles.getPhoto(s.playerId) : null,
  }));
  const isHostSeat = !!(room.seats[seat] && room.seats[seat].token && room.seats[seat].token === room.hostToken);
  const base = {
    code: room.code,
    config: room.config,
    phase: room.phase,
    paused: room.paused,
    seats,
    you: seat,
    matchScore: room.matchScore,
    matchResult: room.matchResult || null,
    handSeq: room.handSeq || 0,
    pendingJoins: isHostSeat
      ? room.pendingJoins.map((p) => ({ reqId: p.reqId, name: p.name, requestedAt: p.requestedAt }))
      : [],
    chat: room.chat.slice(-50),
  };
  if (!g) return base;

  // Hidden trump is only visible to its chooser until revealed
  let trumpVisible = g.trumpRevealed;
  if (room.config.trumpMode === "hidden" && g.chooser === seat) trumpVisible = !!g.trumpSuit;

  return {
    ...base,
    game: {
      hand: seat >= 0 ? g.hands[seat] : [],
      counts: g.hands.map((h) => h.length),
      trick: g.trick,
      leadSeat: g.leadSeat,
      turnSeat: g.turnSeat,
      trumpSuit: trumpVisible ? g.trumpSuit : null,
      trumpSet: !!g.trumpSuit,
      trumpRevealed: g.trumpRevealed,
      captured: g.captured,
      dealer: g.dealer,
      lastTrick: g.lastTrick,
      totalTens: g.totalTens,
      result: g.result,
      cutBy: g.cutBy,
      chooser: g.chooser,
      legal:
        room.phase === "playing" &&
        g.turnSeat === seat &&
        !room.paused &&
        g.trick.length < room.config.players
          ? legalCards(g.hands[seat], g.trick).map((c) => c.id)
          : [],
    },
  };
}

module.exports = {
  rooms,
  createRoom,
  requestJoinRoom: Shell.requestJoinRoom,
  approveJoinRequest: Shell.approveJoinRequest,
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
  startHand,
  chooseTrump,
  checkTrumpReveal,
  playCard,
  resolveTrick,
  nextHand,
  viewFor,
};
