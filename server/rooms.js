'use strict';
const crypto = require('crypto');
const { Game } = require('./game.js');
const Bots = require('./bots.js');
const { scoreGame } = require('./scores.js');

const isRanked = (id) => typeof id === 'string' && id.startsWith('g_'); // Google accounts only

const TURN_MS = 30000;
const TURN_MS_AWAY = 8000;
const BOT_MIN = 650;
const BOT_MAX = 1300;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Тарас', 'Оксана', 'Мирон', 'Леся', 'Богдан', 'Соломія', 'Остап', 'Ярина'];
const LEVELS = ['easy', 'medium', 'hard'];

function normSettings(s = {}, prev = {}) {
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return {
    variant: pick(s.variant, ['podkidnoy', 'perevodnoy'], prev.variant || 'podkidnoy'),
    throwMode: pick(s.throwMode, ['order', 'free'], prev.throwMode || 'order'),
    cheat: typeof s.cheat === 'boolean' ? s.cheat : !!prev.cheat,
    size: pick(Number(s.size), [2, 3, 4], prev.size || 2),
    botLevel: pick(s.botLevel, LEVELS, prev.botLevel || 'medium'),
  };
}

class Room {
  constructor(manager, code, host, settings, solo) {
    this.manager = manager;
    this.code = code;
    this.solo = solo;
    this.hostId = host.id;
    this.settings = normSettings(settings);
    this.seats = Array(this.settings.size).fill(null);
    this.seats[0] = this._human(host);
    this.sockets = new Map(); // userId -> Set<socket>
    this.status = 'lobby';
    this.game = null;
    this.gameSeats = []; // game player index -> seat snapshot
    this.mems = [];
    this.botTimer = null;
    this.turnTimer = null;
    this.deadline = null;
    this.board = new Map(); // seat id -> room score row
    this.lastScores = null; // rows of the last finished game
    this.leavers = new Map(); // humans who left the current game
    this.games = 0;
    this.touched = Date.now();
    if (solo) {
      for (let i = 1; i < this.seats.length; i++) this.seats[i] = this._bot(this.settings.botLevel);
      this.start(host.id);
    }
  }

  _human(u) { return { kind: 'human', id: u.id, name: u.name, avatar: u.avatar || null }; }
  _bot(level) {
    const used = new Set(this.seats.filter(Boolean).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Бот';
    return { kind: 'bot', id: 'bot_' + crypto.randomBytes(4).toString('hex'), name, level };
  }

  isConnected(userId) { const s = this.sockets.get(userId); return !!(s && s.size); }
  seatOf(userId) { return this.seats.findIndex((s) => s && s.id === userId); }
  gameIndexOf(userId) { return this.gameSeats.findIndex((s) => s.id === userId); }

  /* ---------- membership ---------- */
  attach(socket) {
    const uid = socket.user.id;
    if (!this.sockets.has(uid)) this.sockets.set(uid, new Set());
    this.sockets.get(uid).add(socket);
    socket.join(this.code);
    this.touched = Date.now();
  }

  detach(socket) {
    const set = this.sockets.get(socket.user.id);
    if (set) { set.delete(socket); if (!set.size) this.sockets.delete(socket.user.id); }
    socket.leave(this.code);
    if (this.status === 'playing') this._schedule(); // shorter timer for the absent player
    this.broadcast();
  }

  join(user) {
    const seat = this.seatOf(user.id);
    if (seat >= 0) return { ok: true };
    if (this.solo) return { ok: false, error: 'Це одиночна гра з ботами' };
    if (this.status === 'playing') return { ok: false, error: 'Партія вже йде. Попросіть господаря кімнати почати нову, коли ця закінчиться.' };
    const free = this.seats.findIndex((s) => !s);
    if (free < 0) return { ok: false, error: 'У кімнаті немає вільних місць' };
    this.seats[free] = this._human(user);
    this.broadcast();
    return { ok: true };
  }

  leave(userId) {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    if (this.status === 'playing' && this.game && !this.game.over) {
      // a bot takes over the seat so the others can finish
      const gi = this.gameIndexOf(userId);
      const leaver = { ...this.seats[seat] };
      this.leavers.set(userId, leaver);
      // if this empties the room the game never finishes, so book the penalty now
      if (!this.seats.some((x, k) => k !== seat && x && x.kind === 'human')) this._recordGlobal([{ ...leaver, kind: 'human', points: -2, place: null, durak: false, caught: 0 }]);
      const bot = this._bot('medium');
      bot.name = `${bot.name} (замість ${this.seats[seat].name})`;
      this.seats[seat] = bot;
      if (gi >= 0) { this.gameSeats[gi] = bot; this.mems[gi] = {}; }
      this._schedule();
    } else {
      this.seats[seat] = null;
    }
    if (this.hostId === userId) {
      const next = this.seats.find((s) => s && s.kind === 'human');
      if (next) this.hostId = next.id;
    }
    if (!this.seats.some((s) => s && s.kind === 'human')) { this.manager.remove(this.code); return; }
    this.broadcast();
  }

  /* ---------- host controls ---------- */
  _host(userId) { if (userId !== this.hostId) throw new Error('Це може зробити лише господар кімнати'); }

  setSettings(userId, s) {
    this._host(userId);
    if (this.status === 'playing') throw new Error('Налаштування можна змінити після партії');
    const next = normSettings(s, this.settings);
    if (next.size < this.seats.length) {
      const taken = this.seats.filter(Boolean);
      if (taken.length > next.size) throw new Error('Спершу звільніть місця');
      this.seats = [...taken, ...Array(next.size - taken.length).fill(null)];
    } else if (next.size > this.seats.length) {
      this.seats = [...this.seats, ...Array(next.size - this.seats.length).fill(null)];
    }
    this.settings = next;
    this.broadcast();
  }

  addBot(userId, level) {
    this._host(userId);
    if (this.status === 'playing') throw new Error('Партія вже йде');
    const free = this.seats.findIndex((s) => !s);
    if (free < 0) throw new Error('Немає вільних місць');
    this.seats[free] = this._bot(LEVELS.includes(level) ? level : this.settings.botLevel);
    this.broadcast();
  }

  removeSeat(userId, idx) {
    this._host(userId);
    if (this.status === 'playing') throw new Error('Партія вже йде');
    const s = this.seats[idx];
    if (!s || s.id === this.hostId) return;
    this.seats[idx] = null;
    if (s.kind === 'human') {
      for (const sock of this.sockets.get(s.id) || []) sock.emit('kicked', { code: this.code });
    }
    this.broadcast();
  }

  start(userId) {
    this._host(userId);
    if (this.status === 'playing' && this.game && !this.game.over) throw new Error('Партія вже йде');
    const seats = this.seats.filter(Boolean);
    if (seats.length < 2) throw new Error('Потрібно щонайменше 2 гравці. Додайте бота або запросіть друга.');
    this.gameSeats = seats.map((s) => ({ ...s }));
    this.mems = seats.map(() => ({}));
    this.game = new Game({
      players: seats.map((s) => ({ id: s.id, name: s.name, isBot: s.kind === 'bot', level: s.level })),
      variant: this.settings.variant, throwMode: this.settings.throwMode, cheat: this.settings.cheat,
    });
    this.status = 'playing';
    this.leavers = new Map();
    this.lastScores = null;
    this.games++;
    this._schedule();
    this.broadcast();
  }

  /* ---------- gameplay ---------- */
  act(userId, action) {
    if (!this.game || this.status !== 'playing') throw new Error('Партія не йде');
    const gi = this.gameIndexOf(userId);
    if (gi < 0) throw new Error('Ви не граєте в цій партії');
    const a = sanitizeAction(action);
    const r = this.game.act(gi, a);
    if (!r.ok) throw new Error(r.error);
    this._changed();
  }

  _changed() {
    this.touched = Date.now();
    if (this.game.over) this._finish();
    else this._schedule();
    this.broadcast();
  }

  _finish() {
    clearTimeout(this.botTimer); clearTimeout(this.turnTimer);
    this.deadline = null;
    this.status = 'finished';
    const { mult, rows } = scoreGame(this.game, this.gameSeats, this.leavers);
    this.lastScores = { mult, rows };
    for (const r of rows) {
      const b = this.board.get(r.id) || { id: r.id, kind: r.kind, name: r.name, avatar: r.avatar, points: 0, games: 0, wins: 0, duraks: 0 };
      b.name = r.name; b.avatar = r.avatar;
      b.points += r.points; b.games += 1; b.wins += r.place === 1 ? 1 : 0; b.duraks += r.durak ? 1 : 0;
      this.board.set(r.id, b);
    }
    // humans whose seat was taken over by a bot don't get the bot's result
    this._recordGlobal(rows.filter((r) => r.kind === 'human' && (r.left || !this.leavers.has(r.id))));
  }

  _recordGlobal(rows) {
    const ranked = rows.filter((r) => isRanked(r.id));
    if (!ranked.length || !this.manager.store) return;
    this.manager.store.record(ranked).catch((e) => console.error('[db] record failed', e.message));
  }

  boardView(userId) {
    return [...this.board.values()]
      .sort((a, b) => b.points - a.points || a.games - b.games)
      .map((b) => ({ name: b.name, avatar: b.avatar, kind: b.kind, points: b.points, games: b.games, wins: b.wins, duraks: b.duraks, you: b.id === userId, ranked: isRanked(b.id) }));
  }

  _schedule() {
    clearTimeout(this.botTimer); clearTimeout(this.turnTimer);
    this.botTimer = this.turnTimer = null;
    this.deadline = null;
    const g = this.game;
    if (!g || g.over) return;

    // bots: one action per tick, after a human-feeling pause
    const bots = this.gameSeats.map((s, i) => (s.kind === 'bot' ? i : -1)).filter((i) => i >= 0);
    if (bots.length) {
      const delay = BOT_MIN + Math.random() * (BOT_MAX - BOT_MIN);
      const v = g.version;
      this.botTimer = setTimeout(() => this._botTick(v), delay);
    }

    // humans the game waits for get a deadline
    const req = g.required().filter((i) => this.gameSeats[i].kind === 'human');
    if (req.length) {
      const away = req.some((i) => !this.isConnected(this.gameSeats[i].id));
      const ms = away ? TURN_MS_AWAY : TURN_MS;
      this.deadline = Date.now() + ms;
      const v = g.version;
      this.turnTimer = setTimeout(() => this._timeout(v), ms);
    }
  }

  _botTick(version) {
    const g = this.game;
    if (!g || g.over || g.version !== version) return;
    const order = this.gameSeats.map((s, i) => (s.kind === 'bot' ? i : -1)).filter((i) => i >= 0).sort(() => Math.random() - 0.5);
    for (const i of order) {
      const a = Bots.decide(g, i, this.gameSeats[i].level, Math.random, this.mems[i]);
      if (!a) continue;
      const r = g.act(i, a);
      if (r.ok) { this._changed(); return; }
      console.warn('[bot] rejected', a, r.error);
    }
    // nobody wanted to act: wait for humans (timer already set)
  }

  _timeout(version) {
    const g = this.game;
    if (!g || g.over || g.version !== version) return;
    const req = g.required().filter((i) => this.gameSeats[i].kind === 'human');
    for (const i of req) {
      const r = g.act(i, Bots.autoAction(g, i));
      if (!r.ok) console.warn('[timeout] auto action failed', r.error);
    }
    this._changed();
  }

  /* ---------- views ---------- */
  view(userId) {
    const g = this.game;
    const gi = g ? this.gameIndexOf(userId) : -1;
    const seatView = (s) => s && ({
      kind: s.kind, name: s.name, avatar: s.avatar || null, level: s.level || null,
      connected: s.kind === 'bot' ? true : this.isConnected(s.id), you: s.id === userId,
      host: s.id === this.hostId, durak: (this.board.get(s.id) || {}).duraks || 0,
      points: (this.board.get(s.id) || {}).points || 0,
    });
    return {
      code: this.code, solo: this.solo, status: this.status,
      isHost: userId === this.hostId,
      settings: this.settings,
      seats: this.seats.map(seatView),
      games: this.games,
      board: this.boardView(userId),
      lastScores: this.lastScores && {
        mult: this.lastScores.mult,
        rows: this.lastScores.rows.map((r) => ({ name: r.name, kind: r.kind, points: r.points, place: r.place, durak: r.durak, caught: r.caught, wasCaught: r.wasCaught, left: !!r.left, you: r.id === userId, ranked: isRanked(r.id) })),
      },
      game: g ? {
        ...g.view(gi),
        names: this.gameSeats.map(seatView),
        deadline: this.deadline,
      } : null,
      now: Date.now(),
    };
  }

  broadcast() {
    for (const [uid, set] of this.sockets) {
      const v = this.view(uid);
      for (const s of set) s.emit('room', v);
    }
  }

  destroy() {
    clearTimeout(this.botTimer); clearTimeout(this.turnTimer);
    for (const set of this.sockets.values()) for (const s of set) { s.emit('closed'); s.leave(this.code); }
    this.sockets.clear();
  }
}

function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return {};
  const type = String(a.type || '').slice(0, 12);
  const card = typeof a.card === 'string' ? a.card.slice(0, 4) : undefined;
  const target = Number.isInteger(a.target) ? a.target : -1;
  return { type, card, target };
}

class RoomManager {
  constructor(store) {
    this.store = store || null;
    this.rooms = new Map();
    setInterval(() => this.sweep(), 60000).unref();
  }

  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  create(user, settings, solo) {
    const code = this.newCode();
    const room = new Room(this, code, user, settings, solo);
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase().trim()); }

  remove(code) {
    const r = this.rooms.get(code);
    if (r) { r.destroy(); this.rooms.delete(code); }
  }

  sweep() {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      if (r.sockets.size === 0 && now - r.touched > ROOM_IDLE_MS) this.remove(code);
    }
  }
}

module.exports = { RoomManager, normSettings };
