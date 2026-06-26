import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listEntries, addEntry, deleteEntry, getMonthlyUsage, bumpUsage } from './db.js';
import { nearestCoastPoint } from './geo.js';
import rateLimit from 'express-rate-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Hinter genau einem Reverse-Proxy (nginx): X-Forwarded-For vertrauen,
// damit express-rate-limit die echte Client-IP nutzt.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const UA = 'AperolIndex/1.0 (kian.brunke@gmx.de)'; // nur für Overpass (Küstenlinie)
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY  || ''; // Places API (Suche)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || ''; // Maps JS API (Karte)
const AUTH_TOKEN      = process.env.AUTH_TOKEN      || '';
// Kostenschutz: max. billbare Google-Aufrufe (Karte + Suche) pro Kalendermonat.
// Bei Erreichen wird die KOMPLETTE App bis zum Monatsersten gesperrt. 0 = unbegrenzt.
const GOOGLE_MONTHLY_LIMIT = parseInt(process.env.GOOGLE_MONTHLY_LIMIT || '9000', 10);

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

// ---------- Auth ----------
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if ((req.headers['authorization'] || '') === 'Bearer ' + AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ---------- Rate Limiting ----------
const searchLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const coastLimiter  = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

// ---------- Öffentlich: Config ----------
// Jeder Aufruf = eine Map-JS-Ladung im Browser → zählt als billbarer Google-Aufruf.
app.get('/api/config', (_req, res) => {
  if (GOOGLE_MAPS_KEY) bumpUsage(1);
  res.json({ auth: !!AUTH_TOKEN, mapsKey: GOOGLE_MAPS_KEY });
});

// ---------- Einträge (geteilte Liste) ----------
app.get('/api/entries', requireAuth, (_req, res) => {
  res.json(listEntries());
});

app.post('/api/entries', requireAuth, (req, res) => {
  const b = req.body || {};
  const ok = b.name &&
             typeof b.price === 'number' && b.price > 0 &&
             typeof b.dist  === 'number' && b.dist  > 0 &&
             b.r && b.s &&
             [b.r.lat, b.r.lng, b.s.lat, b.s.lng].every(n => typeof n === 'number');
  if (!ok) return res.status(400).json({ error: 'Ungültige Daten' });
  res.status(201).json(addEntry(b));
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
