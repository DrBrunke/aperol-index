import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  listEntries, addEntry, deleteEntry, getMonthlyUsage, bumpUsage,
  listCredentials, getCredential, hasCredentials, addCredential,
  updateCredentialCounter, createSession, getSession, deleteSession, purgeExpiredSessions,
} from './db.js';
import { nearestCoastPoint, haversine } from './geo.js';
import rateLimit from 'express-rate-limit';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Hinter genau einem Reverse-Proxy (nginx): X-Forwarded-For vertrauen,
// damit express-rate-limit die echte Client-IP nutzt.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const UA = 'AperolIndex/1.0 (kian.brunke@gmx.de)'; // nur für Overpass (Küstenlinie)
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY  || ''; // Places API (Suche)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || ''; // Maps JS API (Karte)

// ---------- WebAuthn / FaceID-Zugang ----------
// REGISTER_CODE: Einmal-Code, der EINMAL pro neuem Gerät beim Einrichten der
// FaceID/Passkey eingegeben werden muss. Leer = Zugangsschutz komplett deaktiviert.
const REGISTER_CODE = process.env.REGISTER_CODE || '';
const RP_NAME   = process.env.RP_NAME   || 'Aperol Index';
// RP_ID = registrierbare Domain (ohne Protokoll/Port), z.B. aperol.example.com.
// Muss zur aufrufenden Domain passen, sonst lehnt der Browser WebAuthn ab.
const RP_ID     = process.env.RP_ID     || 'localhost';
// RP_ORIGIN = vollständige Origin inkl. Protokoll, z.B. https://aperol.example.com.
const RP_ORIGIN = process.env.RP_ORIGIN || `http://localhost:${PORT}`;
// "Angemeldet bleiben": Session-Lebensdauer in Tagen.
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '365', 10);
// Stabiler User-Handle: die App teilt EINE Liste, alle Passkeys gehören zu diesem Nutzer.
const USER_HANDLE = new TextEncoder().encode('aperol-user');

const authEnabled = () => !!REGISTER_CODE;

// Kostenschutz: max. billbare Google-Aufrufe (Karte + Suche) pro Kalendermonat.
// Bei Erreichen wird die KOMPLETTE App bis zum Monatsersten gesperrt. 0 = unbegrenzt.
const GOOGLE_MONTHLY_LIMIT = parseInt(process.env.GOOGLE_MONTHLY_LIMIT || '9000', 10);

purgeExpiredSessions();

app.use(express.json());

// ---------- Quota: komplette App-Sperre bei erreichtem Limit ----------
function quotaExceeded() {
  return GOOGLE_MONTHLY_LIMIT > 0 && getMonthlyUsage() >= GOOGLE_MONTHLY_LIMIT;
}
function nextResetDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
function nextResetText() {
  return nextResetDate().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}
function lockPageHtml() {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🍹 Aperol Index — Pause</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:linear-gradient(160deg,#fff7f0,#ffe9d6);color:#2b1a10;padding:20px;}
  .box{background:#fff;border:1px solid #f0d9c7;border-radius:20px;padding:36px 28px;max-width:420px;
    text-align:center;box-shadow:0 24px 64px rgba(217,77,12,.12);}
  .icon{font-size:54px;}
  h1{font-size:23px;margin:10px 0 6px;letter-spacing:-.5px;}
  p{color:#8a7363;font-size:14.5px;line-height:1.55;margin:8px 0;}
  .date{display:inline-block;margin-top:14px;padding:8px 16px;border-radius:12px;
    background:#eef9fb;color:#13707b;font-weight:700;font-size:14px;}
</style></head><body>
<div class="box">
  <div class="icon">🍹⏸️</div>
  <h1>Kurze Pause</h1>
  <p>Das kostenlose monatliche Google-Kontingent ist aufgebraucht. Damit keine Kosten entstehen, pausiert der Aperol Index bis zum Beginn des nächsten Monats.</p>
  <div class="date">Wieder verfügbar am ${nextResetText()}</div>
</div>
</body></html>`;
}

app.use((req, res, next) => {
  if (!quotaExceeded()) return next();
  if (req.path.startsWith('/api/'))
    return res.status(503).json({ error: 'quota', resetsOn: nextResetDate().toISOString() });
  res.status(503).type('html').send(lockPageHtml());
});

app.use(express.static(join(__dirname, 'public')));

// ---------- Cookies (ohne Extra-Dependency) ----------
const SECURE_COOKIES = RP_ORIGIN.startsWith('https');
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (SECURE_COOKIES) c += '; Secure';
  if (maxAgeSec != null) c += `; Max-Age=${maxAgeSec}`;
  res.append('Set-Cookie', c);
}
function clearCookie(res, name) {
  let c = `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (SECURE_COOKIES) c += '; Secure';
  res.append('Set-Cookie', c);
}

// ---------- Challenge-Store (in-memory, kurzlebig) ----------
// Hält die WebAuthn-Challenge serverseitig, referenziert über ein kurzlebiges Cookie.
const challenges = new Map();
function putChallenge(challenge) {
  const id = randomBytes(18).toString('base64url');
  challenges.set(id, { challenge, exp: Date.now() + 5 * 60_000 });
  return id;
}
function takeChallenge(id) {
  const e = id && challenges.get(id);
  if (e) challenges.delete(id);
  if (!e || e.exp < Date.now()) return null;
  return e.challenge;
}

// ---------- Sessions ----------
function startSession(res, credentialId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  // SQLite-Format 'YYYY-MM-DD HH:MM:SS' (UTC) für datetime()-Vergleiche.
  createSession(token, credentialId, expires.toISOString().slice(0, 19).replace('T', ' '));
  setCookie(res, 'aperol_session', token, SESSION_TTL_DAYS * 86400);
}

// ---------- Auth ----------
function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  const token = parseCookies(req).aperol_session;
  if (token && getSession(token)) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ---------- Auth-Routen (WebAuthn / FaceID) ----------
app.get('/api/auth/status', (req, res) => {
  const token = parseCookies(req).aperol_session;
  res.json({
    enabled: authEnabled(),
    authed: !authEnabled() || !!(token && getSession(token)),
    hasCredentials: hasCredentials(),
  });
});

// Schritt 1 Registrierung: Optionen anfordern (Einmal-Code erforderlich).
app.post('/api/auth/register/options', async (req, res) => {
  if (!authEnabled()) return res.status(400).json({ error: 'Zugangsschutz ist deaktiviert' });
  if ((req.body?.code || '') !== REGISTER_CODE) return res.status(403).json({ error: 'Falscher Code' });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: USER_HANDLE,
    userName: 'Aperol Index',
    attestationType: 'none',
    excludeCredentials: listCredentials().map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform', // FaceID/TouchID des Geräts
    },
  });
  setCookie(res, 'aperol_chal', putChallenge(options.challenge), 300);
  res.json(options);
});

// Schritt 2 Registrierung: Antwort des Authenticators verifizieren + Gerät speichern.
app.post('/api/auth/register/verify', async (req, res) => {
  if (!authEnabled()) return res.status(400).json({ error: 'Zugangsschutz ist deaktiviert' });
  const expectedChallenge = takeChallenge(parseCookies(req).aperol_chal);
  clearCookie(res, 'aperol_chal');
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge abgelaufen' });
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verified || !registrationInfo) return res.status(400).json({ error: 'Verifizierung fehlgeschlagen' });
    const { id, publicKey, counter, transports } = registrationInfo.credential;
    addCredential({ id, publicKey, counter, transports, label: (req.body?.label || '').toString().slice(0, 60) });
    startSession(res, id);
    res.json({ verified: true });
  } catch (e) {
    res.status(400).json({ error: 'Verifizierung fehlgeschlagen' });
  }
});

// Schritt 1 Login: Authentifizierungs-Optionen (discoverable credentials).
app.post('/api/auth/login/options', async (_req, res) => {
  if (!authEnabled()) return res.status(400).json({ error: 'Zugangsschutz ist deaktiviert' });
  // Alle bekannten Geräte als erlaubte Credentials mitgeben. So findet der Browser
  // den Passkey auch dann, wenn er nicht "discoverable" gespeichert wurde.
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: listCredentials().map((c) => ({ id: c.id, transports: c.transports })),
  });
  setCookie(res, 'aperol_chal', putChallenge(options.challenge), 300);
  res.json(options);
});

// Schritt 2 Login: Assertion verifizieren + Session starten.
app.post('/api/auth/login/verify', async (req, res) => {
  if (!authEnabled()) return res.status(400).json({ error: 'Zugangsschutz ist deaktiviert' });
  const expectedChallenge = takeChallenge(parseCookies(req).aperol_chal);
  clearCookie(res, 'aperol_chal');
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge abgelaufen' });
  const cred = getCredential(req.body?.response?.id);
  if (!cred) return res.status(400).json({ error: 'Unbekanntes Gerät' });
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: req.body?.response,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports },
    });
    if (!verified) return res.status(400).json({ error: 'Verifizierung fehlgeschlagen' });
    updateCredentialCounter(cred.id, authenticationInfo.newCounter);
    startSession(res, cred.id);
    res.json({ verified: true });
  } catch (e) {
    res.status(400).json({ error: 'Verifizierung fehlgeschlagen' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).aperol_session;
  if (token) deleteSession(token);
  clearCookie(res, 'aperol_session');
  res.json({ ok: true });
});

// ---------- Rate Limiting ----------
const searchLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const coastLimiter  = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

// ---------- Öffentlich: Config ----------
// Jeder Aufruf = eine Map-JS-Ladung im Browser → zählt als billbarer Google-Aufruf.
app.get('/api/config', (_req, res) => {
  if (GOOGLE_MAPS_KEY) bumpUsage(1);
  res.json({ auth: authEnabled(), mapsKey: GOOGLE_MAPS_KEY });
});

// ---------- Einträge (geteilte Liste) ----------
app.get('/api/entries', requireAuth, (_req, res) => {
  res.json(listEntries());
});

app.post('/api/entries', requireAuth, (req, res) => {
  const b = req.body || {};
  const ok = b.name &&
             typeof b.price === 'number' && b.price > 0 &&
             b.r && b.s &&
             [b.r.lat, b.r.lng, b.s.lat, b.s.lng].every(n => typeof n === 'number');
  if (!ok) return res.status(400).json({ error: 'Ungültige Daten' });
  // dist immer serverseitig aus den Koordinaten berechnen – ein vom Client
  // mitgeschicktes dist wird ignoriert (verhindert inkonsistente Werte).
  const dist = haversine(b.r, b.s);
  if (!(dist > 0)) return res.status(400).json({ error: 'Ungültige Daten' });
  res.status(201).json(addEntry({ ...b, dist }));
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  const ok = deleteEntry(Number(req.params.id));
  res.status(ok ? 204 : 404).end();
});

// ---------- Suche (ausschließlich Google Places) ----------
app.get('/api/search', requireAuth, searchLimiter, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json([]);
  if (!GOOGLE_API_KEY) return res.status(501).json({ error: 'Suche nicht konfiguriert (GOOGLE_API_KEY fehlt)' });
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const loc = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
  try {
    const results = await googlePlaces(q, loc);
    bumpUsage(1);
    res.json(results);
  } catch (_e) {
    res.status(502).json({ error: 'Suchdienst nicht erreichbar' });
  }
});

// ---------- Küstenlinie (Overpass / OpenStreetMap) ----------
app.get('/api/coast', requireAuth, coastLimiter, async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return res.status(400).json({ error: 'lat/lng fehlt' });

  const controller = new AbortController();
  const globalTimeout = setTimeout(() => controller.abort(), 45_000);
  try {
    for (const radius of [12000, 40000, 120000]) {
      try {
        const query = `[out:json][timeout:25];way["natural"="coastline"](around:${radius},${lat},${lng});out geom;`;
        const r = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error('overpass ' + r.status);
        const j = await r.json();
        const best = nearestCoastPoint({ lat, lng }, j.elements || []);
        if (best) return res.json(best);
      } catch (e) {
        if (e.name === 'AbortError') break;
      }
    }
  } finally {
    clearTimeout(globalTimeout);
  }
  res.status(404).json({ error: 'Keine Küstenlinie in der Nähe gefunden' });
});

// ---------- Google Places Text Search (Key bleibt serverseitig) ----------
async function googlePlaces(q, loc) {
  const body = { textQuery: q, languageCode: 'de', maxResultCount: 8 };
  if (loc) body.locationBias = { circle: { center: { latitude: loc.lat, longitude: loc.lng }, radius: 30000 } };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  return (j.places || []).map((p) => ({
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    title: p.displayName?.text || 'Unbenannt',
    sub: [p.primaryTypeDisplayName?.text ? '· ' + p.primaryTypeDisplayName.text : '', p.formattedAddress || ''].filter(Boolean).join('  '),
  })).filter((x) => typeof x.lat === 'number' && typeof x.lng === 'number');
}

app.listen(PORT, () => console.log(`🍹 Aperol Index läuft auf http://localhost:${PORT}`));
