// Deterministic unit tests for game/teenpatti/logic.js: hand classification,
// the A-2-3-low-straight edge case, wild-card substitution (AK47/Joker),
// Muflis win-direction flipping, and the blind/seen betting-unit math.
"use strict";

const L = require("../game/teenpatti/logic");

let failures = 0;
function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK   ${name} -> ${JSON.stringify(actual)}`);
  }
}

let id = 0;
const c = (suit, rank) => ({ id: id++, suit, rank });
const NONE = { wild: "none" };

// ---------- category classification ----------
check("trail", L.evaluateHand([c("S", 5), c("H", 5), c("D", 5)], NONE).category, L.TRAIL);
check("pure sequence 9-10-J same suit", L.evaluateHand([c("S", 9), c("S", 10), c("S", 11)], NONE).category, L.PURE_SEQUENCE);
check("sequence 9-10-J mixed suit", L.evaluateHand([c("S", 9), c("H", 10), c("D", 11)], NONE).category, L.SEQUENCE);
check("color (flush, no sequence)", L.evaluateHand([c("S", 2), c("S", 5), c("S", 9)], NONE).category, L.COLOR);
check("pair", L.evaluateHand([c("S", 8), c("H", 8), c("D", 3)], NONE).category, L.PAIR);
check("pair tiebreak [pairRank, kicker]", L.evaluateHand([c("S", 8), c("H", 8), c("D", 3)], NONE).tiebreakRanks, [8, 3]);
check("high card", L.evaluateHand([c("S", 2), c("H", 7), c("D", 11)], NONE).category, L.HIGH_CARD);
check("high card tiebreak descending", L.evaluateHand([c("S", 2), c("H", 7), c("D", 11)], NONE).tiebreakRanks, [11, 7, 2]);

// ---------- A-2-3 low-straight ruling ----------
check("A-2-3 is a valid sequence", L.evaluateHand([c("S", 14), c("H", 2), c("D", 3)], NONE).category, L.SEQUENCE);
check("A-2-3 ranks as the LOW straight (tiebreak 3)", L.evaluateHand([c("S", 14), c("H", 2), c("D", 3)], NONE).tiebreakRanks, [3]);
check("Q-K-A ranks as the HIGH straight (tiebreak 14)", L.evaluateHand([c("S", 12), c("H", 13), c("D", 14)], NONE).tiebreakRanks, [14]);
{
  const low = L.evaluateHand([c("S", 14), c("H", 2), c("D", 3)], NONE);
  const twoThreeFour = L.evaluateHand([c("H", 2), c("D", 3), c("C", 4)], NONE);
  check("2-3-4 beats A-2-3", L.compareHands(twoThreeFour, low, NONE) > 0, true);
}

// ---------- category ordering ----------
{
  const trail = L.evaluateHand([c("S", 5), c("H", 5), c("D", 5)], NONE);
  const pureSeq = L.evaluateHand([c("S", 9), c("S", 10), c("S", 11)], NONE);
  const seq = L.evaluateHand([c("S", 9), c("H", 10), c("D", 11)], NONE);
  const color = L.evaluateHand([c("S", 2), c("S", 5), c("S", 9)], NONE);
  const pair = L.evaluateHand([c("S", 8), c("H", 8), c("D", 3)], NONE);
  const high = L.evaluateHand([c("S", 2), c("H", 7), c("D", 11)], NONE);
  check("trail > pure sequence", L.compareHands(trail, pureSeq, NONE) > 0, true);
  check("pure sequence > sequence", L.compareHands(pureSeq, seq, NONE) > 0, true);
  check("sequence > color", L.compareHands(seq, color, NONE) > 0, true);
  check("color > pair", L.compareHands(color, pair, NONE) > 0, true);
  check("pair > high card", L.compareHands(pair, high, NONE) > 0, true);

  // ---------- Muflis: only the win direction flips ----------
  const MUFLIS = { muflis: true };
  check("muflis: high card beats trail", L.compareHands(trail, high, MUFLIS) < 0, true);
  check("muflis: category order itself is unchanged (trail still > pair in raw terms)", L.compareHands(trail, pair, NONE) > 0, true);
}

// ---------- AK47 wild substitution ----------
{
  const AK47 = { wild: "ak47" };
  // Ace is wild; two natural 9s -> best completion is Trail of 9s.
  const hand = L.evaluateHand([c("S", 14), c("H", 9), c("D", 9)], AK47);
  check("AK47: wild Ace completes a natural pair into a trail", hand.category, L.TRAIL);
  check("AK47: trail tiebreak is the natural pair's rank", hand.tiebreakRanks, [9]);
  check("AK47: hand is flagged wild", hand.isWild, true);
}

// ---------- Joker wild substitution ----------
{
  const JOKER = { wild: "joker", jokerCount: 1 };
  const hand = L.evaluateHand([{ id: id++, isJoker: true }, c("H", 10), c("D", 10)], JOKER);
  check("Joker: wild joker completes a natural pair into a trail", hand.category, L.TRAIL);
  check("Joker: trail tiebreak is the natural pair's rank", hand.tiebreakRanks, [10]);
}

// ---------- three wild cards self-substitute to the best possible hand ----------
{
  const AK47 = { wild: "ak47" };
  // A, K, 4 are all wild by rank in AK47 - all three cards in this hand are wild.
  const hand = L.evaluateHand([c("S", 14), c("H", 13), c("D", 4)], AK47);
  check("three wild cards -> Trail of Aces", hand.category, L.TRAIL);
  check("three wild cards -> tiebreak [14]", hand.tiebreakRanks, [14]);
}

// ---------- betting-unit math ----------
{
  const blindSeat = { isBlind: true, contributed: 0 };
  const seenSeat = { isBlind: false, contributed: 0 };
  check("blind live stake = currentStake", L.liveStakeFor(blindSeat, 10), 10);
  check("seen live stake = 2x currentStake", L.liveStakeFor(seenSeat, 10), 20);
  check("toCall for a fresh blind seat", L.toCall(blindSeat, 10), 10);
  check("toCall for a fresh seen seat", L.toCall(seenSeat, 10), 20);
  check("blind raise redefines the blind unit to what was paid", L.nextStakeAfterAction(blindSeat, 20, 10), 20);
  check("seen bet redefines the blind unit to half of what was paid", L.nextStakeAfterAction(seenSeat, 40, 10), 20);
}

if (failures) {
  console.error(`\n${failures} Teen Patti logic test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll Teen Patti logic tests passed.`);
