// Persistent chip wallet, shared across Teen Patti matches/sessions. Keyed by
// a client-generated `playerId` (see public/client.js), not by room/seat -
// unlike a Mindi room's matchScore, a wallet balance outlives any one room.
//
// Known limitation: playerId is a self-asserted client-generated UUID with
// no real authentication, the same trust model as the per-room reconnect
// `token` this app already uses. Fine for this project's scale/deployment;
// not something this module tries to solve.
"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./common/atomicWrite");

const DATA_DIR = path.join(__dirname, "..", "data");
const WALLET_PATH = path.join(DATA_DIR, "wallets.json");
const STARTING_BALANCE = 1000;
const MAX_LEDGER = 200; // per player - same "cap and slice" pattern room.chat already uses

let wallets = null; // playerId -> { balance, name, updatedAt, ledger }

function init() {
  if (wallets) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    wallets = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
  } catch (e) {
    wallets = {};
  }
}

function persist() {
  try {
    writeJsonAtomic(WALLET_PATH, wallets);
  } catch (e) {
    console.error("Wallet save failed:", e.message);
  }
}

function ensureAccount(playerId, name) {
  init();
  if (!wallets[playerId]) {
    wallets[playerId] = { balance: STARTING_BALANCE, name: name || "Player", updatedAt: Date.now(), ledger: [] };
    persist();
  } else {
    if (!wallets[playerId].ledger) wallets[playerId].ledger = [];
    if (name && wallets[playerId].name !== name) wallets[playerId].name = name;
  }
  return { playerId, ...wallets[playerId] };
}

// Appends one passbook line. `balanceAfter: null` marks an entry that never
// touched the wallet balance (e.g. a host's free table top-up) - the
// passbook UI shows those without a running-balance column.
function record(playerId, { type, amount, balanceAfter, note }) {
  const acct = wallets[playerId];
  acct.ledger.push({ type, amount, balanceAfter: balanceAfter == null ? null : balanceAfter, note: note || null, at: Date.now() });
  if (acct.ledger.length > MAX_LEDGER) acct.ledger = acct.ledger.slice(-MAX_LEDGER);
}

function getBalance(playerId) {
  return ensureAccount(playerId).balance;
}

// Most-recent-first, capped at MAX_LEDGER entries. Empty array for an
// unseen/missing playerId - never throws.
function getLedger(playerId) {
  if (!playerId) return [];
  return ensureAccount(playerId).ledger.slice().reverse();
}

function debit(playerId, amount, note) {
  init();
  const acct = ensureAccount(playerId);
  if (amount <= 0) return { error: "Invalid amount." };
  if (acct.balance < amount) return { error: "Insufficient balance." };
  wallets[playerId].balance -= amount;
  wallets[playerId].updatedAt = Date.now();
  record(playerId, { type: "debit", amount: -amount, balanceAfter: wallets[playerId].balance, note });
  persist();
  return { ok: true, balance: wallets[playerId].balance };
}

function credit(playerId, amount, note) {
  init();
  ensureAccount(playerId);
  if (amount <= 0) return { ok: true, balance: wallets[playerId].balance };
  wallets[playerId].balance += amount;
  wallets[playerId].updatedAt = Date.now();
  record(playerId, { type: "credit", amount, balanceAfter: wallets[playerId].balance, note });
  persist();
  return { ok: true, balance: wallets[playerId].balance };
}

// Apply a batch of net chip deltas (positive = win, negative = loss) in one
// atomic write - the settlement contract every Teen Patti hand/match/room-end
// path uses. Bots (no playerId) are simply never included by the caller.
function settle(deltas, note) {
  init();
  for (const playerId of Object.keys(deltas || {})) {
    const delta = deltas[playerId];
    ensureAccount(playerId);
    wallets[playerId].balance = Math.max(0, wallets[playerId].balance + delta);
    wallets[playerId].updatedAt = Date.now();
    record(playerId, { type: delta >= 0 ? "credit" : "debit", amount: delta, balanceAfter: wallets[playerId].balance, note });
  }
  persist();
  return { ok: true };
}

// Log a passbook line that does NOT move the wallet balance at all - e.g. a
// host's free table top-up (game/teenpatti/rooms.js's addCoins), which only
// affects table chips, never the persistent wallet. Silently no-ops for a
// missing playerId (bots, or a seat nobody ever attached an identity to).
function logActivity(playerId, { type, amount, note }) {
  if (!playerId) return;
  init();
  ensureAccount(playerId);
  record(playerId, { type, amount, balanceAfter: null, note });
  persist();
}

module.exports = {
  STARTING_BALANCE,
  init,
  ensureAccount,
  getBalance,
  getLedger,
  debit,
  credit,
  settle,
  logActivity,
};
