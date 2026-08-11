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

let wallets = null; // playerId -> { balance, name, updatedAt }

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
    wallets[playerId] = { balance: STARTING_BALANCE, name: name || "Player", updatedAt: Date.now() };
    persist();
  } else if (name && wallets[playerId].name !== name) {
    wallets[playerId].name = name;
  }
  return { playerId, ...wallets[playerId] };
}

function getBalance(playerId) {
  return ensureAccount(playerId).balance;
}

function debit(playerId, amount) {
  init();
  const acct = ensureAccount(playerId);
  if (amount <= 0) return { error: "Invalid amount." };
  if (acct.balance < amount) return { error: "Insufficient balance." };
  wallets[playerId].balance -= amount;
  wallets[playerId].updatedAt = Date.now();
  persist();
  return { ok: true, balance: wallets[playerId].balance };
}

function credit(playerId, amount) {
  init();
  ensureAccount(playerId);
  if (amount <= 0) return { ok: true, balance: wallets[playerId].balance };
  wallets[playerId].balance += amount;
  wallets[playerId].updatedAt = Date.now();
  persist();
  return { ok: true, balance: wallets[playerId].balance };
}

// Apply a batch of net chip deltas (positive = win, negative = loss) in one
// atomic write - the settlement contract every Teen Patti hand/match/room-end
// path uses. Bots (no playerId) are simply never included by the caller.
function settle(deltas) {
  init();
  for (const playerId of Object.keys(deltas || {})) {
    const delta = deltas[playerId];
    ensureAccount(playerId);
    wallets[playerId].balance = Math.max(0, wallets[playerId].balance + delta);
    wallets[playerId].updatedAt = Date.now();
  }
  persist();
  return { ok: true };
}

module.exports = {
  STARTING_BALANCE,
  init,
  ensureAccount,
  getBalance,
  debit,
  credit,
  settle,
};
