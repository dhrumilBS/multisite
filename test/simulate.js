// Simulates full hands with all-bot tables across every config to validate the engine.
"use strict";

const R = require("../game/rooms");
const { botChooseCard, botChooseTrump } = require("../game/bot");
const { targetHandSize } = require("../game/logic");

function simulate(players, decks, trumpMode) {
  const { room } = R.createRoom("TestHost", { players, decks, trumpMode, speed: "fast" });
  R.fillWithBots(room);
  // Make host seat a bot too so the whole game self-plays
  room.seats[0] = { name: "HostBot", token: room.hostToken, isBot: true, connected: true };
  R.startHand(room, 0, false);

  if (room.phase === "trumpSelect") {
    const chooser = room.game.chooser;
    R.chooseTrump(room, chooser, botChooseTrump(room.game.hands[chooser]));
  }

  let safety = 0;
  while (room.phase === "playing" && safety++ < 500) {
    R.checkTrumpReveal(room);
    const seat = room.game.turnSeat;
    const card = botChooseCard(seat, room.game, room.config);
    const res = R.playCard(room, seat, card.id);
    if (res.error) throw new Error(`Illegal bot play (${players}p ${decks}d ${trumpMode}): ${res.error}`);
    if (res.trickComplete) R.resolveTrick(room);
  }
  if (room.phase !== "handEnd") throw new Error(`Hand never finished (${players}p ${decks}d ${trumpMode})`);

  const g = room.game;
  const tens = g.captured[0].tens.length + g.captured[1].tens.length;
  const tricks = g.captured[0].tricks + g.captured[1].tricks;
  const expectedTens = 4 * decks;
  const expectedTricks = targetHandSize(decks, players);
  if (tens !== expectedTens) throw new Error(`Ten count mismatch: ${tens} vs ${expectedTens}`);
  if (tricks !== expectedTricks) throw new Error(`Trick count mismatch: ${tricks} vs ${expectedTricks}`);

  console.log(
    `OK ${players}p ${decks}deck ${trumpMode.padEnd(6)} -> tens ${g.captured[0].tens.length}-${g.captured[1].tens.length}, tricks ${g.captured[0].tricks}-${g.captured[1].tricks}, winner: ${g.result.winner === null ? "draw" : "team " + g.result.winner} (${g.result.reason})`
  );
  R.deleteRoom(room.code);
}

let runs = 0;
for (const players of [4, 6, 8]) {
  for (const decks of [3, 4, 5]) {
    for (const trumpMode of ["cut", "hidden", "random", "none"]) {
      for (let i = 0; i < 3; i++) {
        simulate(players, decks, trumpMode);
        runs++;
      }
    }
  }
}
console.log(`\nAll ${runs} simulated hands completed cleanly.`);
