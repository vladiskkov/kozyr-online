'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../server/game.js');
const Bots = require('../server/bots.js');

function seeded(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

function totalCards(g) {
  return g.deck.length + g.discard.length + g.players.reduce((s, p) => s + p.hand.length, 0)
    + (g.bout ? g.bout.table.reduce((s, p) => s + 1 + (p.d ? 1 : 0), 0) : 0);
}

function play(cfg, seed) {
  const rng = seeded(seed);
  const levels = ['easy', 'medium', 'hard'];
  const players = Array.from({ length: cfg.n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isBot: true, level: levels[(seed + i) % 3] }));
  const g = new Game({ players, variant: cfg.variant, throwMode: cfg.throwMode, cheat: cfg.cheat, rng });
  const mems = players.map(() => ({}));
  let steps = 0;
  while (!g.over) {
    assert.ok(++steps < 3000, 'game too long');
    assert.strictEqual(totalCards(g), 36, 'cards must be conserved');
    // shuffle who gets to act first, like real concurrency
    const order = players.map((_, i) => i).sort(() => rng() - 0.5);
    let acted = false;
    for (const i of order) {
      const a = Bots.decide(g, i, players[i].level, rng, mems[i]);
      if (!a) continue;
      const r = g.act(i, a);
      assert.ok(r.ok, `bot action failed: ${JSON.stringify(a)} → ${r.error}`);
      acted = true;
      break;
    }
    if (!acted) {
      const req = g.required();
      assert.fail('stalled, required=' + JSON.stringify(req));
    }
  }
  assert.strictEqual(totalCards(g), 36);
  return g;
}

const configs = [];
for (const n of [2, 3, 4]) for (const variant of ['podkidnoy', 'perevodnoy']) for (const throwMode of ['order', 'free']) for (const cheat of [false, true]) configs.push({ n, variant, throwMode, cheat });

for (const cfg of configs) {
  test(`bots finish games: ${JSON.stringify(cfg)}`, () => {
    let caught = 0; let falseAcc = 0;
    for (let s = 1; s <= 150; s++) {
      const g = play(cfg, s * 7919 + cfg.n);
      const outs = g.players.filter((p) => p.out).length;
      assert.ok(outs >= g.players.length - 1);
      caught += g.events.filter((e) => e.type === 'caught').length;
      falseAcc += g.events.filter((e) => e.type === 'falseAccuse').length;
    }
    if (!cfg.cheat) assert.strictEqual(caught + falseAcc, 0);
  });
}

test('throw-in must match ranks on table', () => {
  const g = new Game({ players: [{ id: 'a' }, { id: 'b' }], rng: seeded(3) });
  const att = g.bout.attacker;
  const c = g.hand(att)[0];
  assert.ok(g.act(att, { type: 'throw', card: c.id }).ok);
  const bad = g.hand(att).find((x) => x.r !== c.r);
  if (bad) assert.strictEqual(g.act(att, { type: 'throw', card: bad.id }).ok, false);
});

test('cheat is caught and cheater takes the table', () => {
  for (let s = 1; s < 200; s++) {
    const g = new Game({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], cheat: true, rng: seeded(s) });
    const att = g.bout.attacker; const def = g.bout.defender;
    const c = g.hand(att)[0];
    g.act(att, { type: 'throw', card: c.id });
    const bad = g.hand(att).find((x) => x.r !== c.r);
    if (!bad) continue;
    const before = g.hand(att).length;
    assert.ok(g.act(att, { type: 'throw', card: bad.id }).ok);
    const accuser = [0, 1, 2].find((k) => k !== att);
    assert.ok(g.act(accuser, { type: 'accuse', card: bad.id }).ok);
    assert.strictEqual(g.events.at(-1).type === 'caught' || g.events.some((e) => e.type === 'caught'), true);
    assert.ok(g.hand(att).length >= before + 1);
    assert.strictEqual(g.bout.table.length, 0);
    void def;
    return;
  }
  assert.fail('no scenario found');
});

test('false accusation costs a card', () => {
  const g = new Game({ players: [{ id: 'a' }, { id: 'b' }], cheat: true, rng: seeded(11) });
  const att = g.bout.attacker; const def = g.bout.defender;
  const c = g.hand(att)[0];
  g.act(att, { type: 'throw', card: c.id });
  const n = g.hand(def).length;
  assert.ok(g.act(def, { type: 'accuse', card: c.id }).ok);
  assert.strictEqual(g.hand(def).length, n + 1);
  assert.strictEqual(g.act(def, { type: 'accuse', card: c.id }).ok, false, 'one accusation per bout');
});

test('transfer passes defence to next player', () => {
  for (let s = 1; s < 500; s++) {
    const g = new Game({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], variant: 'perevodnoy', rng: seeded(s) });
    const att = g.bout.attacker; const def = g.bout.defender;
    const c = g.hand(att)[0];
    const same = g.hand(def).find((x) => x.r === c.r);
    if (!same) continue;
    g.act(att, { type: 'throw', card: c.id });
    assert.ok(g.act(def, { type: 'transfer', card: same.id }).ok);
    assert.strictEqual(g.bout.attacker, def);
    assert.strictEqual(g.bout.defender, (def + 1) % 3);
    return;
  }
  assert.fail('no scenario found');
});
