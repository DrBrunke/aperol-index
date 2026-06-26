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

  -- WebAuthn/Passkey-Zugangsdaten. Jeder Datensatz = ein freigeschaltetes Gerät
  -- (FaceID/TouchID). id ist die Credential-ID (base64url), public_key der COSE-Key.
  CREATE TABLE IF NOT EXISTS credentials (
    id          TEXT    PRIMARY KEY,
    public_key  BLOB    NOT NULL,
    counter     INTEGER NOT NULL DEFAULT 0,
    transports  TEXT,                  -- JSON-Array, z.B. ["internal"]
    label       TEXT,                  -- Gerätename, vom Nutzer vergeben
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- "Angemeldet bleiben": langlebige Sessions (Cookie-Token → Ablaufdatum).
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT    PRIMARY KEY,
    credential_id TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT    NOT NULL
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

// ---------- WebAuthn-Credentials ----------
export function listCredentials() {
  return db.prepare('SELECT * FROM credentials ORDER BY created_at').all().map((r) => ({
    id: r.id,
    publicKey: r.public_key,                       // Buffer (BLOB)
    counter: r.counter,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
    label: r.label,
  }));
}

export function getCredential(id) {
  const r = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id,
    publicKey: r.public_key,
    counter: r.counter,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
    label: r.label,
  };
}

export function hasCredentials() {
  return db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n > 0;
}

export function addCredential({ id, publicKey, counter, transports, label }) {
  db.prepare(`
    INSERT INTO credentials (id, public_key, counter, transports, label)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, Buffer.from(publicKey), counter, transports ? JSON.stringify(transports) : null, label || null);
}

export function updateCredentialCounter(id, counter) {
  db.prepare('UPDATE credentials SET counter = ? WHERE id = ?').run(counter, id);
}

// ---------- Sessions ("angemeldet bleiben") ----------
export function createSession(token, credentialId, expiresAt) {
  db.prepare('INSERT INTO sessions (token, credential_id, expires_at) VALUES (?, ?, ?)')
    .run(token, credentialId || null, expiresAt);
}

export function getSession(token) {
  const r = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  return r || null;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Aufräumen abgelaufener Sessions (gelegentlich beim Start/Verifizieren aufrufen).
export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}
