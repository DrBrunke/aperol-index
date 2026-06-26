import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/aperol.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    price      REAL    NOT NULL,
    dist       REAL    NOT NULL,
    r_lat      REAL    NOT NULL,
    r_lng      REAL    NOT NULL,
    s_lat      REAL    NOT NULL,
    s_lng      REAL    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage (
    month TEXT    PRIMARY KEY,        -- 'YYYY-MM'
    count INTEGER NOT NULL DEFAULT 0
  );
`);

const rowToEntry = (r) => ({
  id: r.id, name: r.name, price: r.price, dist: r.dist,
  r: { lat: r.r_lat, lng: r.r_lng },
  s: { lat: r.s_lat, lng: r.s_lng },
  createdAt: r.created_at,
});

export function listEntries() {
  return db.prepare('SELECT * FROM entries ORDER BY id').all().map(rowToEntry);
}

export function addEntry(e) {
  const info = db.prepare(`
    INSERT INTO entries (name, price, dist, r_lat, r_lng, s_lat, s_lng)
    VALUES (@name, @price, @dist, @r_lat, @r_lng, @s_lat, @s_lng)
  `).run({
    name: e.name, price: e.price, dist: e.dist,
    r_lat: e.r.lat, r_lng: e.r.lng, s_lat: e.s.lat, s_lng: e.s.lng,
  });
  return rowToEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid));
}

export function deleteEntry(id) {
  return db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0;
}

// ---------- Monatlicher Google-API-Zähler ----------
const currentMonth = () => new Date().toISOString().slice(0, 7); // 'YYYY-MM'

export function getMonthlyUsage() {
  const row = db.prepare('SELECT count FROM usage WHERE month = ?').get(currentMonth());
  return row ? row.count : 0;
}

export function bumpUsage(n = 1) {
  const m = currentMonth();
  db.prepare(`
    INSERT INTO usage (month, count) VALUES (?, ?)
    ON CONFLICT(month) DO UPDATE SET count = count + ?
  `).run(m, n, n);
  return getMonthlyUsage();
}
