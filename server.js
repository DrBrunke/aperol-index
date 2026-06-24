import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listEntries, addEntry, deleteEntry } from './db.js';
import { nearestCoastPoint } from './geo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'AperolIndex/1.0 (self-hosted; https://github.com/your/aperol-index)';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || ''; // optional: bessere POI-Suche

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- Einträge (geteilte Liste) ----------
app.get('/api/entries', (req, res) => {
  res.json(listEntries());
});

app.post('/api/entries', (req, res) => {
  const b = req.body || {};
  const ok = b.name && typeof b.price === 'number' && typeof b.dist === 'number' &&
             b.r && b.s && [b.r.lat, b.r.lng, b.s.lat, b.s.lng].every(n => typeof n === 'number');
  if (!ok) return res.status(400).json({ error: 'Ungültige Daten' });
  res.status(201).json(addEntry(b));
});

app.delete('/api/entries/:id', (req, res) => {
  const ok = deleteEntry(Number(req.params.id));
  res.status(ok ? 204 : 404).end();
});

// ---------- Suche (Photon, Fallback Nominatim) – serverseitig mit User-Agent ----------
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json([]);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const loc = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
  try {
    let results = [];
    // 1) Google Places (beste Abdeckung) – nur wenn Key gesetzt
    if (GOOGLE_API_KEY) {
      try { results = await googlePlaces(q, loc); } catch (e) { /* Fallback unten */ }
    }
    // 2) OSM-Fallback (Photon, dann Nominatim)
    if (!results.length) results = await photon(q, loc);
    if (!results.length) results = await nominatim(q, loc);
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: 'Suchdienst nicht erreichbar' });
  }
});

// Google Places Text Search (New) – Key bleibt serverseitig.
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

// ---------- Küstenlinie / kürzeste Luftlinie zum Wasser ----------
app.get('/api/coast', async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng fehlt' });
  for (const radius of [12000, 40000, 120000]) {
    try {
      const query = `[out:json][timeout:25];way["natural"="coastline"](around:${radius},${lat},${lng});out geom;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!r.ok) throw new Error('overpass ' + r.status);
      const j = await r.json();
      const best = nearestCoastPoint({ lat, lng }, j.elements || []);
      if (best) return res.json(best); // {lat,lng,dist}
    } catch (e) { /* nächster Radius */ }
  }
  res.status(404).json({ error: 'Keine Küstenlinie in der Nähe gefunden' });
});

app.listen(PORT, () => console.log(`🍹 Aperol Index läuft auf http://localhost:${PORT}`));
