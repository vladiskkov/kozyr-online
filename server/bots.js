'use strict';
/**
 * Bot brains. decide(game, i, mem) returns an action for player i, or null when the bot
 * has nothing it wants to do right now. If the game is waiting on the bot, it always
 * returns an action, so a game never stalls.
 *
 * Levels:
 *  easy   — plays legal but careless moves, wastes trumps, often takes
 *  medium — cheapest cards first, saves trumps, sensible throw-ins
 *  hard   — medium plus endgame pressure, smart transfers, counts cards
 */
const Rules = require('../public/rules.js');

const CHEAT_CHANCE = { easy: 0.06, medium: 0.12, hard: 0.2 };
const SPOT_CHANCE = { easy: 0.35, medium: 0.65, hard: 0.9 };

function cost(g, c) { return c.r + (c.s === g.trump ? 20 : 0); }
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function cheapest(g, cards) { return [...cards].sort((x, y) => cost(g, x) - cost(g, y))[0]; }

/** Greedy plan: cheapest card for each unbeaten attack, hardest attacks first. */
function planDefence(g, hand, table) {
  const targets = table.map((p, idx) => ({ p, idx })).filter((t) => !t.p.d)
    .sort((x, y) => cost(g, y.p.a) - cost(g, x.p.a));
  const used = new Set(); const plan = [];
  for (const t of targets) {
    const opts = hand.filter((c) => !used.has(c.id) && Rules.beats(t.p.a, c, g.trump)).sort((x, y) => cost(g, x) - cost(g, y));
    if (!opts.length) return null;
    used.add(opts[0].id);
    plan.push({ target: t.idx, card: opts[0] });
  }
  return plan;
}

function decideDefence(g, i, level, rng, mem) {
  const b = g.bout; const hand = g.hand(i);
  // transfer?
  if (g.canTransferNow(i)) {
    const tr = hand.filter((c) => Rules.canTransferCard(b.table, c));
    if (tr.length) {
      const c = cheapest(g, tr);
      const isTrump = c.s === g.trump;
      if (level === 'easy' && rng() < 0.5) return { type: 'transfer', card: c.id };
      if (level === 'medium' && (!isTrump || g.deck.length === 0)) return { type: 'transfer', card: c.id };
      if (level === 'hard') {
        const plan = planDefence(g, hand, b.table);
        const planCost = plan ? plan.reduce((s, x) => s + cost(g, x.card), 0) : Infinity;
        if (!isTrump || g.deck.length < 4 || planCost > 40) return { type: 'transfer', card: c.id };
      }
    }
  }
  const plan = planDefence(g, hand, b.table);
  if (!plan) {
    // cheat: pretend to beat one card with a cheap card
    if (g.cheat && !mem.cheatedThisBout && rng() < CHEAT_CHANCE[level] * 2 && hand.length) {
      const t = b.table.findIndex((p) => !p.d);
      mem.cheatedThisBout = true;
      return { type: 'defend', card: cheapest(g, hand).id, target: t };
    }
    return { type: 'take' };
  }
  if (level === 'easy') {
    const t = plan[Math.floor(rng() * plan.length)];
    const opts = hand.filter((c) => Rules.beats(b.table[t.target].a, c, g.trump));
    if (rng() < 0.15) return { type: 'take' };
    return { type: 'defend', card: pick(opts, rng).id, target: t.target };
  }
  // don't burn high trumps on cheap cards early in the game
  const total = plan.reduce((s, x) => s + cost(g, x.card), 0);
  const highTrumps = plan.filter((x) => x.card.s === g.trump && x.card.r >= 12).length;
  if (g.deck.length > 10 && highTrumps > 0 && b.table.length <= 2 && total > 32 && rng() < (level === 'hard' ? 0.8 : 0.6)) {
    return { type: 'take' };
  }
  return { type: 'defend', card: plan[0].card.id, target: plan[0].target };
}

function decideAttack(g, i, level, rng, mem) {
  const b = g.bout; const hand = g.hand(i);
  const mustDecide = g.waitingAttackers().includes(i);
  if (!g.canThrowNow(i)) return mustDecide ? { type: 'pass' } : null;

  if (!b.table.length) {
    if (level === 'easy') {
      const plain = hand.filter((c) => c.s !== g.trump);
      return { type: 'throw', card: pick(plain.length ? plain : hand, rng).id };
    }
    const counts = {}; hand.forEach((c) => { counts[c.r] = (counts[c.r] || 0) + 1; });
    const score = (c) => cost(g, c) - (counts[c.r] > 1 ? (level === 'hard' ? 3 : 1.5) : 0);
    const c = [...hand].sort((x, y) => score(x) - score(y))[0];
    return { type: 'throw', card: c.id };
  }

  const legal = hand.filter((c) => Rules.canThrowCard(b.table, c));
  const defCards = g.hand(b.defender).length;
  const endgame = g.deck.length === 0;
  let pool;
  if (level === 'easy') pool = rng() < 0.6 ? legal : [];
  else if (level === 'medium') pool = legal.filter((c) => endgame || (c.s !== g.trump && c.r <= 11));
  else pool = legal.filter((c) => endgame || defCards <= 3 || b.taking || (c.s !== g.trump && c.r <= 12));
  // when the defender is taking, unload junk but keep strong cards
  if (b.taking && level !== 'easy') pool = pool.filter((c) => endgame || c.s !== g.trump);

  if (pool.length) return { type: 'throw', card: cheapest(g, pool).id };

  if (g.cheat && !mem.cheatedThisBout && !b.taking && hand.length && rng() < CHEAT_CHANCE[level]) {
    const junk = hand.filter((c) => c.s !== g.trump && !Rules.canThrowCard(b.table, c));
    if (junk.length) { mem.cheatedThisBout = true; return { type: 'throw', card: cheapest(g, junk).id }; }
  }
  return mustDecide ? { type: 'pass' } : null;
}

/** Bot reaction to cheats on the table. Returns an accuse action or null. */
function decideAccuse(g, i, level, rng, mem) {
  if (!g.cheat || g.over) return null;
  const b = g.bout;
  if (b.accused.has(i)) return null;
  mem.seen = mem.seen || new Set();
  for (const p of b.table) {
    for (const [card, by, flag] of [[p.a, p.aBy, p.aCheat], [p.d, p.dBy, p.dCheat]]) {
      if (!card || by === i || mem.seen.has(card.id)) continue;
      mem.seen.add(card.id);
      if (flag && rng() < SPOT_CHANCE[level]) return { type: 'accuse', card: card.id };
    }
  }
  return null;
}

function decide(g, i, level = 'medium', rng = Math.random, mem = {}) {
  if (g.over || !g.bout) return null;
  const b = g.bout;
  if (mem.boutKey !== b) { mem.boutKey = b; mem.cheatedThisBout = false; }
  const acc = decideAccuse(g, i, level, rng, mem);
  if (acc) return acc;
  if (i === b.defender) {
    if (!b.taking && g.unbeatenCount() > 0) return decideDefence(g, i, level, rng, mem);
    return null;
  }
  if (g.players[i].out) return null;
  return decideAttack(g, i, level, rng, mem);
}

/** What happens when a human runs out of time: the safest boring move. */
function autoAction(g, i) {
  const b = g.bout;
  if (i === b.defender) return { type: 'take' };
  if (!b.table.length) return { type: 'throw', card: cheapest(g, g.hand(i)).id };
  return { type: 'pass' };
}

module.exports = { decide, autoAction };
