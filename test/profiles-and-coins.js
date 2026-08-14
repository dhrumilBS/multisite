// Deterministic tests for game/profiles.js (name+photo persistence and
// validation), game/wallet.js's transaction ledger (the "passbook"), and
// Teen Patti's host-only addCoins action (game/teenpatti/rooms.js).
"use strict";

const Profiles = require("../game/profiles");
const Wallet = require("../game/wallet");
const R = require("../game/teenpatti/rooms");

let failures = 0;
function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK   ${name}`);
  }
}

// ---------- profiles ----------
const pid = "test-player-" + Math.random().toString(36).slice(2);

{
  const res = Profiles.setProfile(pid, { name: "Rohan", photo: null });
  check("setProfile ok with no photo", res.ok, true);
  check("getProfile returns the name", Profiles.getProfile(pid).name, "Rohan");
  check("getPhoto is null when unset", Profiles.getPhoto(pid), null);
}

{
  Profiles.setProfile(pid, { name: "ThisNameIsWayTooLongForTheLimit" });
  check("name is clamped to 16 chars", Profiles.getProfile(pid).name.length, 16);
}

{
  const validPhoto = "data:image/png;base64," + "A".repeat(100);
  const res = Profiles.setProfile(pid, { photo: validPhoto });
  check("valid photo accepted", res.ok, true);
  check("photo is stored", Profiles.getPhoto(pid), validPhoto);
  check("name-only update succeeds", Profiles.setProfile(pid, { name: "Rohan2" }).ok, true);
  check("photo survives a name-only update", Profiles.getPhoto(pid), validPhoto);
}

check("bad prefix rejected", !!Profiles.setProfile(pid, { photo: "not-a-data-uri" }).error, true);
check(
  "embedded-quote/attribute-injection attempt rejected",
  !!Profiles.setProfile(pid, { photo: 'data:image/png;base64,AAAA" onerror="alert(1)' }).error,
  true
);
check(
  "oversized photo rejected",
  !!Profiles.setProfile(pid, { photo: "data:image/png;base64," + "A".repeat(250000) }).error,
  true
);
check("missing playerId rejected", !!Profiles.setProfile(null, { name: "x" }).error, true);

// ---------- wallet ledger ("passbook") ----------
{
  const wpid = "test-wallet-" + Math.random().toString(36).slice(2);
  Wallet.ensureAccount(wpid); // seeds STARTING_BALANCE (1000)

  const d = Wallet.debit(wpid, 200, "Bought in to a new Teen Patti table");
  check("debit succeeds", d.ok, true);
  let ledger = Wallet.getLedger(wpid);
  check("debit recorded as most-recent entry", ledger[0].type, "debit");
  check("debit amount is negative", ledger[0].amount, -200);
  check("debit balanceAfter matches wallet balance", ledger[0].balanceAfter, Wallet.getBalance(wpid));
  check("debit note carried through", ledger[0].note, "Bought in to a new Teen Patti table");

  const c = Wallet.credit(wpid, 50, "Cashed out from table ABC123");
  check("credit succeeds", c.ok, true);
  ledger = Wallet.getLedger(wpid);
  check("credit recorded as most-recent entry", ledger[0].type, "credit");
  check("credit amount is positive", ledger[0].amount, 50);
  check("ledger is most-recent-first (previous debit now second)", ledger[1].type, "debit");

  Wallet.settle({ [wpid]: -30 }, "Cashed out from table XYZ789");
  ledger = Wallet.getLedger(wpid);
  check("settle with a negative delta records as a debit", ledger[0].type, "debit");
  check("settle amount matches the delta exactly", ledger[0].amount, -30);

  Wallet.logActivity(wpid, { type: "host-grant", amount: 500, note: "Host added 500 coins at table QWE111" });
  ledger = Wallet.getLedger(wpid);
  const balanceBeforeGrantCheck = Wallet.getBalance(wpid);
  check("logActivity entry recorded with the given type", ledger[0].type, "host-grant");
  check("logActivity never touches the wallet balance", ledger[0].balanceAfter, null);
  check("logActivity really left the balance unchanged", Wallet.getBalance(wpid), balanceBeforeGrantCheck);

  check("logActivity silently no-ops for a missing playerId", Wallet.logActivity(null, { type: "host-grant", amount: 1 }), undefined);

  for (let i = 0; i < 210; i++) Wallet.credit(wpid, 1, "filler #" + i);
  check("ledger is capped at 200 entries", Wallet.getLedger(wpid).length, 200);
  check("cap keeps the newest entries (most recent first)", Wallet.getLedger(wpid)[0].note, "filler #209");
}

// ---------- Teen Patti addCoins (host-only free grant) ----------
{
  const { room } = R.createRoom(
    "Host",
    { players: 4, variant: "classic", bootAmount: 10, buyIn: 500, sideShowAllowed: true, speed: "fast" },
    null
  );
  R.fillWithBots(room);
  room.seats[0] = { name: "HostBot", token: room.hostToken, isBot: true, connected: true };
  const hostSeat = 0;

  check("non-host cannot add coins", !!R.actions.addCoins(room, 1, { targetSeat: 2, amount: 100 }).error, true);
  check("negative amount rejected", !!R.actions.addCoins(room, hostSeat, { targetSeat: 2, amount: -5 }).error, true);
  check("zero amount rejected", !!R.actions.addCoins(room, hostSeat, { targetSeat: 2, amount: 0 }).error, true);
  check("out-of-range target seat rejected", !!R.actions.addCoins(room, hostSeat, { targetSeat: 99, amount: 100 }).error, true);

  const before = room.tableStacks[2];
  const ok = R.actions.addCoins(room, hostSeat, { targetSeat: 2, amount: 250 });
  check("valid grant succeeds", ok.ok, true);
  check("tableStacks bumped by the exact amount", room.tableStacks[2], before + 250);

  R.startFirstHand(room);
  const liveBefore = room.game.seats[2].stack;
  R.actions.addCoins(room, hostSeat, { targetSeat: 2, amount: 100 });
  check("live in-hand stack also bumped when a hand is in progress", room.game.seats[2].stack, liveBefore + 100);

  R.deleteRoom(room.code);
}

if (failures) {
  console.error(`\n${failures} profile/coins test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll profile & coins tests passed.`);
