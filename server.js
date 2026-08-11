// Multi-game server - Express + Socket.IO, authoritative game state,
// bots for empty seats, pause on disconnect, save/resume from disk.
// Mindi (game/rooms.js) and Teen Patti (game/teenpatti/rooms.js) share the
// generic room shell (game/common/roomShell.js) but keep their own phase
// machines, bot AI, and pump/bot-pacing loops.
"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const Shell = require("./game/common/roomShell");
const Wallet = require("./game/wallet");
const R = require("./game/rooms");
const TeenPatti = require("./game/teenpatti/rooms");
const { botChooseCard, botChooseTrump } = require("./game/bot");

const GAMES = { mindi: R, teenpatti: TeenPatti };
function gameFor(room) {
  return GAMES[room.config.gameType] || GAMES.mindi;
}

Wallet.init();

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(",").map((s) => s.trim())
  : process.env.NODE_ENV === "production"
  ? false
  : "*";
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN } });

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3030;

const SPEEDS = { relaxed: 1400, normal: 850, fast: 420 };
const timers = new Map(); // code -> timeout

// Small dependency-free sliding-window rate limiter, one instance per event type.
function makeLimiter(maxEvents, windowMs) {
  const hits = new Map(); // socket.id -> timestamps[]
  return {
    allow(id) {
      const now = Date.now();
      const arr = (hits.get(id) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(id, arr);
      return arr.length <= maxEvents;
    },
    forget(id) {
      hits.delete(id);
    },
  };
}
const chatLimiter = makeLimiter(5, 5000);
const createRoomLimiter = makeLimiter(3, 60000);
const requestJoinLimiter = makeLimiter(10, 10000);
const playCardLimiter = makeLimiter(20, 5000);
const tpActionLimiter = makeLimiter(20, 5000);
const LIMITERS = [chatLimiter, createRoomLimiter, requestJoinLimiter, playCardLimiter, tpActionLimiter];

function clearRoomTimer(code) {
  if (timers.has(code)) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }
}

function setRoomTimer(code, fn, ms) {
  clearRoomTimer(code);
  timers.set(code, setTimeout(fn, ms));
}

// Send each connected player their own redacted view
function broadcast(room, extra) {
  const mod = gameFor(room);
  for (const [sid, sock] of io.sockets.sockets) {
    if (sock.data.roomCode === room.code && sock.data.seat != null) {
      sock.emit("state", { ...mod.viewFor(room, sock.data.seat), ...(extra || {}) });
    }
  }
}

function speedOf(room) {
  return SPEEDS[room.config.speed] || SPEEDS.normal;
}

// Drive the game forward: bot trump choice, hidden reveal, bot turns, trick resolution.
function pumpMindi(room) {
  clearRoomTimer(room.code);
  if (!room.game) return;
  if (room.paused) {
    broadcast(room);
    return;
  }

  // Bot needs to choose hidden trump (only happens if seat botified mid-select)
  if (room.phase === "trumpSelect") {
    const chooser = room.game.chooser;
    if (room.seats[chooser].isBot) {
      room.game.trumpSuit = botChooseTrump(room.game.hands[chooser]);
      room.phase = "playing";
      R.saveRoom(room);
    } else {
      broadcast(room);
      return; // waiting on a human
    }
  }

  if (room.phase !== "playing") {
    broadcast(room);
    return;
  }

  const g = room.game;

  // Completed trick -> resolve after a beat so players can see it
  if (g.trick.length === room.config.players) {
    broadcast(room);
    setRoomTimer(room.code, () => {
      if (room.paused) return;
      const { winner, handOver } = R.resolveTrick(room);
      broadcast(room, { trickWon: winner });
      if (handOver && room.phase === "matchEnd") {
        clearRoomTimer(room.code); // must clear before deleting, or a stray timer would resave the room
        broadcast(room, { matchEnded: true, matchResult: room.matchResult });
        R.deleteRoom(room.code);
        return;
      }
      if (!handOver) {
        setRoomTimer(room.code, () => pumpMindi(room), 250);
      }
    }, speedOf(room) + 500);
    return;
  }

  // Hidden trump auto-reveals when the player to act is void of the lead suit
  if (R.checkTrumpReveal(room)) {
    broadcast(room, { trumpJustRevealed: true });
  }

  // Bot to act
  const seatInfo = room.seats[g.turnSeat];
  if (seatInfo.isBot) {
    setRoomTimer(room.code, () => {
      if (room.paused || room.phase !== "playing") return;
      const card = botChooseCard(g.turnSeat, g, room.config);
      const res = R.playCard(room, g.turnSeat, card.id);
      if (res.ok) pumpMindi(room);
    }, speedOf(room));
  }
  broadcast(room);
}

function pump(room) {
  if ((room.config.gameType || "mindi") !== "mindi") {
    const ctx = {
      broadcast: (extra) => broadcast(room, extra),
      setTimer: (fn, ms) => setRoomTimer(room.code, fn, ms),
      clearTimer: () => clearRoomTimer(room.code),
      deleteRoom: () => Shell.deleteRoom(room.code),
    };
    return GAMES[room.config.gameType].pump(room, ctx);
  }
  return pumpMindi(room);
}

io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.seat = null;

  socket.on("createRoom", ({ name, config, playerId }, cb) => {
    if (!createRoomLimiter.allow(socket.id)) return cb && cb({ error: "Too many requests, slow down." });
    try {
      const gameType = config && GAMES[config.gameType] ? config.gameType : "mindi";
      const mod = GAMES[gameType];
      const res = mod.createRoom(name, config || {}, playerId);
      if (res.error) return cb && cb({ error: res.error });
      const { room, token, seat } = res;
      socket.data.roomCode = room.code;
      socket.data.seat = seat;
      cb({ ok: true, code: room.code, token, seat, state: mod.viewFor(room, seat) });
    } catch (e) {
      cb({ error: "Could not create room." });
    }
  });

  // Joining is a two-step request/approve flow: the requester is parked in
  // the room's pendingJoins list (visible only to the host) until the host
  // approves (seats them, pushes `joinApproved`) or rejects (`joinRejected`).
  socket.on("requestJoin", ({ code, name, playerId }, cb) => {
    if (!requestJoinLimiter.allow(socket.id)) return cb && cb({ error: "Too many requests, slow down." });
    const res = Shell.requestJoinRoom(code, name, socket.id, playerId);
    if (res.error) return cb && cb(res);
    socket.data.roomCode = res.room.code;
    socket.data.pendingReqId = res.reqId;
    cb && cb({ ok: true, pending: true, code: res.room.code, reqId: res.reqId });
    broadcast(res.room);
  });

  socket.on("cancelJoinRequest", (_, cb) => {
    const room = getRoom();
    if (room && socket.data.pendingReqId) {
      Shell.rejectJoinRequest(room, socket.data.pendingReqId);
      broadcast(room);
    }
    socket.data.pendingReqId = null;
    socket.data.roomCode = null;
    cb && cb({ ok: true });
  });

  socket.on("approveJoin", ({ reqId }, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can approve joins." });
    const mod = gameFor(room);
    const res = mod.approveJoinRequest(room, reqId);
    if (res.error) return cb && cb(res);
    const targetSock = io.sockets.sockets.get(res.socketId);
    if (targetSock) {
      targetSock.data.roomCode = room.code;
      targetSock.data.seat = res.seat;
      targetSock.data.pendingReqId = null;
      targetSock.emit("joinApproved", {
        ok: true,
        code: room.code,
        token: res.token,
        seat: res.seat,
        state: mod.viewFor(room, res.seat),
      });
    }
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on("rejectJoin", ({ reqId }, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can reject joins." });
    const res = Shell.rejectJoinRequest(room, reqId);
    if (res.error) return cb && cb(res);
    const targetSock = io.sockets.sockets.get(res.socketId);
    if (targetSock) {
      targetSock.data.pendingReqId = null;
      targetSock.emit("joinRejected", { reason: "Host declined your request." });
    }
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on("rejoin", ({ code, token }, cb) => {
    const res = Shell.rejoinRoom(code, token);
    if (res.error) return cb(res);
    socket.data.roomCode = res.room.code;
    socket.data.seat = res.seat;
    const mod = gameFor(res.room);
    cb({ ok: true, code: res.room.code, seat: res.seat, state: mod.viewFor(res.room, res.seat) });
    broadcast(res.room);
    if (!res.room.paused) pump(res.room);
  });

  function getRoom() {
    if (!socket.data.roomCode) return null;
    return Shell.loadRoom(socket.data.roomCode);
  }
  function isHost(room) {
    const s = room.seats[socket.data.seat];
    return s && s.token === room.hostToken;
  }

  socket.on("addBot", ({ seat }, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can manage seats." });
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.seats.length)
      return cb && cb({ error: "Invalid seat." });
    if (room.seats[seat] && room.seats[seat].name && room.seats[seat].connected && !room.seats[seat].isBot)
      return cb && cb({ error: "Seat is occupied by a connected player." });
    gameFor(room).botifySeat(room, seat);
    broadcast(room);
    pump(room);
    cb && cb({ ok: true });
  });

  socket.on("startGame", (_, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can start." });
    if (room.phase !== "lobby") return cb && cb({ error: "Already started." });
    // Any still-pending join requests are moot once the game starts.
    for (const p of room.pendingJoins) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.data.pendingReqId = null;
        s.emit("joinRejected", { reason: "Game already started." });
      }
    }
    room.pendingJoins = [];
    const mod = gameFor(room);
    mod.fillWithBots(room);
    if (room.config.gameType === "teenpatti") {
      mod.startFirstHand(room);
    } else {
      mod.startHand(room, Math.floor(Math.random() * room.config.players), false);
    }
    broadcast(room);
    pump(room);
    cb && cb({ ok: true });
  });

  socket.on("chooseTrump", ({ suit }, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    const res = R.chooseTrump(room, socket.data.seat, suit);
    if (res.error) return cb && cb(res);
    broadcast(room);
    pump(room);
    cb && cb({ ok: true });
  });

  socket.on("playCard", ({ cardId }, cb) => {
    if (!playCardLimiter.allow(socket.id)) return cb && cb({ error: "Slow down." });
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    const res = R.playCard(room, socket.data.seat, cardId);
    if (res.error) return cb && cb(res);
    pump(room);
    cb && cb({ ok: true });
  });

  socket.on("nextHand", (_, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can deal the next hand." });
    const res = R.nextHand(room);
    if (res.error) return cb && cb(res);
    broadcast(room);
    pump(room);
    cb && cb({ ok: true });
  });

  // Single namespaced event for every Teen Patti betting action (seeCards,
  // placeBet, raise, pack, show, requestSideShow, respondSideShow, nextHand)
  // so the action set can grow without adding a new socket handler each time.
  socket.on("tpAction", ({ action, payload }, cb) => {
    if (!tpActionLimiter.allow(socket.id)) return cb && cb({ error: "Slow down." });
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (room.config.gameType !== "teenpatti") return cb && cb({ error: "Not a Teen Patti room." });
    const handler = TeenPatti.actions[action];
    if (!handler) return cb && cb({ error: "Unknown action." });
    const res = handler(room, socket.data.seat, payload || {});
    if (res.error) return cb && cb(res);
    broadcast(room);
    pump(room);
    cb && cb({ ok: true });
  });

  socket.on("walletBalance", ({ playerId }, cb) => {
    if (!playerId) return cb && cb({ balance: 0 });
    cb && cb({ balance: Wallet.getBalance(playerId) });
  });

  socket.on("chat", ({ text }) => {
    if (!chatLimiter.allow(socket.id)) return;
    const room = getRoom();
    if (!room || socket.data.seat == null) return;
    const name = room.seats[socket.data.seat] ? room.seats[socket.data.seat].name : "?";
    Shell.postChat(room, name, text);
    broadcast(room);
  });

  // Explicit save & exit: leave with game preserved on disk
  socket.on("saveExit", (_, cb) => {
    const room = getRoom();
    if (room) {
      gameFor(room).markDisconnected(room, socket.data.seat);
      clearRoomTimer(room.code);
      broadcast(room);
    }
    socket.data.roomCode = null;
    socket.data.seat = null;
    cb && cb({ ok: true });
  });

  // Host ends the room for everyone and deletes the save
  socket.on("endRoom", (_, cb) => {
    const room = getRoom();
    if (!room) return cb && cb({ error: "No room." });
    if (!isHost(room)) return cb && cb({ error: "Only the host can end the room." });
    clearRoomTimer(room.code);
    if (room.config.gameType === "teenpatti") TeenPatti.settleAndClose(room);
    broadcast(room, { roomEnded: true });
    Shell.deleteRoom(room.code);
    cb && cb({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const limiter of LIMITERS) limiter.forget(socket.id);
    const code = socket.data.roomCode;
    if (!code) return;
    const room = Shell.loadRoom(code);
    if (!room) return;
    if (socket.data.pendingReqId) {
      Shell.rejectJoinRequest(room, socket.data.pendingReqId);
      broadcast(room);
      return;
    }
    // Another socket may hold the same seat (refresh); only mark offline if none left
    const stillHere = [...io.sockets.sockets.values()].some(
      (s) => s !== socket && s.data.roomCode === code && s.data.seat === socket.data.seat
    );
    if (!stillHere) {
      gameFor(room).markDisconnected(room, socket.data.seat);
      if (room.paused) clearRoomTimer(code);
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  Multiplayer game server running!");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("  Saved rooms on disk: " + Shell.listSavedRooms().join(", ") || "none");
  console.log("");
});
