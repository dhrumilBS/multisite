// Core Mindi (Mendikot) rules — pure functions, no state.
"use strict";

const SUITS = ["S", "H", "D", "C"];
const SUIT_SYMBOL = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const SUIT_NAME = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
const RANKS = [8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A (base deck: 8 through A)

// Extra ranks brought in below the base range when more cards are needed,
// in priority order (7 first, then 6).
const EXTRA_RANKS = [7, 6];
// Suit order used when *adding* extra-rank cards.
const ADD_SUIT_ORDER = ["S", "H", "D", "C"];
// Suit order used when *removing* base cards (reverse of ADD_SUIT_ORDER).
const REMOVE_SUIT_ORDER = ["C", "D", "H", "S"];

// Nearest odd integer to `raw`. Ties (raw sits exactly between two odd
// numbers, i.e. raw is an even integer) round up, matching the spec's
// "since 14 is even, increase to 15" behavior.
function nearestOdd(raw) {
  const rounded = Math.round(raw);
  if (rounded % 2 !== 0) return rounded;
  const down = rounded - 1;
  const up = rounded + 1;
  const dDown = Math.abs(raw - down);
  const dUp = Math.abs(raw - up);
  return dUp <= dDown ? up : down;
}

// Decide how many cards each player should get: the odd number closest to
// an even split of the base deck (7 ranks x 4 suits x decks).
function targetHandSize(decks, players) {
  const base = RANKS.length * SUITS.length * decks;
  return nearestOdd(base / players);
}

// First team to win this many hands takes the whole match (half the tens,
// rounded up + 1, so a tie in hand-wins is impossible: e.g. 12 tens/3 decks
// -> 7, 16 tens/4 decks -> 9, 20 tens/5 decks -> 11).
function matchWinTarget(decks) {
  return 2 * decks + 1;
}

// Build the deck actually dealt this hand. Always produces
// target*players cards, with `target` odd and identical for every player,
// adding/removing the minimum number of cards (lowest ranks first) per the
// documented deck-generation rules.
function buildDeck(decks, players) {
  const base = RANKS.length * SUITS.length * decks;
  const target = targetHandSize(decks, players);
  let delta = target * players - base;

  const cards = [];
  let id = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: id++, suit, rank });
      }
    }
  }

  if (delta > 0) {
    // Need more cards: bring in 7s, then 6s, one suit-block (= one copy per
    // physical deck) at a time, in S->H->D->C order, until satisfied.
    outerAdd: for (const rank of EXTRA_RANKS) {
      for (const suit of ADD_SUIT_ORDER) {
        const take = Math.min(decks, delta);
        for (let d = 0; d < take; d++) cards.push({ id: id++, suit, rank });
        delta -= take;
        if (delta <= 0) break outerAdd;
      }
    }
  } else if (delta < 0) {
    // Too many cards: strip them from the lowest ranks present first,
    // reverse suit order (C->D->H->S), one suit-block at a time.
    let toRemove = -delta;
    outerRemove: for (const rank of RANKS) {
      for (const suit of REMOVE_SUIT_ORDER) {
        let removedForThis = 0;
        for (let i = cards.length - 1; i >= 0 && removedForThis < decks && toRemove > 0; i--) {
          if (cards[i].rank === rank && cards[i].suit === suit) {
            cards.splice(i, 1);
            removedForThis++;
            toRemove--;
          }
        }
        if (toRemove <= 0) break outerRemove;
      }
    }
  }

  return cards;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(hand) {
  const order = { S: 0, H: 1, C: 2, D: 3 };
  return hand.slice().sort((a, b) =>
    order[a.suit] !== order[b.suit] ? order[a.suit] - order[b.suit] : b.rank - a.rank
  );
}

const isTen = (c) => c.rank === 10;

// trick: [{seat, card}] in play order. On a tie for highest card (possible with
// multiple decks — e.g. two 10-of-spades), the tied players' next-highest
// REMAINING hand card is compared (peek only, nothing is played/removed); ties
// keep recursing to the next-highest remaining card until broken. If tied
// players run out of cards at the same depth (last trick of a hand), the
// first card played wins as a final fallback. `hands` is optional and indexed
// by seat — omit it (as the bot's speculative "who's winning" checks do) to
// get the plain first-played-wins behavior with no peeking.
function trickWinner(trick, trumpSuit, trumpActive, hands) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const t = trick[i];
    const bTrump = trumpActive && trumpSuit && best.card.suit === trumpSuit;
    const cTrump = trumpActive && trumpSuit && t.card.suit === trumpSuit;
    if (cTrump && !bTrump) best = t;
    else if (cTrump && bTrump && t.card.rank > best.card.rank) best = t;
    else if (!cTrump && !bTrump && t.card.suit === best.card.suit && t.card.rank > best.card.rank) best = t;
  }

  if (!hands) return best.seat;

  const bestTrump = trumpActive && trumpSuit && best.card.suit === trumpSuit;
  const tied = trick.filter((t) => {
    if (t === best) return true;
    const tTrump = trumpActive && trumpSuit && t.card.suit === trumpSuit;
    if (tTrump !== bestTrump) return false;
    if (!tTrump && t.card.suit !== best.card.suit) return false;
    return t.card.rank === best.card.rank;
  });
  if (tied.length <= 1) return best.seat;

  const sorted = {};
  for (const t of tied) sorted[t.seat] = (hands[t.seat] || []).slice().sort((a, b) => b.rank - a.rank);

  let candidates = tied;
  let depth = 0;
  while (candidates.length > 1) {
    let max = -Infinity;
    let anyHasCard = false;
    const peek = {};
    for (const t of candidates) {
      const card = sorted[t.seat][depth];
      peek[t.seat] = card ? card.rank : -Infinity;
      if (card) anyHasCard = true;
      if (peek[t.seat] > max) max = peek[t.seat];
    }
    if (!anyHasCard) return best.seat; // all tied hands exhausted together -> first-played wins
    candidates = candidates.filter((t) => peek[t.seat] === max);
    depth++;
  }
  return candidates[0].seat;
}

function legalCards(hand, trick) {
  if (trick.length === 0) return hand;
  const leadSuit = trick[0].card.suit;
  const follow = hand.filter((c) => c.suit === leadSuit);
  return follow.length > 0 ? follow : hand;
}

function computeResult(captured, totalTens) {
  const t0 = captured[0].tens.length;
  const t1 = captured[1].tens.length;
  let winner = null;
  let reason = "";
  if (t0 > t1) {
    winner = 0;
    reason = t0 === totalTens ? "MENDIKOT! All tens captured!" : `Captured ${t0} of ${totalTens} tens`;
  } else if (t1 > t0) {
    winner = 1;
    reason = t1 === totalTens ? "MENDIKOT! All tens captured!" : `Captured ${t1} of ${totalTens} tens`;
  } else {
    if (captured[0].tricks > captured[1].tricks) {
      winner = 0;
      reason = `Tens tied ${t0}-${t1}, won on tricks (${captured[0].tricks} vs ${captured[1].tricks})`;
    } else if (captured[1].tricks > captured[0].tricks) {
      winner = 1;
      reason = `Tens tied ${t0}-${t1}, won on tricks (${captured[1].tricks} vs ${captured[0].tricks})`;
    } else {
      reason = "Dead heat - tens and tricks both tied!";
    }
  }
  const totalTricks = captured[0].tricks + captured[1].tricks;
  if (winner !== null && captured[winner].tricks === totalTricks) {
    reason = "WHITEWASH! Every single trick! " + reason;
  }
  return { winner, reason, t0, t1 };
}

module.exports = {
  SUITS,
  SUIT_SYMBOL,
  SUIT_NAME,
  RANKS,
  targetHandSize,
  matchWinTarget,
  buildDeck,
  shuffle,
  sortHand,
  isTen,
  trickWinner,
  legalCards,
  computeResult,
};
