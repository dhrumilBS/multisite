// Deterministic unit tests for the trick-tiebreak rule in game/logic.js:
// when two or more players tie for the trick's highest card (possible with
// multiple decks), the tied players' next-highest REMAINING hand card is
// compared (peek only), recursing until broken, falling back to first-played
// on full exhaustion.
"use strict";

const { trickWinner } = require("../game/logic");

let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${name}: expected seat ${expected}, got ${actual}`);
  } else {
    console.log(`OK   ${name} -> seat ${actual}`);
  }
}
let id = 0;
const c = (suit, rank) => ({ id: id++, suit, rank });

// 1. Simple 2-way tie on identical rank+suit, broken by next-highest remaining card.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("H", 6) },
    { seat: 2, card: c("S", 10) }, // ties seat 0
    { seat: 3, card: c("D", 7) },
  ];
  const hands = {
    0: [c("S", 12)], // seat 0's best remaining: Q
    1: [],
    2: [c("S", 13)], // seat 2's best remaining: K -> seat 2 wins
    3: [],
  };
  check("2-way tie, single peek", trickWinner(trick, null, false, hands), 2);
}

// 2. Tie that recurses to a 2nd peek level (first peek also ties).
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 10) }, // ties seat 0
  ];
  const hands = {
    0: [c("S", 13), c("H", 8)], // top: K, 2nd: 8
    1: [c("D", 13), c("H", 9)], // top: K (tie), 2nd: 9 -> seat 1 wins
  };
  check("recurses to 2nd peek level", trickWinner(trick, null, false, hands), 1);
}

// 3. Three-way tie needing two rounds of recursion to resolve.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 10) },
    { seat: 2, card: c("S", 10) },
  ];
  const hands = {
    0: [c("H", 13), c("H", 6)],
    1: [c("D", 13), c("H", 7)],
    2: [c("C", 13), c("H", 9)], // ties at depth 0 (all K), wins at depth 1 (9 > 7 > 6)
  };
  check("3-way tie resolves after 2 rounds", trickWinner(trick, null, false, hands), 2);
}

// 4. Full exhaustion: tied seats have no remaining cards -> fallback to first-played.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 10) },
  ];
  const hands = { 0: [], 1: [] };
  check("full exhaustion falls back to first-played", trickWinner(trick, null, false, hands), 0);
}

// 5. Trump tie broken by non-trump peek cards (peek uses raw rank, suit-agnostic).
{
  const trick = [
    { seat: 0, card: c("H", 10) }, // H is trump
    { seat: 1, card: c("S", 6) },
    { seat: 2, card: c("H", 10) }, // ties seat 0 on trump
  ];
  const hands = {
    0: [c("D", 8)],
    1: [],
    2: [c("C", 14)], // higher raw rank -> seat 2 wins
  };
  check("trump tie broken by peek", trickWinner(trick, "H", true, hands), 2);
}

// 6. No-tie regression: identical result with and without `hands`.
{
  const trick = [
    { seat: 0, card: c("S", 9) },
    { seat: 1, card: c("S", 14) },
    { seat: 2, card: c("H", 6) },
  ];
  const withHands = trickWinner(trick, null, false, { 0: [], 1: [], 2: [] });
  const withoutHands = trickWinner(trick, null, false);
  check("no-tie regression (with hands)", withHands, 1);
  check("no-tie regression (without hands)", withoutHands, 1);
}

// 7. Bot-style call (3 args, no hands) on a tied trick preserves old first-played behavior.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 10) },
  ];
  check("bot-style 3-arg call on tie -> first-played", trickWinner(trick, null, false), 0);
}

if (failures) {
  console.error(`\n${failures} tie-break test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll tie-break tests passed.`);
