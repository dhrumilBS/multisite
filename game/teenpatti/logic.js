// Core Teen Patti rules - pure functions, no state. Mirrors the style of
// ../logic.js: deck construction, hand evaluation/comparison, and the
// betting-unit math, all stateless and independently testable.
"use strict";

const SUITS = ["S", "H", "D", "C"];
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAME = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A

// Category strength, weakest to strongest - index doubles as the numeric
// "how good is this hand" score used for comparisons.
const CATEGORY_NAMES = ["High Card", "Pair", "Color", "Sequence", "Pure Sequence", "Trail"];
const HIGH_CARD = 0, PAIR = 1, COLOR = 2, SEQUENCE = 3, PURE_SEQUENCE = 4, TRAIL = 5;

function buildDeck(variant) {
  variant = variant || { wild: "none" };
  const cards = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push({ id: id++, suit, rank });
  }
  if (variant.wild === "joker") {
    const count = variant.jokerCount === 2 ? 2 : 1;
    for (let i = 0; i < count; i++) cards.push({ id: id++, suit: null, rank: null, isJoker: true });
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

function sortHandDesc(cards) {
  return cards.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0));
}

function isWildCard(card, variant) {
  if (!variant) return false;
  if (variant.wild === "joker") return !!card.isJoker;
  if (variant.wild === "ak47") return [14, 13, 4, 7].includes(card.rank);
  return false;
}

// Classify 3 CONCRETE (non-wild, already-substituted) cards.
function classify(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const sameSuit = suits[0] === suits[1] && suits[1] === suits[2];
  const isTrail = ranks[0] === ranks[1] && ranks[1] === ranks[2];

  let isSeq = false;
  let seqHigh = null;
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) {
    isSeq = true;
    seqHigh = ranks[0]; // e.g. Q-K-A -> 14 (Ace high); 9-10-J -> 11
  } else if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) {
    // A-2-3: valid low straight, ranked BELOW 2-3-4 (Ace counts low here)
    isSeq = true;
    seqHigh = 3;
  }

  if (isTrail) return { category: TRAIL, tiebreakRanks: [ranks[0]] };
  if (isSeq && sameSuit) return { category: PURE_SEQUENCE, tiebreakRanks: [seqHigh] };
  if (isSeq) return { category: SEQUENCE, tiebreakRanks: [seqHigh] };
  if (sameSuit) return { category: COLOR, tiebreakRanks: ranks };
  if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) {
    const pairRank = ranks[0] === ranks[1] ? ranks[0] : ranks[1];
    const kicker = ranks[0] === ranks[1] ? ranks[2] : ranks[0];
    return { category: PAIR, tiebreakRanks: [pairRank, kicker] };
  }
  return { category: HIGH_CARD, tiebreakRanks: ranks };
}

// Compare two {category, tiebreakRanks} results, standard direction
// (higher category / higher tiebreak wins). Muflis inversion is applied by
// compareHands(), not here, so this stays a plain, direction-agnostic sort key.
function compareRaw(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const n = Math.max(a.tiebreakRanks.length, b.tiebreakRanks.length);
  for (let i = 0; i < n; i++) {
    const av = a.tiebreakRanks[i] ?? -1;
    const bv = b.tiebreakRanks[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const ALL_CONCRETE = SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })));

// evaluateHand(cards, variant) -> {category, tiebreakRanks, isWild, wildAs}
// For AK47/Joker, brute-force every substitution for the (at most 2, in
// practice usually 0-1) wild cards in this 3-card hand and keep the best
// resulting classification - cheap and exact at this hand size.
function evaluateHand(cards, variant) {
  variant = variant || { wild: "none" };
  const wildIdx = [];
  const natural = [];
  cards.forEach((c, i) => {
    if (isWildCard(c, variant)) wildIdx.push(i);
    else natural.push(c);
  });

  if (wildIdx.length === 0) {
    const result = classify(cards);
    return { ...result, isWild: false, wildAs: [] };
  }

  if (wildIdx.length >= 3) {
    // All three cards wild: self-substitute to the best possible hand (Trail of Aces).
    return {
      category: TRAIL,
      tiebreakRanks: [14],
      isWild: true,
      wildAs: cards.map((c) => ({ cardId: c.id, actsAsSuit: "S", actsAsRank: 14 })),
    };
  }

  const usedKey = new Set(natural.map((c) => c.suit + c.rank));
  const candidates = ALL_CONCRETE.filter((c) => !usedKey.has(c.suit + c.rank));

  let best = null;
  let bestAssignment = null;
  function tryAssignment(assignment) {
    const concrete = cards.map((c, i) => {
      const wPos = wildIdx.indexOf(i);
      return wPos === -1 ? { suit: c.suit, rank: c.rank } : assignment[wPos];
    });
    const result = classify(concrete);
    if (!best || compareRaw(result, best) > 0) {
      best = result;
      bestAssignment = assignment;
    }
  }

  if (wildIdx.length === 1) {
    for (const cand of candidates) tryAssignment([cand]);
  } else {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        tryAssignment([candidates[i], candidates[j]]);
      }
    }
  }

  return {
    ...best,
    isWild: true,
    wildAs: wildIdx.map((cardIdx, k) => ({
      cardId: cards[cardIdx].id,
      actsAsSuit: bestAssignment[k].suit,
      actsAsRank: bestAssignment[k].rank,
    })),
  };
}

// Compare two evaluateHand() results. Muflis flips only the win direction -
// category strength order never changes, only which end of it wins.
function compareHands(a, b, variant) {
  const cmp = compareRaw(a, b);
  return variant && variant.muflis ? -cmp : cmp;
}

function describeHand(evaluated) {
  const name = CATEGORY_NAMES[evaluated.category];
  return evaluated.isWild ? `${name} (with wild card)` : name;
}

// ---------- Betting-unit math ----------
// A blind action costs exactly `currentStake`; a seen action always costs
// double the blind unit, since a seen player has strictly more information.
function liveStakeFor(seat, currentStake) {
  return seat.isBlind ? currentStake : currentStake * 2;
}

function toCall(seat, currentStake) {
  return Math.max(0, liveStakeFor(seat, currentStake) - seat.contributed);
}

// After a seat pays `amountPaid` right now, this is the new blind-equivalent
// unit the NEXT blind player must match: unchanged if a blind player just
// acted (their bet already IS the blind unit), or half of what a seen player
// just wagered (since seen bets are always 2x the blind unit).
function nextStakeAfterAction(seat, amountPaid, currentStake) {
  return seat.isBlind ? amountPaid : Math.max(1, Math.round(amountPaid / 2));
}

module.exports = {
  SUITS,
  SUIT_SYMBOL,
  SUIT_NAME,
  RANKS,
  CATEGORY_NAMES,
  HIGH_CARD,
  PAIR,
  COLOR,
  SEQUENCE,
  PURE_SEQUENCE,
  TRAIL,
  buildDeck,
  shuffle,
  sortHandDesc,
  isWildCard,
  evaluateHand,
  compareHands,
  describeHand,
  liveStakeFor,
  toCall,
  nextStakeAfterAction,
};
