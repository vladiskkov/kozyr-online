'use strict';
/**
 * Scoring.
 *
 * Places: with N players the one who goes out first gets 2·(N−1), the next 2·(N−2) … the last
 * survivor 2; the durak gets −2. A draw (everyone left at once) gives the place points only.
 *
 * Bots: if a game has bots, points are multiplied by the weakest bot's level
 * (easy ×½, medium ×1, hard ×1½), so farming easy bots is not worth much.
 *
 * Bonuses (not multiplied): exposing a cheat +1, being caught cheating −1.
 * Leaving a game early: −2 (the bot that took the seat earns nothing for you).
 */
const MULT = { easy: 0.5, medium: 1, hard: 1.5 };
const ORDER = ['easy', 'medium', 'hard'];

function multiplierFor(seats) {
  const levels = seats.filter((s) => s.kind === 'bot').map((s) => s.level);
  if (!levels.length) return 1;
  const weakest = levels.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  return MULT[weakest] ?? 1;
}

/**
 * @param game   finished Game
 * @param seats  game index → seat ({ id, kind, level, name })
 * @param leavers Map userId → seat snapshot of humans who left mid-game
 * @returns array of { id, kind, name, avatar, points, place, durak, caught, wasCaught }
 */
function scoreGame(game, seats, leavers = new Map()) {
  const n = game.players.length;
  const mult = multiplierFor(seats);
  const res = seats.map((s, i) => {
    const p = game.players[i];
    const durak = game.loser === i;
    let base = 0;
    if (durak) base = -2;
    else if (p.place) base = 2 * (n - p.place);
    return {
      id: s.id, kind: s.kind, name: s.name, avatar: s.avatar || null,
      points: Math.round(base * mult), place: p.place || null, durak, caught: 0, wasCaught: 0,
    };
  });
  for (const c of game.caughtLog || []) {
    if (res[c.by]) { res[c.by].points += 1; res[c.by].caught += 1; }
    if (res[c.cheater]) { res[c.cheater].points -= 1; res[c.cheater].wasCaught += 1; }
  }
  // humans who left: their seat was played by a bot, the result belongs to nobody;
  // the leaver gets a flat penalty
  const out = res.slice();
  for (const [, s] of leavers) {
    out.push({ id: s.id, kind: 'human', name: s.name, avatar: s.avatar || null, points: -2, place: null, durak: false, caught: 0, wasCaught: 0, left: true });
  }
  return { mult, rows: out };
}

module.exports = { scoreGame, multiplierFor, MULT };
