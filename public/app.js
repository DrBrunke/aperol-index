// ---- State ----
let data = [];                          // Einträge aus dem Backend
let sort = { k: 'idx', dir: -1 };
let cur = { name: null, r: null, sea: null, dist: null }; // aktueller Entwurf
let manualMode = false, placeRestaurantMode = false;
let userLoc = null;                     // {lat,lng} für Standort-Priorisierung

// ---- Karte ----
const map = L.map('map').setView([43.0, 7.0], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
const orangeIcon = L.divIcon({ className: '', html: '<div style="font-size:30px;line-height:30px;transform:translate(-50%,-100%)">📍</div>', iconSize: [0, 0] });
const seaIcon = L.divIcon({ className: '', html: '<div style="font-size:24px;line-height:24px;transform:translate(-50%,-50%)">🌊</div>', iconSize: [0, 0] });
let rMarker = null, sMarker = null, line = null, youMarker = null;

function locateUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (youMarker) map.removeLayer(youMarker);
    youMarker = L.circleMarker([userLoc.lat, userLoc.lng], { radius: 7, color: '#1b9aaa', fillColor: '#1b9aaa', fillOpacity: .7, weight: 2 })
      .addTo(map).bindTooltip('Dein Standort');
    if (!cur.r) map.setView([userLoc.lat, userLoc.lng], 14);
  }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 });
}
locateUser();

// ---- Geo-Mathe (Anzeige/Fallback im Client) ----
function haversine(a, b) {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

// ---- Marker-Helfer ----
function drawLine() {
  if (line) { map.removeLayer(line); line = null; }
  if (cur.r && cur.sea) line = L.polyline([[cur.r.lat, cur.r.lng], [cur.sea.lat, cur.sea.lng]], { color: '#1b9aaa', weight: 3, dashArray: '6 6' }).addTo(map);
}
function setRestaurant(lat, lng) {
  cur.r = { lat, lng };
  if (rMarker) rMarker.setLatLng([lat, lng]); else rMarker = L.marker([lat, lng], { icon: orangeIcon }).addTo(map);
}
function setSea(lat, lng) {
  cur.sea = { lat, lng };
  if (sMarker) sMarker.setLatLng([lat, lng]);
  else {
    sMarker = L.marker([lat, lng], { icon: seaIcon, draggable: true }).addTo(map);
    sMarker.on('dragend', () => { const p = sMarker.getLatLng(); cur.sea = { lat: p.lat, lng: p.lng }; cur.dist = haversine(cur.r, cur.sea); drawLine(); showDist(); validate(); });
  }
}

// ---- Suche (über Backend-Proxy) ----
const searchEl = document.getElementById('search');
const resultsEl = document.getElementById('results');
let searchTimer = null, hlIdx = -1, lastResults = [];
searchEl.addEventListener('input', () => {
  cur.name = null; validate();
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  if (q.length < 3) { resultsEl.classList.remove('open'); return; }
  showResultsInfo('Suche …');
  searchTimer = setTimeout(() => doSearch(q), 400);
});
searchEl.addEventListener('keydown', (e) => {
  if (!resultsEl.classList.contains('open')) return;
  if (e.key === 'ArrowDown') { hlIdx = Math.min(hlIdx + 1, lastResults.length - 1); paintHl(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { hlIdx = Math.max(hlIdx - 1, 0); paintHl(); e.preventDefault(); }
  else if (e.key === 'Enter') { if (hlIdx >= 0 && lastResults[hlIdx]) { chooseResult(lastResults[hlIdx]); e.preventDefault(); } }
  else if (e.key === 'Escape') { resultsEl.classList.remove('open'); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) resultsEl.classList.remove('open'); });
function showResultsInfo(t) { resultsEl.innerHTML = '<div class="res info">' + t + '</div>'; resultsEl.classList.add('open'); }
function paintHl() { [...resultsEl.children].forEach((c, i) => c.classList.toggle('hl', i === hlIdx)); }

async function doSearch(q) {
  try {
    let url = '/api/search?q=' + encodeURIComponent(q);
    if (userLoc) url += '&lat=' + userLoc.lat + '&lng=' + userLoc.lng;
    const res = await fetch(url);
    if (!res.ok) throw new Error('search ' + res.status);
    const results = await res.json();
    lastResults = results; hlIdx = -1;
    if (!results.length) { showResultsInfo('Keine Treffer — Ort ergänzen oder Schreibweise prüfen'); return; }
    resultsEl.innerHTML = results.map((r) => `<div class="res"><b>${esc(r.title)}</b><div class="sub">${esc(r.sub || '')}</div></div>`).join('');
    resultsEl.classList.add('open');
    [...resultsEl.querySelectorAll('.res')].forEach((el, i) => el.onclick = () => chooseResult(results[i]));
  } catch (e) { showResultsInfo('Suche nicht erreichbar'); }
}
function chooseResult(r) {
  cur.name = r.title; searchEl.value = r.title;
  resultsEl.classList.remove('open');
  setRestaurant(r.lat, r.lng);
  cur.sea = null; cur.dist = null;
  if (sMarker) { map.removeLayer(sMarker); sMarker = null; }
  drawLine();
  map.setView([r.lat, r.lng], 14);
  setTimeout(() => map.invalidateSize(), 100);
  findCoast(r.lat, r.lng);
}

// ---- Küstenlinie / Luftlinie (über Backend) ----
async function findCoast(lat, lng) {
  setDistState('loading', '🌊 Suche nächste Küstenlinie …');
  document.getElementById('manual').style.display = 'none';
  manualMode = false;
  try {
    const res = await fetch('/api/coast?lat=' + lat + '&lng=' + lng);
    if (!res.ok) throw new Error('coast ' + res.status);
    const best = await res.json(); // {lat,lng,dist}
    setSea(best.lat, best.lng);
    cur.dist = best.dist;
    drawLine();
    map.fitBounds(L.latLngBounds([[cur.r.lat, cur.r.lng], [cur.sea.lat, cur.sea.lng]]).pad(0.4));
    showDist();
    document.getElementById('manual').style.display = 'block';
    validate();
  } catch (e) {
    setDistState('err', 'Küste nicht automatisch gefunden — bitte manuell setzen');
    enableManual(true);
  }
}

function setDistState(cls, t) { const el = document.getElementById('dist'); el.className = 'dist' + (cls ? ' ' + cls : ''); el.textContent = t; }
function showDist() { setDistState('', 'Luftlinie zum Meer: ' + fmtDist(cur.dist)); }

// ---- Manuelle Punkte ----
document.getElementById('manualLink').onclick = () => enableManual(true, true);
function enableManual(on) {
  manualMode = on;
  document.getElementById('manual').style.display = 'block';
  if (on) setDistState(cur.dist != null ? '' : 'loading', cur.dist != null
    ? 'Luftlinie: ' + fmtDist(cur.dist) + ' · jetzt Meerpunkt auf Karte tippen/ziehen'
    : 'Tippe die nächste Stelle am Wasser auf der Karte');
}
document.getElementById('placeLink').onclick = () => {
  placeRestaurantMode = true;
  if (!cur.name) { cur.name = searchEl.value.trim() || 'Eigener Ort'; searchEl.value = cur.name; }
  resultsEl.classList.remove('open');
  setDistState('loading', '📍 Jetzt das Restaurant auf der Karte antippen');
};
map.on('click', (e) => {
  if (placeRestaurantMode) {
    placeRestaurantMode = false;
    setRestaurant(e.latlng.lat, e.latlng.lng);
    cur.sea = null; cur.dist = null;
    if (sMarker) { map.removeLayer(sMarker); sMarker = null; }
    drawLine();
    findCoast(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (!cur.r) return;
  if (!manualMode && cur.sea) return;
  setSea(e.latlng.lat, e.latlng.lng);
  cur.dist = haversine(cur.r, cur.sea); drawLine(); showDist(); validate();
});

// ---- Validierung & Speichern (Backend) ----
document.getElementById('price').oninput = validate;
function validate() {
  const ok = cur.name && cur.r && cur.sea && cur.dist != null && parseFloat(document.getElementById('price').value) > 0;
  document.getElementById('add').disabled = !ok;
}
document.getElementById('add').onclick = async () => {
  const btn = document.getElementById('add'); btn.disabled = true;
  const payload = { name: cur.name, price: parseFloat(document.getElementById('price').value), dist: cur.dist, r: cur.r, s: cur.sea };
  try {
    const res = await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('save ' + res.status);
    // reset
    cur = { name: null, r: null, sea: null, dist: null }; manualMode = false;
    searchEl.value = ''; document.getElementById('price').value = '';
    if (rMarker) { map.removeLayer(rMarker); rMarker = null; }
    if (sMarker) { map.removeLayer(sMarker); sMarker = null; }
    if (line) { map.removeLayer(line); line = null; }
    setDistState('', 'Noch kein Ort gewählt');
    document.getElementById('manual').style.display = 'none';
    await loadEntries();
  } catch (e) {
    setStatus('Speichern fehlgeschlagen – Server erreichbar?', true);
    btn.disabled = false;
  }
};

async function loadEntries() {
  try {
    const res = await fetch('/api/entries');
    if (!res.ok) throw new Error('load ' + res.status);
    data = await res.json();
    setStatus('');
    render();
  } catch (e) {
    setStatus('Liste konnte nicht geladen werden – läuft das Backend?', true);
  }
}
async function delEntry(id) {
  try {
    const res = await fetch('/api/entries/' + id, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('del ' + res.status);
    await loadEntries();
  } catch (e) { setStatus('Löschen fehlgeschlagen', true); }
}
function setStatus(t, err) { const el = document.getElementById('status'); el.textContent = t; el.className = 'status' + (err ? ' err' : ''); }

// ---- Trend ----
function regression() {
  const n = data.length; if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  data.forEach((d) => { sx += d.dist; sy += d.price; sxx += d.dist * d.dist; sxy += d.dist * d.price; });
  const denom = n * sxx - sx * sx; if (denom === 0) return null;
  const m = (n * sxy - sx * sy) / denom, b = (sy - m * sx) / n;
  const my = sy / n, mx = sx / n; let ssxy = 0, ssx = 0, ssy = 0;
  data.forEach((d) => { ssxy += (d.dist - mx) * (d.price - my); ssx += (d.dist - mx) ** 2; ssy += (d.price - my) ** 2; });
  const r = (ssx && ssy) ? ssxy / Math.sqrt(ssx * ssy) : 0;
  return { m, b, r };
}

// ---- Render ----
let chart = null;
function render() {
  const tbody = document.getElementById('tbody');
  const reg = regression();
  const rows = data.map((d) => {
    const idx = d.price / d.dist * 100;
    let resid = null; if (reg) resid = d.price - (reg.m * d.dist + reg.b);
    return { ...d, idx, resid };
  });
  rows.sort((a, b) => {
    let A = a[sort.k], B = b[sort.k];
    if (sort.k === 'name') { A = A.toLowerCase(); B = B.toLowerCase(); return A < B ? -sort.dir : A > B ? sort.dir : 0; }
    return (A - B) * sort.dir;
  });
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Noch keine Einträge — such euren ersten Aperol! 🍹</td></tr>';
  } else {
    const resids = rows.filter((r) => r.resid != null).map((r) => r.resid);
    const sd = resids.length > 1 ? Math.sqrt(resids.reduce((s, x) => s + x * x, 0) / resids.length) : 0;
    tbody.innerHTML = rows.map((r) => {
      let bw = '<span class="badge fair">—</span>';
      if (r.resid != null && sd > 0) {
        if (r.resid < -0.4 * sd) bw = '<span class="badge deal">🟢 Schnäppchen</span>';
        else if (r.resid > 0.4 * sd) bw = '<span class="badge trap">🔴 Touri-Falle</span>';
        else bw = '<span class="badge fair">🟠 fair</span>';
      }
      return `<tr><td>${esc(r.name)}</td><td class="num">${r.price.toFixed(2)}</td>
        <td class="num">${fmtDist(r.dist)}</td><td class="num">${r.idx.toFixed(2)}</td>
        <td>${bw}</td><td class="num"><button class="del" data-id="${r.id}" title="löschen">✕</button></td></tr>`;
    }).join('');
    tbody.querySelectorAll('.del').forEach((b) => b.onclick = () => delEntry(+b.dataset.id));
  }
  renderStats(reg); renderChart(reg);
}
function renderStats(reg) {
  const el = document.getElementById('stats');
  if (data.length === 0) { el.innerHTML = ''; return; }
  const prices = data.map((d) => d.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = Math.min(...prices), max = Math.max(...prices);
  const cheap = data.find((d) => d.price === min).name;
  el.innerHTML = `
    <div class="stat"><div class="v">${data.length}</div><div class="l">Spots</div></div>
    <div class="stat"><div class="v">${avg.toFixed(2)} €</div><div class="l">Ø Preis</div></div>
    <div class="stat"><div class="v">${min.toFixed(2)} €</div><div class="l">günstigster<br>(${esc(cheap)})</div></div>
    <div class="stat"><div class="v">${max.toFixed(2)} €</div><div class="l">teuerster</div></div>`;
  const ti = document.getElementById('trendinfo');
  if (reg) { const t = reg.r < -0.2 ? 'näher = teurer' : reg.r > 0.2 ? 'näher = billiger?!' : 'kein klarer Zusammenhang';
    ti.innerHTML = `Trend: <b>${t}</b> (Korrelation r = ${reg.r.toFixed(2)}). Pro 100 m weiter vom Meer ≈ ${(reg.m * 100).toFixed(2)} € Preisänderung.`; }
}
function renderChart(reg) {
  const ctx = document.getElementById('chart');
  const pts = data.map((d) => ({ x: d.dist, y: d.price, name: d.name }));
  const datasets = [{ label: 'Bars', data: pts, backgroundColor: '#f5631e', pointRadius: 7, pointHoverRadius: 9 }];
  if (reg && data.length >= 2) {
    const xs = data.map((d) => d.dist); const x0 = Math.min(...xs), x1 = Math.max(...xs);
    datasets.push({ label: 'Trend', type: 'line', data: [{ x: x0, y: reg.m * x0 + reg.b }, { x: x1, y: reg.m * x1 + reg.b }], borderColor: '#1b9aaa', borderDash: [6, 6], pointRadius: 0, borderWidth: 2, fill: false });
  }
  if (chart) chart.destroy();
  chart = new Chart(ctx, { type: 'scatter', data: { datasets }, options: { responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => { const p = c.raw; return (p.name ? p.name + ': ' : '') + p.y.toFixed(2) + ' € @ ' + fmtDist(p.x); } } } },
    scales: { x: { title: { display: true, text: 'Luftlinie zum Meer (m)' }, beginAtZero: true }, y: { title: { display: true, text: 'Aperol-Preis (€)' }, beginAtZero: true } } } });
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Sort / Toolbar ----
document.querySelectorAll('#tbl th[data-k]').forEach((th) => {
  th.onclick = () => { const k = th.dataset.k; sort.dir = (sort.k === k) ? -sort.dir : -1; sort.k = k; render(); };
});
document.getElementById('reload').onclick = loadEntries;
document.getElementById('csv').onclick = () => {
  if (!data.length) return;
  let csv = 'Ort;Preis_EUR;Distanz_m;EUR_pro_100m;Rest_Lat;Rest_Lng;Meer_Lat;Meer_Lng\n';
  data.forEach((d) => { csv += [d.name, d.price.toFixed(2), Math.round(d.dist), (d.price / d.dist * 100).toFixed(2),
    d.r.lat.toFixed(6), d.r.lng.toFixed(6), d.s.lat.toFixed(6), d.s.lng.toFixed(6)].join(';') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'aperol-index.csv'; a.click();
};

// ---- Init ----
loadEntries();
setTimeout(() => map.invalidateSize(), 200);
