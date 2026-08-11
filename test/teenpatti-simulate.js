// Simulates full Teen Patti tables with all-bot seats across every player
// count and variant to validate the betting engine end-to-end, mirroring
// test/simulate.js's style for Mindi.
"use strict";

const R = require("../game/teenpatti/rooms");

function playOneHandToEnd(room) {
  let safety = 0;
  while (room.phase === "betting" && safety++ < 2000) {
    R.driveOneStep(room);
  }
  if (room.phase !== "handEnd") {
    throw new Error(`Hand never finished (phase=${room.phase}, safety=${safety})`);
  }
}

function simulate(players, variant) {
  const { room } = R.createRoom(
    "TestHost",
    { players, variant, bootAmount: 10, buyIn: 500, sideShowAllowed: true, speed: "fast" },
    null
  );
  R.fillWithBots(room);
  // Make the host seat a bot too so the whole table self-plays.
  room.seats[0] = { name: "HostBot", token: room.hostToken, isBot: true, connected: true };
  R.startFirstHand(room);

  let hands = 0;
  const maxHands = 25;
  while (hands < maxHands) {
    if (room.phase === "betting") playOneHandToEnd(room);
    if (room.phase !== "handEnd") break;
    hands++;

    const g = room.game;
    if (g.result.potAwarded < 0) throw new Error(`Negative pot awarded (${players}p ${variant})`);
    const totalReceived = (g.result.winners || []).reduce((sum, w) => sum + w.share, 0);
    if (totalReceived !== g.result.potAwarded) {
      throw new Error(`Pot not fully distributed (${players}p ${variant}): awarded ${g.result.potAwarded}, paid out ${totalReceived}`);
    }
    room.tableStacks.forEach((s, i) => {
      if (s < 0) throw new Error(`Seat ${i} has a negative stack (${players}p ${variant}): ${s}`);
    });

    const activeWithChips = room.tableStacks.filter((s) => s > 0).length;
    if (activeWithChips < 2) break; // table is down to one player with chips - nothing left to play

    const res = R.nextHand(room, 0);
    if (res.error) throw new Error(`nextHand rejected mid-simulation (${players}p ${variant}): ${res.error}`);
  }

  console.log(`OK ${players}p ${variant.padEnd(8)} -> ${hands} hand(s), final stacks [${room.tableStacks.join(",")}]`);
  R.deleteRoom(room.code);
}

let runs = 0;
for (const players of [3, 4, 5, 6, 7]) {
  for (const variant of ["classic", "muflis", "ak47", "joker"]) {
    simulate(players, variant);
    runs++;
  }
}
console.log(`\nAll ${runs} Teen Patti self-play tables completed cleanly.`);
