// Geo-Helfer: Luftlinie (Haversine) und kürzeste lineare Distanz zur Küstenlinie.

const R = 6371000; // Erdradius in m

export function haversine(a, b) {
  const toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// lokale Projektion auf Meter-Ebene (für kurze Distanzen exakt genug)
function toXY(p, lat0) {
  return { x: R * (p.lng * Math.PI / 180) * Math.cos(lat0 * Math.PI / 180), y: R * (p.lat * Math.PI / 180) };
}
function toLL(xy, lat0) {
  return { lat: xy.y / R * 180 / Math.PI, lng: xy.x / (R * Math.cos(lat0 * Math.PI / 180)) * 180 / Math.PI };
}
function closestOnSeg(P, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy;
  if (len2 === 0) return { pt: A, d: Math.hypot(P.x - A.x, P.y - A.y) };
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const pt = { x: A.x + t * dx, y: A.y + t * dy };
  return { pt, d: Math.hypot(P.x - pt.x, P.y - pt.y) };
}

// Findet aus Overpass-"out geom"-Elementen den nächsten Punkt auf der Küstenlinie.
export function nearestCoastPoint(P, elements) {
  const lat0 = P.lat, Pxy = toXY(P, lat0);
  let best = null;
  for (const el of elements) {
    const g = el.geometry;
    if (!g || g.length < 2) continue;
    for (let i = 0; i < g.length - 1; i++) {
      const A = toXY({ lat: g[i].lat, lng: g[i].lon }, lat0);
      const B = toXY({ lat: g[i + 1].lat, lng: g[i + 1].lon }, lat0);
      const c = closestOnSeg(Pxy, A, B);
      if (!best || c.d < best.dist) {
        const ll = toLL(c.pt, lat0);
        best = { lat: ll.lat, lng: ll.lng, dist: c.d };
      }
    }
  }
  return best;
}
