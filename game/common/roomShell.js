// Generic room shell shared by every game (Mindi, Teen Patti, ...): seat
// bookkeeping, join-request/approve/reject, reconnect-by-token, disk
// persistence, and small validation helpers. Nothing here knows any single
// game's rules - each game module (game/rooms.js, game/teenpatti/rooms.js)
// builds its own `config`/phase machine on top of what's exported here.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./atomicWrite");

const SAVE_DIR = path.join(__dirname, "..", "..", "saves");
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

const rooms = new Map(); // code -> room, shared across every game type

const BOT_NAMES = ["Arjun", "Priya", "Kabir", "Meera", "Ravi", "Anaya", "Dev", "Isha"];

// Exact charset makeCode() draws from - also used to validate any client-
// supplied code before it ever touches the filesystem (see loadRoom below).
const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${CODE_CHARSET}]{6}$`);

// Per-gameType behavior a game module registers once at require-time, so the
// generic loadRoom()/disconnect helpers below can stay game-agnostic.
const GAME_TYPES = new Map(); // gameType -> { pausablePhases: string[] }
function registerGameType(gameType, opts) {
  GAME_TYPES.set(gameType, { pausablePhases: (opts && opts.pausablePhases) || [] });
}
function getGameTypeInfo(gameType) {
  return GAME_TYPES.get(gameType) || { pausablePhases: [] };
}

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
    writeJsonAtomic(savePath(room.code), { ...room });
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
    if (!room.config) room.config = {};
    if (!room.config.gameType) room.config.gameType = "mindi"; // back-compat for pre-multi-game saves
    // Everyone is disconnected after a restart
    for (const s of room.seats) if (!s.isBot) s.connected = false;
    const info = getGameTypeInfo(room.config.gameType);
    if (info.pausablePhases.includes(room.phase)) room.paused = true;
    if (!room.pendingJoins) room.pendingJoins = [];
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

function cleanName(name) {
  return String(name || "Player").trim().slice(0, 16) || "Player";
}

// Clamp `value` to one of `allowed`, falling back if it's not a member.
function clampChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Clamp `value` to an integer range, falling back if it's not a finite integer in range.
function clampRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// Build the generic room shell: code, tokens, seats (host seated at 0), and
// whatever config the caller has already validated. `extraConfig` is merged
// flat alongside {gameType, players} - each game module owns its own keys
// (e.g. Mindi's decks/trumpMode, Teen Patti's variant/bootAmount) and there's
// no collision since the two games use disjoint config key names.
function createRoomShell(hostName, gameType, seatCount, extraConfig, hostPlayerId) {
  const code = makeCode();
  const token = crypto.randomUUID();
  const seats = [];
  for (let i = 0; i < seatCount; i++) {
    seats.push({ name: null, token: null, isBot: false, connected: false });
  }
  seats[0] = { name: cleanName(hostName), token, isBot: false, connected: true, playerId: hostPlayerId || null };
  const room = {
    code,
    config: { gameType, players: seatCount, ...(extraConfig || {}) },
    hostToken: token,
    seats,
    phase: "lobby",
    paused: false,
    game: null,
    pendingJoins: [],
    chat: [],
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  saveRoom(room);
  return { room, token, seat: 0 };
}

// Joining is a two-step flow: a request is queued (visible only to the host
// via viewFor's pendingJoins), and only approveJoinRequest actually seats the
// player.
function requestJoinRoom(code, name, socketId, playerId) {
  const room = loadRoom(code);
  if (!room) return { error: "Room not found. Check the code." };
  if (room.phase !== "lobby") return { error: "Game already started. Ask for a rejoin link or wait for the next game." };
  const openSeats = room.seats.filter((s) => !s.name && !s.isBot).length;
  if (openSeats <= room.pendingJoins.length) return { error: "Room is full." };
  if (room.pendingJoins.length >= 50) return { error: "Too many pending requests, try again shortly." };
  const reqId = crypto.randomUUID();
  room.pendingJoins.push({ reqId, name: cleanName(name), socketId, playerId: playerId || null, requestedAt: Date.now() });
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
  room.seats[seatIdx] = { name: entry.name, token, isBot: false, connected: true, playerId: entry.playerId || null };
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

// True generic version: if no human seat is offline, un-pause. Games that
// need extra conditions (e.g. Teen Patti resolving a hand instead of staying
// paused) can layer their own logic around this.
function maybeResume(room) {
  const anyHumanOffline = room.seats.some((s) => !s.isBot && s.name && !s.connected);
  if (!anyHumanOffline && room.paused) room.paused = false;
}

// Mark a seat disconnected and pause the room if its game type says the
// current phase should pause on a human dropping out. Games with richer
// disconnect handling (e.g. auto-pack mid-betting) call this only as their
// fallback path, not for every disconnect.
function setDisconnected(room, seat) {
  if (!room.seats[seat] || room.seats[seat].isBot) return;
  room.seats[seat].connected = false;
  const info = getGameTypeInfo(room.config.gameType);
  if (info.pausablePhases.includes(room.phase)) room.paused = true;
  saveRoom(room);
}

// Replace an absent player (or empty seat) with a bot, seat-only - callers
// decide whether/when to call maybeResume() and saveRoom() afterward if they
// need to bundle it with other mutations.
function botifySeat(room, seat, nameList) {
  const pool = nameList || BOT_NAMES;
  const used = new Set(room.seats.map((s) => s.name));
  const botName = pool.find((n) => !used.has(n)) || "Bot" + seat;
  room.seats[seat] = { name: botName, token: null, isBot: true, connected: true };
}

function postChat(room, name, text) {
  const msg = { name, text: String(text || "").slice(0, 200), at: Date.now() };
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat = room.chat.slice(-100);
  saveRoom(room);
}

module.exports = {
  rooms,
  BOT_NAMES,
  CODE_RE,
  registerGameType,
  getGameTypeInfo,
  makeCode,
  savePath,
  saveRoom,
  loadRoom,
  deleteRoom,
  listSavedRooms,
  cleanName,
  clampChoice,
  clampRange,
  createRoomShell,
  requestJoinRoom,
  approveJoinRequest,
  rejectJoinRequest,
  rejoinRoom,
  maybeResume,
  setDisconnected,
  botifySeat,
  postChat,
};
