/* Shared card rules — loaded by the server (require) and the browser (<script>). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SUITS = ['♠', '♣', '♦', '♥'];
  const RED = ['♦', '♥'];
  const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
  const RANK_LABEL = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };

  const rankLabel = (r) => RANK_LABEL[r] || String(r);
  const isRed = (s) => RED.includes(s);

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ s, r, id: s + r });
    return deck;
  }

  function shuffle(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Does card d beat attacking card a with the given trump suit? */
  function beats(a, d, trump) {
    if (d.s === a.s) return d.r > a.r;
    return d.s === trump && a.s !== trump;
  }

  /** Ranks currently on the table (attack and defence cards). */
  function tableRanks(table) {
    const set = new Set();
    for (const p of table) {
      set.add(p.a.r);
      if (p.d) set.add(p.d.r);
    }
    return set;
  }

  /** Can this card be thrown onto the table legally? */
  function canThrowCard(table, card) {
    return table.length === 0 || tableRanks(table).has(card.r);
  }

  /** Can this card legally transfer the attack (переводний)? */
  function canTransferCard(table, card) {
    if (!table.length || table.some((p) => p.d)) return false;
    const r = table[0].a.r;
    return table.every((p) => p.a.r === r) && card.r === r;
  }

  function sortHand(hand, trump) {
    const order = (s) => (s === trump ? 9 : SUITS.indexOf(s));
    return hand.sort((x, y) => order(x.s) - order(y.s) || x.r - y.r);
  }

  return { SUITS, RANKS, makeDeck, shuffle, beats, tableRanks, canThrowCard, canTransferCard, rankLabel, isRed, sortHand };
});
