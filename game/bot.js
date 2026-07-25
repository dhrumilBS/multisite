// Bot AI for Mindi — decent heuristics: protect tens, feed partner, cut for value.
"use strict";

const { trickWinner, legalCards, isTen } = require("./logic");

function botChooseTrump(hand) {
  const counts = {};
  for (const c of hand) counts[c.suit] = (counts[c.suit] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}

function botChooseCard(seat, game, config) {
  const hand = game.hands[seat];
  const trick = game.trick;
  const legal = legalCards(hand, trick);
  const nPlayers = config.players;
  const myTeam = seat % 2;
  const trumpActive = game.trumpRevealed && !!game.trumpSuit;
  const trumpSuit = game.trumpSuit;

  const lowest = (cards) => cards.reduce((a, b) => (b.rank < a.rank ? b : a));
  const highest = (cards) => cards.reduce((a, b) => (b.rank > a.rank ? b : a));
  const nonTens = legal.filter((c) => !isTen(c));
  const safeLow = () => (nonTens.length ? lowest(nonTens) : lowest(legal));

  // Leading
  if (trick.length === 0) {
    const aces = hand.filter((c) => c.rank === 14 && (!trumpActive || c.suit !== trumpSuit));
    if (aces.length) return aces[Math.floor(Math.random() * aces.length)];
    const kings = hand.filter((c) => c.rank === 13 && (!trumpActive || c.suit !== trumpSuit));
    if (kings.length && Math.random() < 0.5) return kings[0];
    return safeLow();
  }

  const leadSuit = trick[0].card.suit;
  const following = hand.some((c) => c.suit === leadSuit);
  const winnerSeat = trickWinner(trick, trumpSuit, trumpActive);
  const partnerWinning = winnerSeat % 2 === myTeam;
  const trickHasTen = trick.some((t) => isTen(t.card));
  const iAmLast = trick.length === nPlayers - 1;

  const wouldWin = (card) =>
    trickWinner([...trick, { seat, card }], trumpSuit, trumpActive) === seat;

  if (following) {
    const winners = legal.filter(wouldWin);
    if (partnerWinning) {
      const tens = legal.filter(isTen);
      if (tens.length && (iAmLast || trickHasTen || Math.random() < 0.6)) return tens[0];
      return safeLow();
    }
    if (winners.length) {
      const nonTenWinners = winners.filter((c) => !isTen(c));
      if (trickHasTen || iAmLast) {
        return nonTenWinners.length ? lowest(nonTenWinners) : lowest(winners);
      }
      if (nonTenWinners.length) return highest(nonTenWinners);
    }
    return safeLow();
  }

  // Void of lead suit
  if (config.trumpMode === "cut" && !trumpSuit) {
    // This play sets trump — cut with strength when the trick is worth it.
    const counts = {};
    for (const c of hand) counts[c.suit] = (counts[c.suit] || 0) + 1;
    const longSuit = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const longCards = hand.filter((c) => c.suit === longSuit);
    const longNonTen = longCards.filter((c) => !isTen(c));
    if (trickHasTen && !partnerWinning) {
      return longNonTen.length ? highest(longNonTen) : highest(longCards);
    }
    if (longNonTen.length) return lowest(longNonTen);
    const anyNonTen = hand.filter((c) => !isTen(c));
    return anyNonTen.length ? lowest(anyNonTen) : lowest(hand);
  }

  if (trumpActive) {
    const myTrumps = hand.filter((c) => c.suit === trumpSuit);
    if (!partnerWinning && myTrumps.length && (trickHasTen || Math.random() < 0.35)) {
      const winningTrumps = myTrumps.filter(wouldWin);
      if (winningTrumps.length) {
        const nt = winningTrumps.filter((c) => !isTen(c));
        return nt.length ? lowest(nt) : lowest(winningTrumps);
      }
    }
  }

  if (partnerWinning) {
    const tens = hand.filter(isTen);
    if (tens.length && (iAmLast || Math.random() < 0.5)) return tens[0];
  }

  const dumpPool = hand.filter((c) => !isTen(c) && (!trumpActive || c.suit !== trumpSuit));
  if (dumpPool.length) return lowest(dumpPool);
  const noTen = hand.filter((c) => !isTen(c));
  return noTen.length ? lowest(noTen) : lowest(hand);
}

module.exports = { botChooseCard, botChooseTrump };
