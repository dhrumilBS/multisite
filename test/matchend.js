// Deterministic-ish test for the real match-end condition: a team reaching
// matchWinTarget(decks) hand-wins ends the whole match (phase "matchEnd",
// room.matchResult set), nextHand() then refuses to deal again, and deleting
// the room actually removes it (used by the auto-delete-on-match-end path).
"use strict";

const R = require("../game/rooms");
const { botChooseCard, botChooseTrump } = require("../game/bot");
const { matchWinTarget } = require("../game/logic");

function playOneHandToEnd(room) {
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
    if (res.error) throw new Error(`Illegal bot play: ${res.error}`);
    if (res.trickComplete) R.resolveTrick(room);
  }
  if (safety >= 500) throw new Error("Hand never finished (safety cutoff).");
}

const players = 4;
const decks = 3;
const target = matchWinTarget(decks);
if (target !== 7) throw new Error(`matchWinTarget(3) expected 7, got ${target}`);

const { room } = R.createRoom("TestHost", { players, decks, trumpMode: "none", speed: "fast" });
R.fillWithBots(room);
room.seats[0] = { name: "HostBot", token: room.hostToken, isBot: true, connected: true };
R.startHand(room, 0, false);

let hands = 0;
const maxHands = 60; // generous upper bound: target=7, so this should always be plenty
while (room.phase !== "matchEnd" && hands < maxHands) {
  playOneHandToEnd(room);
  hands++;
  if (room.phase === "handEnd") {
    const res = R.nextHand(room);
    if (res.error) throw new Error(`nextHand rejected mid-match: ${res.error}`);
  }
}

if (room.phase !== "matchEnd") throw new Error(`Match never ended after ${hands} hands.`);
if (!room.matchResult) throw new Error("room.matchResult not set on match end.");
const { winner, score, target: resultTarget } = room.matchResult;
if (winner !== 0 && winner !== 1) throw new Error(`Bad matchResult.winner: ${winner}`);
if (score[winner] < target) throw new Error(`Winning team's score ${score[winner]} is below target ${target}.`);
if (resultTarget !== target) throw new Error(`matchResult.target ${resultTarget} !== ${target}`);
console.log(`OK match ended after ${hands} hands, winner team ${winner}, score ${score[0]}-${score[1]} (target ${target})`);

// nextHand must now refuse (match is over, not just the hand).
const blocked = R.nextHand(room);
if (!blocked.error) throw new Error("nextHand should refuse to deal after matchEnd.");
console.log(`OK nextHand refuses after matchEnd: "${blocked.error}"`);

// Deleting the room should make it unloadable (mirrors the server's auto-delete-on-match-end).
const code = room.code;
R.deleteRoom(code);
const reloaded = R.loadRoom(code);
if (reloaded !== null) throw new Error("Room still loadable after deleteRoom.");
console.log(`OK deleteRoom removes the room (code ${code} no longer loadable)`);

console.log("\nAll match-end tests passed.");
