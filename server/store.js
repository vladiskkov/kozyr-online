'use strict';
/**
 * Global leaderboard storage.
 * DATABASE_URL set → Postgres (e.g. a free Neon database), survives restarts.
 * Otherwise → in-memory, which resets whenever the server restarts or falls asleep.
 */
const TOP = 50;

class MemoryStore {
  constructor() { this.rows = new Map(); this.kind = 'memory'; }
  async init() {}
  async record(rows) {
    for (const r of rows) {
      const cur = this.rows.get(r.id) || { user_id: r.id, points: 0, games: 0, wins: 0, duraks: 0, caught: 0 };
      cur.name = r.name; cur.avatar = r.avatar;
      cur.points += r.points; cur.games += 1;
      cur.wins += r.place === 1 ? 1 : 0; cur.duraks += r.durak ? 1 : 0; cur.caught += r.caught;
      cur.updated_at = new Date();
      this.rows.set(r.id, cur);
    }
  }
  sorted() { return [...this.rows.values()].sort((a, b) => b.points - a.points || a.games - b.games); }
  async top() { return this.sorted().slice(0, TOP); }
  async me(id) {
    const list = this.sorted();
    const k = list.findIndex((r) => r.user_id === id);
    return k < 0 ? null : { ...list[k], rank: list.filter((r) => r.points > list[k].points).length + 1 };
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 30000 });
    this.pool.on('error', (e) => console.error('[db] pool error', e.message));
    this.kind = 'postgres';
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        user_id    text PRIMARY KEY,
        name       text NOT NULL,
        avatar     text,
        points     integer NOT NULL DEFAULT 0,
        games      integer NOT NULL DEFAULT 0,
        wins       integer NOT NULL DEFAULT 0,
        duraks     integer NOT NULL DEFAULT 0,
        caught     integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS players_points_idx ON players (points DESC, games ASC);
    `);
  }
  async record(rows) {
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO players (user_id, name, avatar, points, games, wins, duraks, caught)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           name = EXCLUDED.name, avatar = EXCLUDED.avatar,
           points = players.points + EXCLUDED.points, games = players.games + 1,
           wins = players.wins + EXCLUDED.wins, duraks = players.duraks + EXCLUDED.duraks,
           caught = players.caught + EXCLUDED.caught, updated_at = now()`,
        [r.id, r.name, r.avatar, r.points, r.place === 1 ? 1 : 0, r.durak ? 1 : 0, r.caught],
      );
    }
  }
  async top() {
    const { rows } = await this.pool.query(
      'SELECT user_id, name, avatar, points, games, wins, duraks, caught FROM players ORDER BY points DESC, games ASC LIMIT $1', [TOP]);
    return rows;
  }
  async me(id) {
    const { rows } = await this.pool.query(
      `SELECT p.user_id, p.name, p.avatar, p.points, p.games, p.wins, p.duraks, p.caught,
              (SELECT count(*)::int + 1 FROM players q WHERE q.points > p.points) AS rank
         FROM players p WHERE p.user_id = $1`, [id]);
    return rows[0] || null;
  }
}

function createStore() {
  const url = process.env.DATABASE_URL;
  const facade = {
    impl: url ? new PgStore(url) : new MemoryStore(),
    get kind() { return this.impl.kind; },
    version: 0,
    record(rows) { return this.impl.record(rows).then(() => { this.version++; }); },
    top() { return this.impl.top(); },
    me(id) { return this.impl.me(id); },
  };
  facade.ready = facade.impl.init().then(
    () => console.log(`[db] leaderboard storage: ${facade.kind}`),
    (e) => { console.error('[db] init failed, using memory instead:', e.message); facade.impl = new MemoryStore(); },
  );
  return facade;
}

module.exports = { createStore, MemoryStore };
