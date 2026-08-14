# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A real-time multiplayer card-game platform hosting two independent games behind a shared room/lobby layer:

- **Mindi (Mendikot)** — trick-taking, 4/6/8-a-side, 3-5 decks.
- **Teen Patti** — Indian 3-card betting/poker game, 3-7 players, with Muflis/AK47/Joker variants and a persistent cross-session chip wallet.

Node.js/Express + Socket.IO backend with authoritative server-side game state, vanilla JS/HTML/CSS frontend (no build step, no framework).

## Commands

- `npm start` — run the server (`node server.js`), listens on `PORT` (default 3030)
- `npm test` — runs all six test scripts in sequence: `test/simulate.js`, `test/tiebreak.js`, `test/matchend.js`, `test/teenpatti-logic.js`, `test/teenpatti-simulate.js`, `test/profiles-and-coins.js`
- Run a single test file directly, e.g. `node test/teenpatti-logic.js`
- No linter, bundler, or build step is configured — `public/` is served as static files as-is.

### Test scripts (plain Node scripts, not a test framework)

Each exits non-zero (throws or `process.exit(1)`) on failure and prints `OK`/`FAIL` lines otherwise:
- `test/simulate.js` — plays full all-bot Mindi hands across every combination of players (4/6/8), decks (3/4/5), and trump mode, asserting card/trick/ten counts stay consistent.
- `test/tiebreak.js` — unit tests for the trick-tiebreak peek logic in `game/logic.js` (`trickWinner`).
- `test/matchend.js` — verifies Mindi match-end conditions, that `nextHand` refuses after match end, and that room deletion works.
- `test/teenpatti-logic.js` — deterministic unit tests for `game/teenpatti/logic.js`'s hand evaluation/comparison: every hand category, the A-2-3-vs-Q-K-A low/high straight edge case, AK47/Joker wild substitution, three-wild self-substitution, and Muflis win-direction flipping.
- `test/teenpatti-simulate.js` — full bot-vs-bot Teen Patti tables across players 3-7 × every variant, asserting the pot is always fully distributed and no stack goes negative. Also the harness that caught the two real engine bugs described below.
- `test/profiles-and-coins.js` — profile name/photo validation (clamping, anchored data-URI format rejection, oversized-payload rejection) and the host-only `addCoins` action (host check, amount/seat validation, `tableStacks` + live-hand stack updates).

## Architecture

### Server is authoritative; client is a thin renderer

All game rules, legality checks, and state transitions happen in `game/`. The client only renders the per-player redacted view it's sent and emits intents — it never computes game logic itself.

### Multi-game structure

```
game/
  common/roomShell.js   # generic room shell shared by every game (see below)
  common/atomicWrite.js # shared tmp+rename atomic JSON write helper
  logic.js, bot.js       # Mindi pure rules + bot AI (unchanged from single-game era)
  rooms.js                # Mindi room/phase module - delegates generic bits to common/roomShell
  wallet.js               # persistent Teen Patti chip wallet (data/wallets.json)
  teenpatti/
    logic.js              # Teen Patti pure rules: deck, evaluateHand, compareHands, betting math
    bot.js                 # Teen Patti bot AI (hand-strength heuristics, not solved equity)
    rooms.js               # Teen Patti room/betting state machine - also delegates to common/roomShell
server.js                 # GAMES = {mindi, teenpatti} registry; dispatches by room.config.gameType
```

`game/common/roomShell.js` owns everything genuinely game-agnostic: the shared `rooms` Map, room-code generation/validation, disk persistence (`saveRoom`/`loadRoom`/`deleteRoom`, atomic tmp+rename), join-request/approve/reject, reconnect-by-token, bot-name pool, and a small `registerGameType(gameType, {pausablePhases})` registry so `loadRoom` knows which phases should pause the room after a server restart, without depending on either game module. Both `game/rooms.js` (Mindi) and `game/teenpatti/rooms.js` build their own phase machine and `viewFor()` on top of this shell, but re-export its generic functions unchanged — `game/rooms.js`'s exported names/signatures are untouched from the single-game era, since `test/simulate.js`/`tiebreak.js`/`matchend.js` import it directly by those names.

`server.js` picks the right module via `GAMES[room.config.gameType]` (falling back to `mindi`). Mindi keeps its original named socket events (`chooseTrump`, `playCard`, `nextHand`) calling straight into `game/rooms.js`. Teen Patti's larger, evolving action set goes through one namespaced event instead: `socket.emit("tpAction", {action, payload})`, dispatched via `TeenPatti.actions[action]` (`seeCards`/`placeBet`/`raise`/`pack`/`show`/`requestSideShow`/`respondSideShow`/`nextHand`). The bot-driving loop is likewise polymorphic: `pump(room)` branches on `gameType`, calling either `pumpMindi` (the original loop, renamed but otherwise untouched) or `TeenPatti.pump(room, ctx)` with a small `ctx` object (`broadcast`/`setTimer`/`clearTimer`/`deleteRoom`) so the Teen Patti module doesn't reach back into `server.js`'s internals.

### Teen Patti betting engine (`game/teenpatti/`)

- **Hand evaluation** (`logic.js`): `evaluateHand(cards, variant)` classifies a 3-card hand (Trail > Pure Sequence > Sequence > Color > Pair > High Card). A-2-3 is a valid sequence but ranks as the *lowest* one (Q-K-A is highest, Ace-high). For AK47 (A/K/4/7 wild) and Joker variants, it brute-forces every concrete substitution for each wild card (cheap at 3 cards/hand) and keeps the best resulting classification; three wild cards in one hand self-substitute to Trail of Aces. `compareHands` flips only the win *direction* for Muflis — category strength order never changes, only which end of it wins.
- **Betting state machine** (`rooms.js`): per-hand phases `dealing → betting → showdown → handEnd`. `currentStake` is the live blind-equivalent unit; a seen bet always costs 2× it (`liveStakeFor`/`toCall`/`nextStakeAfterAction` in `logic.js`). Side-show is eligible only between two *seen*, turn-adjacent, non-folded players (no veto-by-intervening-player in this implementation — a deliberate v1 scope cut). All-in is a simple stack cap, no side pots.
- **Anti-stall rule**: once every active seat has had one free "check" at the current stake with nothing changing, `legalActionsFor()` stops offering a plain chaal/call for that seat, forcing a raise/show/side-show/pack instead. Without this, two heads-up players (or an all-in seat that keeps getting turns) can check back and forth forever since matching an already-met stake costs nothing — this is exactly the bug `test/teenpatti-simulate.js` caught (see `checksInARow` in `rooms.js`, and the `isAllIn` skip in `nextActiveSeat`, which stops all-in seats from ever being handed a turn again).
- **Bot AI** (`bot.js`): rough hand-strength percentile bands (not exact equity) drive blind/seen choice, fold/call/raise thresholds via a pot-odds-ish comparison, and side-show request/accept heuristics, with small randomized bluff chances. Every returned decision is checked against the caller-supplied `legalActions` list before being trusted, falling back to `pack` — this guard is what makes the anti-stall rule above actually effective.

### Persistent wallet (`game/wallet.js`)

Teen Patti chip balances persist across matches/sessions, unlike Mindi's per-room `matchScore`. Identity is a client-generated `playerId` (UUID in `localStorage["player_id"]`, distinct from the per-room reconnect `token`) — a known, accepted trust limitation (no real auth), consistent with the existing token model. Balances live in a single in-memory-plus-atomic-write `data/wallets.json` map (`init`/`ensureAccount`/`debit`/`credit`/`settle`). Buy-in is debited when creating/approving into a Teen Patti room; `settleAndClose(room)` cashes each human seat's final table stack back out against its buy-in in one call, invoked when the host ends the room. Chips otherwise stay at the table across hands and disconnects — they only settle to the wallet when the room actually closes.

**Coin top-up requests** are separate from the wallet and Teen Patti-only: when a seat's `tableStacks` entry hits 0, the client shows an "ask host for more" button (`socket.emit("tpRequestCoins")`); `server.js` validates the seat is actually broke, then relays `tpCoinRequest` to *only* the host's socket (`findHostSocket(room)`, the same "look up one specific socket" pattern `approveJoin` already uses). The host's `addCoins` action (in `TeenPatti.actions`, host-token-checked like `nextHand`) is a **free grant** straight onto `tableStacks` — not funded from the host's own wallet or anyone else's. This is a deliberate design choice: a host's grants do flow through to a player's real wallet balance if they later cash out via `settleAndClose` (settlement is just `finalStack - buyIn`), which is the accepted consequence of a host choosing to gift chips in this real-money-free game, not a bug to guard against.

**Passbook (transaction ledger)**: every wallet-touching call (`debit`/`credit`/`settle`) appends a `{type, amount, balanceAfter, note, at}` entry to that player's `ledger` array in `data/wallets.json` (capped at 200 entries, same cap-and-slice pattern `room.chat` already uses). `Wallet.logActivity(playerId, {type, amount, note})` appends a passbook line *without* touching the balance (`balanceAfter: null`) — used for host coin grants, which are informational for the receiving player but never move their wallet. `getLedger(playerId)` returns most-recent-first. Client: `socket.emit("getLedger", {playerId})` powers a "Passbook" button on the home screen's profile card (`#ovPassbook` overlay, `renderPassbook()` in `client.js`) — reachable any time, not just mid-game, since it's a per-player history, not per-room state.

### Player profiles (`game/profiles.js`)

Name + an optional small photo, keyed by the same `playerId` as the wallet but shared across *both* games (unlike the wallet). Same single-file/atomic-write/load-once pattern as `wallet.js`, in `data/profiles.json`. Photos are never uploaded via a file endpoint — the browser downscales/crops to a 128×128 JPEG data URI client-side (`resizeImageToDataURL` in `client.js`) before sending it over the existing socket as `setProfile`. Server-side validation anchors the *entire* string against `^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$` (not just a prefix check) — this string gets rendered into other players' `<img>` elements, so a loose check would be an HTML-injection vector. `viewFor` in both `game/rooms.js` and `game/teenpatti/rooms.js` exposes each seat's `avatar` via `Profiles.getPhoto(seat.playerId)`; client code always sets `img.src` as a DOM property (`setSeatAvatar()` in `client.js`, reused by `teenpatti.js`) rather than interpolating the data URI into an `innerHTML` template, as defense in depth for other players' avatars even though the server already validates the format.

### Room state and persistence

- Each room is identified by a 6-char code. In-memory rooms live in a shared `rooms` Map (`game/common/roomShell.js`); every mutation calls `saveRoom()` which does an atomic write (`.tmp` + rename) to `saves/<CODE>.json`. Old saves without `config.gameType` default to `"mindi"` on load.
- `loadRoom` lazily loads from disk into memory on first access (e.g. after a server restart), marking all human seats disconnected and pausing any in-progress hand (per that game's registered `pausablePhases`) until players rejoin.
- Joining uses a two-step request/approve flow, not instant seating. Reconnection uses a per-seat `token`, not the socket id.
- Disconnect semantics differ by game: Mindi pauses the whole room on any human disconnect. Teen Patti auto-packs the disconnecting seat mid-betting-round instead (keeps the table moving), only falling back to a generic pause for the near-instantaneous dealing/showdown phases.

### Client structure (`public/`)

Single-page app with no router: `index.html` has one `<div>` per screen (`screen-home`, `screen-lobby`, `screen-pending`, `screen-game` for Mindi, `screen-teenpatti` for Teen Patti). `client.js`'s `show()`/`applyState()` toggle visibility and branch rendering based on `state.config.gameType`. `public/teenpatti.js` is a second plain `<script>` (loaded after `client.js`) holding `renderTeenPatti()` and its action-button wiring; since classic scripts don't share `const`/`let` scope across files, `client.js` explicitly does `window.socket = socket` so `teenpatti.js` can reach it, and otherwise reuses `client.js`'s plain `function`-declared helpers (`$`, `esc`, `cardHTML`, `toast`, `show`, `doSaveExit`, `openThemePicker`, `seatAngle`/`seatPos`), which are implicitly global. All rendering is a full re-render driven by the latest `state` object pushed over the `state` socket event — no client-side diffing.

## Features

### Mindi
- Real-time multiplayer for 4, 6, or 8 players (2 teams by seat parity, `seat % 2`), 3-5 decks.
- Configurable trump modes: first-cut, hidden ("Band", secretly picked, auto-revealed), open random, or no-trump.
- Match play across multiple hands to a win target, with Mendikot (all tens) and whitewash (all tricks) detection.
- Client polish: animated card dealing/playing (FLIP-style animation for your own plays), Web Audio-synthesized sound effects, 8 selectable color themes, trump-reveal overlay, last-trick recall.

### Teen Patti
- Real-time multiplayer for 3-7 players, single 52-card deck.
- Variants: Classic, Muflis (lowest hand wins), AK47 (A/K/4/7 wild), Joker (1-2 wild jokers added).
- Blind/seen betting with chaal (call), raise, pack (fold), show (heads-up), and side-show (request a private compare against the previous seen player).
- Persistent chip wallet across matches/sessions (buy-in debited on join, settled back on room close) — this is new relative to Mindi, which has no cross-match currency.

### Shared
- Bots fill empty seats or take over for a disconnected player mid-game, with tunable play speed (relaxed/normal/fast) — Mindi and Teen Patti each drive their own bot-pacing loop.
- Save/resume: game state persists to disk per room; players can reconnect via a saved token from a prior session (shown in a "resume" list) even after a server restart.
- Host-moderated join requests (request → approve/reject) and invite links (`?join=CODE`).
- In-room chat with rate limiting.
- A home-screen game selector (Mindi / Teen Patti) picks which config panel and room type `createRoom` builds.
- Player profile card on the home screen: editable name + an uploadable photo (client-resized, persisted server-side per `playerId`, shown as an avatar at every seat in both games).
- Teen Patti's "ask host for more coins" flow: a broke player can request a top-up; the host sees a small request queue and grants any amount as a free stack top-up.
- A coin passbook per player (buy-ins, cash-outs, and host top-ups, most-recent-first), viewable any time from the home screen profile card.
