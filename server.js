import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listEntries, addEntry, deleteEntry } from './db.js';
import { nearestCoastPoint } from './geo.js';
import rateLimit from 'express-rate-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'AperolIndex/1.0 (kian.brunke@gmx.de)';
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY  || '';
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const AUTH_TOKEN      = process.env.AUTH_TOKEN      || '';

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- Öffentlich: Config ----------
app.get('/api/config', (_req, res) => {
  res.json({ auth: !!AUTH_TOKEN, mapsKey: GOOGLE_MAPS_KEY });
});

// ---------- Auth ----------
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  if (header === 'Bearer ' + AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
}

// ---------- Rate Limiting ----------
const searchLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const coastLimiter  = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

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

// ---------- Suche (Photon, Fallback Nominatim, optional Google Places) ----------
app.get('/api/search', requireAuth, searchLimiter, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json([]);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const loc = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
  try {
    let results = [];
    if (GOOGLE_API_KEY) {
      try { results = await googlePlaces(q, loc); } catch (_e) {}
    }
    if (!results.length) results = await photon(q, loc);
    if (!results.length) results = await nominatim(q, loc);
    res.json(results);
  } catch (_e) {
    res.status(502).json({ error: 'Suchdienst nicht erreichbar' });
  }
});

// ---------- Küstenlinie ----------
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

async function photon(q, loc) {
  let url = 'https://photon.komoot.io/api/?lang=de&limit=8&q=' + encodeURIComponent(q);
  if (loc) url += `&lat=${loc.lat}&lon=${loc.lng}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('photon ' + r.status);
  const j = await r.json();
  return (j.features || []).map((f) => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    const title = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || 'Unbenannt';
    const subParts = [];
    if (p.street && p.name) subParts.push(p.street);
    if (p.city) subParts.push(p.city); else if (p.locality) subParts.push(p.locality);
    if (p.state) subParts.push(p.state);
    if (p.country) subParts.push(p.country);
    const kind = p.osm_value || p.type || '';
    return { lat: c[1], lng: c[0], title, sub: [kind ? '· ' + kind : '', subParts.join(', ')].filter(Boolean).join('  ') };
  }).filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number');
}

async function nominatim(q, loc) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q=' + encodeURIComponent(q);
  if (loc) {
    const d = 0.6;
    url += `&viewbox=${loc.lng - d},${loc.lat + d},${loc.lng + d},${loc.lat - d}&bounded=0`;
  }
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const arr = await r.json();
  return arr.map((a) => {
    const parts = (a.display_name || '').split(', ');
    return { lat: parseFloat(a.lat), lng: parseFloat(a.lon), title: parts.slice(0, 2).join(', '), sub: parts.slice(2).join(', ') };
  });
}

app.listen(PORT, () => console.log(`🍹 Aperol Index läuft auf http://localhost:${PORT}`));
