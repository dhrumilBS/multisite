// Deterministic unit tests for the trick-tiebreak rule in game/logic.js:
// when two or more players tie for the trick's highest card (possible with
// multiple decks), the LATER-played card wins outright (standard multi-deck
// house rule) - no peeking at remaining hand cards.
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

// 1. Simple 2-way tie on identical rank+suit - later-played card wins.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("H", 6) },
    { seat: 2, card: c("S", 10) }, // ties seat 0, played later -> wins
    { seat: 3, card: c("D", 7) },
  ];
  check("2-way tie, later card wins", trickWinner(trick, null, false), 2);
}

// 2. Three-way identical tie - the last one played wins.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 10) },
    { seat: 2, card: c("S", 10) },
  ];
  check("3-way tie, last played wins", trickWinner(trick, null, false), 2);
}

// 3. A strictly-higher card later in the trick still wins outright.
{
  const trick = [
    { seat: 0, card: c("S", 10) },
    { seat: 1, card: c("S", 13) }, // strictly higher -> wins
    { seat: 2, card: c("S", 10) }, // ties seat 0's rank, but seat 1 is still higher
  ];
  check("strictly-higher card beats an equal-rank tie elsewhere", trickWinner(trick, null, false), 1);
}

// 4. A tie that happens before a later strictly-higher, non-matching-suit card -
// leading suit ties resolve to later-played, but trump still overrides.
{
  const trick = [
    { seat: 0, card: c("S", 10) }, // lead suit
    { seat: 1, card: c("S", 10) }, // ties seat 0 on lead suit -> currently winning
    { seat: 2, card: c("H", 6) },  // trump, beats any non-trump
  ];
  check("trump beats a tied lead-suit pair", trickWinner(trick, "H", true), 2);
}

// 5. Trump tie broken by later-played trump card.
{
  const trick = [
    { seat: 0, card: c("H", 10) }, // H is trump
    { seat: 1, card: c("S", 6) },
    { seat: 2, card: c("H", 10) }, // ties seat 0 on trump, played later -> wins
  ];
  check("trump tie, later trump wins", trickWinner(trick, "H", true), 2);
}

// 6. No-tie regression: highest single card wins as before.
{
  const trick = [
    { seat: 0, card: c("S", 9) },
    { seat: 1, card: c("S", 14) },
    { seat: 2, card: c("H", 6) },
  ];
  check("no-tie regression", trickWinner(trick, null, false), 1);
}

if (failures) {
  console.error(`\n${failures} tie-break test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll tie-break tests passed.`);
