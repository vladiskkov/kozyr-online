'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scoreGame, multiplierFor } = require('../server/scores.js');

const fake = (places, loser, caughtLog = []) => ({
  players: places.map((place) => ({ place })), loser, events: [], caughtLog,
});
const H = (id) => ({ id, kind: 'human', name: id });
const B = (id, level) => ({ id, kind: 'bot', name: id, level });

test('2 humans: winner +2, durak −2', () => {
  const { rows } = scoreGame(fake([1, null], 1), [H('a'), H('b')]);
  assert.deepStrictEqual(rows.map((r) => r.points), [2, -2]);
});

test('4 humans: 6 / 4 / 2 / −2', () => {
  const { rows } = scoreGame(fake([2, 1, null, 3], 2), [H('a'), H('b'), H('c'), H('d')]);
  assert.deepStrictEqual(rows.map((r) => r.points), [4, 6, -2, 2]);
});

test('bots scale points by the weakest bot', () => {
  assert.strictEqual(multiplierFor([H('a'), B('x', 'hard'), B('y', 'easy')]), 0.5);
  assert.strictEqual(multiplierFor([H('a'), B('x', 'hard')]), 1.5);
  const { rows } = scoreGame(fake([1, null], 1), [H('a'), B('x', 'hard')]);
  assert.deepStrictEqual(rows.map((r) => r.points), [3, -3]);
  const easy = scoreGame(fake([1, null], 1), [H('a'), B('x', 'easy')]);
  assert.deepStrictEqual(easy.rows.map((r) => r.points), [1, -1]);
});

test('catching a cheat +1, being caught −1, draw gives place points only', () => {
  const { rows } = scoreGame(fake([1, 2, null], null, [{ by: 2, cheater: 0 }]), [H('a'), H('b'), H('c')]);
  assert.deepStrictEqual(rows.map((r) => r.points), [3, 2, 1]);
});

test('a human who left gets −2', () => {
  const leavers = new Map([['z', H('z')]]);
  const { rows } = scoreGame(fake([1, null], 1), [H('a'), B('bot', 'medium')], leavers);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.points]), [['a', 2], ['bot', -2], ['z', -2]]);
});
