'use strict';
/**
 * Durak game engine (server-authoritative).
 *
 * variant:   'podkidnoy' | 'perevodnoy'
 * throwMode: 'order' — the main attacker throws first, then the others clockwise;
 *            'free'  — every non-defender throws whenever they want (first come, first served).
 * cheat:     illegal cards are accepted but flagged; any other player can expose them
 *            while they are still on the table.
 */
const Rules = require('../public/rules.js');

const HAND = 6;
const MAX_TABLE = 6;

class GameError extends Error {}

class Game {
  constructor({ players, variant = 'podkidnoy', throwMode = 'order', cheat = false, rng = Math.random }) {
    if (players.length < 2 || players.length > 4) throw new Error('2–4 players');
    this.variant = variant === 'perevodnoy' ? 'perevodnoy' : 'podkidnoy';
    this.throwMode = throwMode === 'free' ? 'free' : 'order';
    this.cheat = !!cheat;
    this.rng = rng;
    this.players = players.map((p) => ({ ...p, hand: [], out: false, place: null }));
    this.deck = [];
    this.discard = [];
    this.bout = null;
    this.over = false;
    this.loser = null; // index of the durak, null on a draw
    this.places = 0;
    this.version = 0;
    this.events = [];
    this.eventSeq = 0;
    this.lastBout = null; // summary of the previous bout for the UI
    this._start();
  }

  /* ---------------- setup ---------------- */
  _start() {
    this.deck = Rules.shuffle(Rules.makeDeck(), this.rng);
    this.trumpCard = this.deck[0];
    this.trump = this.trumpCard.s;
    for (let k = 0; k < HAND; k++) for (const p of this.players) p.hand.push(this.deck.pop());
    this.players.forEach((p) => Rules.sortHand(p.hand, this.trump));
    let first = 0;
    let low = 99;
    this.players.forEach((p, i) => {
      for (const c of p.hand) if (c.s === this.trump && c.r < low) { low = c.r; first = i; }
    });
    if (low === 99) first = Math.floor(this.rng() * this.players.length);
    this._event('start', first, { trump: this.trump, lowTrump: low === 99 ? null : low });
    this._startBout(first);
  }

  /* ---------------- helpers ---------------- */
  hand(i) { return this.players[i].hand; }
  inGame(i) { const p = this.players[i]; return !p.out && (p.hand.length > 0 || this.deck.length > 0); }
  nextInGame(i) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (this.inGame(j)) return j; }
    return -1;
  }

  /** Non-defenders still in the game, clockwise from the main attacker. */
  attackers() {
    const b = this.bout; const n = this.players.length; const list = [];
    for (let k = 0; k < n; k++) {
      const j = (b.attacker + k) % n;
      if (j !== b.defender && !this.players[j].out && (this.hand(j).length > 0 || this.deck.length > 0)) list.push(j);
    }
    return list;
  }

  unbeatenCount() { return this.bout.table.filter((p) => !p.d).length; }
  roomForThrow() { return this.bout.table.length < this.bout.limit; }
  hasLegalThrow(i) { return this.hand(i).some((c) => Rules.canThrowCard(this.bout.table, c)); }
  _wantsTurn(i) {
    return !this.bout.passed.has(i) && this.hand(i).length > 0 && (this.cheat || this.hasLegalThrow(i));
  }

  /** In 'order' mode: who holds the right to throw right now (-1 = nobody). */
  currentThrower() {
    const list = this.attackers();
    if (!list.length) return -1;
    let s = list.indexOf(this.bout.ptr);
    if (s < 0) s = 0;
    for (let k = 0; k < list.length; k++) {
      const j = list[(s + k) % list.length];
      if (this._wantsTurn(j)) return j;
    }
    return -1;
  }

  /** Attackers whose decision (throw or pass) is still pending. */
  waitingAttackers() {
    const b = this.bout;
    if (!b.table.length) return [b.attacker];
    if (!this.roomForThrow()) return [];
    if (this.throwMode === 'order') { const t = this.currentThrower(); return t >= 0 ? [t] : []; }
    return this.attackers().filter((j) => this._wantsTurn(j));
  }

  canThrowNow(i) {
    if (this.over || !this.bout) return false;
    const b = this.bout;
    if (!this.hand(i).length || i === b.defender) return false;
    if (!b.table.length) return i === b.attacker;
    if (!this.attackers().includes(i) || !this.roomForThrow() || b.passed.has(i)) return false;
    if (!this.cheat && !this.hasLegalThrow(i)) return false;
    if (this.throwMode === 'order') return this.currentThrower() === i;
    return true;
  }

  canTransferNow(i) {
    const b = this.bout;
    if (this.over || this.variant !== 'perevodnoy' || i !== b.defender || b.taking) return false;
    if (!b.table.length || b.table.some((p) => p.d)) return false;
    const nd = this.nextInGame(i);
    return nd >= 0 && nd !== i && this.hand(nd).length >= b.table.length + 1 && b.table.length + 1 <= MAX_TABLE;
  }

  /** Players the game is waiting on (used for turn timers and bot scheduling). */
  required() {
    if (this.over) return [];
    const b = this.bout;
    if (b.table.length && !b.taking && this.unbeatenCount() > 0) return [b.defender];
    return this.waitingAttackers();
  }

  /* ---------------- bout lifecycle ---------------- */
  _startBout(att) {
    const def = this.nextInGame(att);
    this.bout = {
      attacker: att, defender: def, table: [], taking: false,
      passed: new Set(), ptr: att, accused: new Set(),
      limit: Math.min(MAX_TABLE, this.hand(def).length),
    };
  }

  _after() {
    const b = this.bout;
    if (!this.over && b.table.length && (b.taking || this.unbeatenCount() === 0) && this.waitingAttackers().length === 0) {
      this._endBout(b.taking);
    }
    this.version++;
  }

  _endBout(taken, opts = {}) {
    const b = this.bout;
    const cards = b.table.flatMap((p) => (p.d ? [p.a, p.d] : [p.a]));
    if (taken) this.hand(b.defender).push(...cards);
    else this.discard.push(...cards);
    this.lastBout = { taken, defender: b.defender, count: cards.length, caught: opts.caught ?? null };
    if (!opts.caught) this._event(taken ? 'took' : 'beaten', b.defender, { count: cards.length });

    // draw: main attacker, other attackers clockwise, defender last
    const n = this.players.length; const order = [];
    for (let k = 0; k < n; k++) { const j = (b.attacker + k) % n; if (j !== b.defender && !this.players[j].out) order.push(j); }
    if (!this.players[b.defender].out) order.push(b.defender);
    for (const j of order) { const h = this.hand(j); while (h.length < HAND && this.deck.length) h.push(this.deck.pop()); }
    this.players.forEach((p) => Rules.sortHand(p.hand, this.trump));

    for (let i = 0; i < n; i++) {
      const p = this.players[i];
      if (!p.out && p.hand.length === 0 && this.deck.length === 0) { p.out = true; p.place = ++this.places; this._event('out', i, { place: p.place }); }
    }
    const left = this.players.map((p, i) => (p.out ? -1 : i)).filter((i) => i >= 0);
    if (left.length <= 1) {
      this.over = true;
      this.loser = left.length ? left[0] : null;
      this.bout.table = [];
      this._event('over', this.loser, {});
      return;
    }
    let next;
    if (taken) next = this.nextInGame(b.defender);
    else next = this.inGame(b.defender) ? b.defender : this.nextInGame(b.defender);
    this._startBout(next);
  }

  _event(type, by, data) {
    this.events.push({ id: ++this.eventSeq, type, by, ...data });
    if (this.events.length > 30) this.events.shift();
  }

  _takeCard(i, cardId) {
    const h = this.hand(i);
    const k = h.findIndex((c) => c.id === cardId);
    if (k < 0) throw new GameError('Цієї карти немає у вас на руці');
    return h.splice(k, 1)[0];
  }
  _peekCard(i, cardId) {
    const c = this.hand(i).find((x) => x.id === cardId);
    if (!c) throw new GameError('Цієї карти немає у вас на руці');
    return c;
  }

  /* ---------------- actions ---------------- */
  act(i, action) {
    try {
      if (this.over) throw new GameError('Гру завершено');
      switch (action && action.type) {
        case 'throw': this.throwCard(i, action.card); break;
        case 'defend': this.defend(i, action.card, action.target); break;
        case 'transfer': this.transfer(i, action.card); break;
        case 'take': this.take(i); break;
        case 'pass': this.pass(i); break;
        case 'accuse': this.accuse(i, action.card); break;
        default: throw new GameError('Невідома дія');
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof GameError) return { ok: false, error: e.message };
      throw e;
    }
  }

  throwCard(i, cardId) {
    if (!this.canThrowNow(i)) throw new GameError('Зараз ви не можете підкидати');
    const card = this._peekCard(i, cardId);
    const legal = Rules.canThrowCard(this.bout.table, card);
    if (!legal && !this.cheat) throw new GameError('Підкидати можна лише карти номіналів, що є на столі');
    this._takeCard(i, cardId);
    const b = this.bout;
    b.table.push({ a: card, aBy: i, aCheat: !legal, d: null, dBy: null, dCheat: false });
    b.passed.clear();
    b.ptr = i;
    this._after();
  }

  defend(i, cardId, target) {
    const b = this.bout;
    if (i !== b.defender || b.taking) throw new GameError('Зараз ви не відбиваєтесь');
    const pair = b.table[target];
    if (!pair || pair.d) throw new GameError('Оберіть карту на столі, яку треба побити');
    const card = this._peekCard(i, cardId);
    const legal = Rules.beats(pair.a, card, this.trump);
    if (!legal && !this.cheat) throw new GameError('Ця карта не б\'є атакуючу');
    this._takeCard(i, cardId);
    pair.d = card; pair.dBy = i; pair.dCheat = !legal;
    b.passed.clear();
    b.ptr = b.attacker;
    this._after();
  }

  transfer(i, cardId) {
    if (!this.canTransferNow(i)) throw new GameError('Перевести зараз не можна');
    const b = this.bout;
    const card = this._peekCard(i, cardId);
    const legal = Rules.canTransferCard(b.table, card);
    if (!legal && !this.cheat) throw new GameError('Переводити можна лише картою того самого номіналу');
    this._takeCard(i, cardId);
    const nd = this.nextInGame(i);
    b.table.push({ a: card, aBy: i, aCheat: !legal, d: null, dBy: null, dCheat: false, transfer: true });
    b.attacker = i; b.defender = nd; b.ptr = i; b.passed.clear();
    b.limit = Math.min(MAX_TABLE, this.hand(nd).length);
    this._event('transfer', i, { to: nd });
    this._after();
  }

  take(i) {
    const b = this.bout;
    if (i !== b.defender || b.taking || !this.unbeatenCount()) throw new GameError('Зараз не можна взяти карти');
    b.taking = true; b.passed.clear(); b.ptr = b.attacker;
    this._event('taking', i, {});
    this._after();
  }

  pass(i) {
    const b = this.bout;
    if (!b.table.length || i === b.defender || !this.attackers().includes(i)) throw new GameError('Зараз не можна пасувати');
    b.passed.add(i);
    if (this.throwMode === 'order' && b.ptr === i) {
      const list = this.attackers(); const k = list.indexOf(i);
      b.ptr = list[(k + 1) % list.length];
    }
    this._after();
  }

  /** Expose a card on the table as a cheat. */
  accuse(i, cardId) {
    if (!this.cheat) throw new GameError('Махлювання в цій грі вимкнене');
    const b = this.bout;
    if (b.accused.has(i)) throw new GameError('Ви вже викривали в цьому відбої');
    let by = -1; let cheated = false;
    for (const p of b.table) {
      if (p.a.id === cardId) { by = p.aBy; cheated = p.aCheat; }
      if (p.d && p.d.id === cardId) { by = p.dBy; cheated = p.dCheat; }
    }
    if (by < 0) throw new GameError('Цієї карти немає на столі');
    if (by === i) throw new GameError('Не можна викривати самого себе');
    b.accused.add(i);
    if (cheated) {
      const cards = b.table.flatMap((p) => (p.d ? [p.a, p.d] : [p.a]));
      this._event('caught', i, { cheater: by, card: cardId, count: cards.length });
      const wasDefender = by === b.defender;
      b.table = [];
      this.hand(by).push(...cards);
      // cheater takes everything; the bout ends as if the defender took (cheater = defender) or beat it off
      this._endBoutAfterCatch(wasDefender, by, cards.length);
    } else {
      let penalty = null;
      if (this.deck.length) penalty = this.deck.pop();
      else if (this.discard.length) penalty = this.discard.splice(Math.floor(this.rng() * this.discard.length), 1)[0];
      if (penalty) { this.hand(i).push(penalty); Rules.sortHand(this.hand(i), this.trump); }
      this._event('falseAccuse', i, { accused: by, card: cardId, penalty: !!penalty });
    }
    this._after();
  }

  _endBoutAfterCatch(wasDefender, cheater, count) {
    // table already emptied into the cheater's hand
    this._endBout(wasDefender, { caught: { cheater, count } });
  }

  /* ---------------- views ---------------- */
  publicPair(p) {
    return { a: p.a, aBy: p.aBy, d: p.d, dBy: p.dBy, transfer: !!p.transfer };
  }

  view(i) {
    const b = this.bout;
    const req = this.required();
    const me = i >= 0 ? this.players[i] : null;
    const isAtt = me && b && this.attackers().includes(i);
    const actions = me && !this.over ? {
      throw: this.canThrowNow(i),
      defend: i === b.defender && !b.taking && this.unbeatenCount() > 0,
      transfer: this.canTransferNow(i),
      take: i === b.defender && !b.taking && this.unbeatenCount() > 0,
      pass: !!isAtt && b.table.length > 0 && !b.passed.has(i) && this.hand(i).length > 0,
      accuse: this.cheat && !b.accused.has(i) && b.table.some((p) => p.aBy !== i || (p.d && p.dBy !== i)),
    } : null;
    return {
      version: this.version,
      variant: this.variant, throwMode: this.throwMode, cheat: this.cheat,
      trump: this.trump, trumpCard: this.trumpCard, deck: this.deck.length, discard: this.discard.length,
      over: this.over, loser: this.loser,
      me: i,
      hand: me ? me.hand : [],
      players: this.players.map((p, k) => ({
        cards: p.hand.length, out: p.out, place: p.place,
        passed: b ? b.passed.has(k) : false,
      })),
      bout: b ? {
        attacker: b.attacker, defender: b.defender, taking: b.taking, limit: b.limit,
        table: b.table.map((p) => this.publicPair(p)),
        accused: [...b.accused],
      } : null,
      required: req,
      actions,
      events: this.events.slice(-8),
      lastBout: this.lastBout,
    };
  }
}

module.exports = { Game, GameError };
