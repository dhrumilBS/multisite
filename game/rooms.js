// Room lifecycle, authoritative game state, save/load persistence, per-player views.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

const SAVE_DIR = path.join(__dirname, "..", "saves");
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

const rooms = new Map(); // code -> room

const BOT_NAMES = ["Arjun", "Priya", "Kabir", "Meera", "Ravi", "Anaya", "Dev", "Isha"];

// Exact charset makeCode() draws from - also used to validate any client-
// supplied code before it ever touches the filesystem (see loadRoom below).
const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${CODE_CHARSET}]{6}$`);

function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  return rooms.has(code) || fs.existsSync(savePath(code)) ? makeCode() : code;
}

function savePath(code) {
  if (!CODE_RE.test(code)) throw new Error("Invalid room code");
  return path.join(SAVE_DIR, code + ".json");
}

function saveRoom(room) {
  try {
    const data = { ...room };
    const dest = savePath(room.code);
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, dest);
  } catch (e) {
    console.error("Save failed for room", room.code, e.message);
  }
}

function loadRoom(code) {
  code = String(code || "").toUpperCase().trim();
  if (!CODE_RE.test(code)) return null; // reject before any filesystem access
  if (rooms.has(code)) return rooms.get(code);
  try {
    const raw = fs.readFileSync(savePath(code), "utf8");
    const room = JSON.parse(raw);
    // Everyone is disconnected after a restart
    for (const s of room.seats) if (!s.isBot) s.connected = false;
    if (room.phase === "playing" || room.phase === "trumpSelect") room.paused = true;
    if (!room.pendingJoins) room.pendingJoins = [];
    if (room.matchResult === undefined) room.matchResult = null;
    rooms.set(code, room);
    return room;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Load failed for room", code, e.message);
    return null;
  }
}

function deleteRoom(code) {
  rooms.delete(code);
  try {
    if (fs.existsSync(savePath(code))) fs.unlinkSync(savePath(code));
  } catch (e) {}
}

function listSavedRooms() {
  try {
    return fs
      .readdirSync(SAVE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  } catch (e) {
    return [];
  }
}

// ---------- Room creation / joining ----------
function createRoom(hostName, config) {
  const code = makeCode();
  const token = crypto.randomUUID();
  const seats = [];
  for (let i = 0; i < config.players; i++) {
    seats.push({ name: null, token: null, isBot: false, connected: false });
  }
  seats[0] = { name: cleanName(hostName), token, isBot: false, connected: true };
  const room = {
    code,
    config: {
      players: [4, 6, 8].includes(config.players) ? config.players : 4,
      decks: [3, 4, 5].includes(config.decks) ? config.decks : 3,
      trumpMode: ["cut", "hidden", "random", "none"].includes(config.trumpMode)
        ? config.trumpMode
        : "cut",
      speed: ["relaxed", "normal", "fast"].includes(config.speed) ? config.speed : "normal",
    },
    hostToken: token,
    seats,
    phase: "lobby", // lobby | trumpSelect | playing | handEnd | matchEnd
    paused: false,
    game: null,
    matchScore: { 0: 0, 1: 0 },
    matchResult: null,
    pendingJoins: [],
    chat: [],
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  saveRoom(room);
  return { room, token, seat: 0 };
}

function cleanName(name) {
  return String(name || "Player").trim().slice(0, 16) || "Player";
}

// Joining is a two-step flow: a request is queued (visible only to the host
// via viewFor's pendingJoins), and only approveJoinRequest actually seats the
// player. This replaces the old instant-join behavior.
function requestJoinRoom(code, name, socketId) {
  const room = loadRoom(code);
  if (!room) return { error: "Room not found. Check the code." };
  if (room.phase !== "lobby") return { error: "Game already started. Ask for a rejoin link or wait for the next game." };
  const openSeats = room.seats.filter((s) => !s.name && !s.isBot).length;
  if (openSeats <= room.pendingJoins.length) return { error: "Room is full." };
  if (room.pendingJoins.length >= 50) return { error: "Too many pending requests, try again shortly." };
  const reqId = crypto.randomUUID();
  room.pendingJoins.push({ reqId, name: cleanName(name), socketId, requestedAt: Date.now() });
  saveRoom(room);
  return { room, reqId };
}

function approveJoinRequest(room, reqId) {
  const idx = room.pendingJoins.findIndex((p) => p.reqId === reqId);
  if (idx === -1) return { error: "Request not found (it may have expired)." };
  if (room.phase !== "lobby") return { error: "Game already started." };
  const seatIdx = room.seats.findIndex((s) => !s.name && !s.isBot);
  if (seatIdx === -1) return { error: "Room is full." };
  const entry = room.pendingJoins[idx];
  const token = crypto.randomUUID();
  room.seats[seatIdx] = { name: entry.name, token, isBot: false, connected: true };
  room.pendingJoins.splice(idx, 1);
  saveRoom(room);
  return { room, seat: seatIdx, token, socketId: entry.socketId };
}

function rejectJoinRequest(room, reqId) {
  const idx = room.pendingJoins.findIndex((p) => p.reqId === reqId);
  if (idx === -1) return { error: "Request not found." };
  const entry = room.pendingJoins[idx];
  room.pendingJoins.splice(idx, 1);
  saveRoom(room);
  return { room, socketId: entry.socketId };
}

function rejoinRoom(code, token) {
  const room = loadRoom(code);
  if (!room) return { error: "Room not found or expired." };
  const seatIdx = room.seats.findIndex((s) => s.token === token);
  if (seatIdx === -1) return { error: "You are not a member of this room." };
  room.seats[seatIdx].connected = true;
  maybeResume(room);
  saveRoom(room);
  return { room, seat: seatIdx };
}

function markDisconnected(room, seat) {
  if (!room.seats[seat] || room.seats[seat].isBot) return;
  room.seats[seat].connected = false;
  if (room.phase === "playing" || room.phase === "trumpSelect") {
    room.paused = true;
  }
  saveRoom(room);
}

function maybeResume(room) {
  const anyHumanOffline = room.seats.some((s) => !s.isBot && s.name && !s.connected);
  if (!anyHumanOffline && room.paused) room.paused = false;
}

function botifySeat(room, seat) {
  // Replace an absent player (or empty seat) with a bot
  const used = new Set(room.seats.map((s) => s.name));
  const botName = BOT_NAMES.find((n) => !used.has(n)) || "Bot" + seat;
  room.seats[seat] = { name: botName, token: null, isBot: true, connected: true };
  maybeResume(room);
  saveRoom(room);
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
  saveRoom(room);
}

function chooseTrump(room, seat, suit) {
  if (room.phase !== "trumpSelect") return { error: "Not choosing trump right now." };
  if (room.game.chooser !== seat) return { error: "You are not the trump chooser." };
  if (!["S", "H", "D", "C"].includes(suit)) return { error: "Invalid suit." };
  room.game.trumpSuit = suit;
  room.phase = "playing";
  saveRoom(room);
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
      saveRoom(room);
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
  saveRoom(room);
  return { ok: true, trickComplete: g.trick.length === room.config.players };
}

function resolveTrick(room) {
  const g = room.game;
  const trumpActive = g.trumpRevealed && !!g.trumpSuit;
  const winner = trickWinner(g.trick, g.trumpSuit, trumpActive, g.hands);
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
  saveRoom(room);
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
  requestJoinRoom,
  approveJoinRequest,
  rejectJoinRequest,
  rejoinRoom,
  loadRoom,
  deleteRoom,
  listSavedRooms,
  saveRoom,
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
