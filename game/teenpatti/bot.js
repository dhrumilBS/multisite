// Bot AI for Teen Patti - heuristic, not solved: rough hand-strength
// percentile bands drive blind/seen choice, fold/call/raise thresholds, and
// side-show requests/responses, with small randomized bluff/peek chances so
// play isn't perfectly predictable (same spirit as ../bot.js's Mindi AI).
"use strict";

const TP = require("./logic");

// Rough cumulative "beats this fraction of hands" bands per category,
// approximating real 3-card-hand combinatorics closely enough for a
// heuristic bot (not exact-equity solved).
function categoryBand(category) {
  switch (category) {
    case TP.TRAIL: return [0.999, 1.0];
    case TP.PURE_SEQUENCE: return [0.997, 0.999];
    case TP.SEQUENCE: return [0.964, 0.997];
    case TP.COLOR: return [0.914, 0.964];
    case TP.PAIR: return [0.744, 0.914];
    default: return [0, 0.744];
  }
}

function handPercentile(evaluated) {
  const [lo, hi] = categoryBand(evaluated.category);
  const top = evaluated.tiebreakRanks && evaluated.tiebreakRanks.length ? evaluated.tiebreakRanks[0] : 2;
  const norm = Math.max(0, Math.min(1, (top - 2) / 12));
  return lo + (hi - lo) * norm;
}

// Win-strength estimate: under Muflis the lowest hand wins, so a numerically
// weak hand is actually the strong one there.
function winStrength(evaluated, variant) {
  const p = handPercentile(evaluated);
  return variant && variant.muflis ? 1 - p : p;
}

// botDecideAction(seat, game, config, legalActions) -> {type}
// `legalActions` is the same pre-filtered list the room module hands to a
// human player's client (see legalActionsFor in rooms.js) - the bot only
// ever picks from what's actually legal right now. The final guard at the
// bottom means a bug above can never produce an illegal action: the room
// module's own anti-stall rule (which drops chaal once a round has checked
// all the way around) relies on bots actually respecting `legalActions`.
function botDecideAction(seat, game, config, legalActions) {
  if (!legalActions || !legalActions.length) return { type: "pack" };
  const s = game.seats[seat];
  const evaluated = TP.evaluateHand(s.cards, game.variant);
  const strength = winStrength(evaluated, game.variant);
  const pot = game.pot;
  const currentStake = game.currentStake;

  let decision = null;

  if (legalActions.includes("see")) {
    // Blind play is half price - stay blind a while unless it's time to peek.
    const shouldPeek = Math.random() < 0.4;
    if (!shouldPeek && Math.random() < 0.05 && legalActions.includes("blind-raise")) decision = { type: "blind-raise" };
    else if (!shouldPeek && legalActions.includes("blind-chaal")) decision = { type: "blind-chaal" };
    else decision = { type: "see" };
  } else if (legalActions.includes("show")) {
    // Heads-up: once bets are matched, checking back and forth costs nothing
    // and resolves nothing - actually resolve it instead of stalling.
    if (strength >= 0.9 && legalActions.includes("seen-raise") && Math.random() < 0.5) decision = { type: "seen-raise" };
    else if (strength < 0.3 && Math.random() < 0.6) decision = { type: "pack" };
    else decision = { type: "show" };
  } else {
    const costToCall = TP.toCall(s, currentStake);
    const impliedOdds = costToCall <= 0 ? 0 : costToCall / (pot + costToCall);

    if (strength >= 0.95) {
      if (legalActions.includes("seen-raise") && Math.random() < 0.8) decision = { type: "seen-raise" };
      else if (legalActions.includes("seen-chaal")) decision = { type: "seen-chaal" };
    } else if (strength >= 0.75) {
      if (legalActions.includes("side-show-request") && strength < 0.85 && Math.random() < 0.5) {
        decision = { type: "side-show-request" };
      } else if (Math.random() < 0.4 && legalActions.includes("seen-raise")) decision = { type: "seen-raise" };
      else if (legalActions.includes("seen-chaal")) decision = { type: "seen-chaal" };
    } else if (strength >= 0.4) {
      if (legalActions.includes("side-show-request") && Math.random() < 0.4) decision = { type: "side-show-request" };
      else if (costToCall === 0 && legalActions.includes("seen-raise") && Math.random() < 0.5) decision = { type: "seen-raise" };
      else if (strength > impliedOdds && legalActions.includes("seen-chaal")) decision = { type: "seen-chaal" };
    } else {
      // Weak hand: fold by default, with a small bluff chance.
      if (Math.random() < 0.08 && legalActions.includes("seen-raise")) decision = { type: "seen-raise" };
      else if (Math.random() < 0.08 && legalActions.includes("seen-chaal")) decision = { type: "seen-chaal" };
    }
  }

  if (!decision || !legalActions.includes(decision.type)) {
    decision = legalActions.includes("pack") ? { type: "pack" } : { type: legalActions[0] };
  }
  return decision;
}

function decideSideShowResponse(seat, game) {
  const s = game.seats[seat];
  const evaluated = TP.evaluateHand(s.cards, game.variant);
  const strength = winStrength(evaluated, game.variant);
  if (strength < 0.4) return Math.random() < 0.1;
  if (strength >= 0.5) return Math.random() > 0.1;
  return Math.random() < 0.5;
}

module.exports = { botDecideAction, decideSideShowResponse, handPercentile, winStrength };
