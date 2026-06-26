// ---- Konstanten ----
// Aperol unter diesem Preis (€) gilt immer als Schnäppchen — egal wie weit weg vom Meer.
const ABSOLUTE_DEAL_PRICE = 6;

// ---- Auth (WebAuthn / FaceID) ----
// Die Anmeldung läuft über einen sicheren HttpOnly-Session-Cookie, den der Server
// setzt. Der Browser sendet ihn bei same-origin-Requests automatisch mit — daher
// kein Token im JS nötig ("angemeldet bleiben" steckt im Cookie).
const SWA = window.SimpleWebAuthnBrowser;

async function authFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) { location.reload(); throw new Error('auth'); }      // Session abgelaufen
  if (res.status === 503) { location.reload(); throw new Error('auth'); }      // Kontingent erreicht
  return res;
}

function setAuthError(msg) {
  const e = document.getElementById('auth-error');
  e.textContent = msg || '';
  e.style.display = msg ? 'block' : 'none';
}

async function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Neues Gerät freischalten: Einmal-Code + FaceID-Einrichtung.
async function doRegister() {
  setAuthError('');
  const code = document.getElementById('reg-code').value.trim();
  const label = document.getElementById('reg-label').value.trim();
  if (!code) { setAuthError('Bitte den Einmal-Code eingeben.'); return false; }
  try {
    const optRes = await postJSON('/api/auth/register/options', { code, label });
    if (optRes.status === 403) { setAuthError('Falscher Einmal-Code.'); return false; }
    if (!optRes.ok) throw new Error('options');
    const optionsJSON = await optRes.json();
    const attResp = await SWA.startRegistration({ optionsJSON });
    const verRes = await postJSON('/api/auth/register/verify', { response: attResp, label });
    const j = await verRes.json().catch(() => ({}));
    if (!verRes.ok || !j.verified) {
      setAuthError('Einrichtung fehlgeschlagen.' + (j.error ? ' (' + j.error + (j.detail ? ': ' + j.detail : '') + ')' : ''));
      return false;
    }
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') setAuthError('Vorgang abgebrochen.');
    else setAuthError('FaceID-Einrichtung nicht möglich.');
    return false;
  }
}

// Anmelden mit bereits eingerichtetem Gerät.
async function doLogin() {
  setAuthError('');
  try {
    const optRes = await postJSON('/api/auth/login/options');
    if (!optRes.ok) throw new Error('options');
    const optionsJSON = await optRes.json();
    const asseResp = await SWA.startAuthentication({ optionsJSON });
    const verRes = await postJSON('/api/auth/login/verify', { response: asseResp });
    const j = await verRes.json().catch(() => ({}));
    if (!verRes.ok || !j.verified) {
      setAuthError('Anmeldung fehlgeschlagen.' + (j.error ? ' (' + j.error + (j.detail ? ': ' + j.detail : '') + ')' : ''));
      return false;
    }
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') setAuthError('Vorgang abgebrochen.');
    else setAuthError('Anmeldung nicht möglich.');
    return false;
  }
}

function waitForAuth(hasCredentials) {
  const overlay = document.getElementById('auth-overlay');
  const loginView = document.getElementById('auth-login');
  const regView = document.getElementById('auth-register');
  overlay.style.display = 'flex';
  const show = (view) => {
    loginView.style.display = view === 'login' ? 'block' : 'none';
    regView.style.display = view === 'register' ? 'block' : 'none';
    setAuthError('');
  };
  // Ohne registriertes Gerät direkt zur Einrichtung.
  show(hasCredentials ? 'login' : 'register');
  document.getElementById('show-register').onclick = () => show('register');
  document.getElementById('show-login').onclick = () => show('login');

  if (!SWA || !SWA.browserSupportsWebAuthn()) {
    setAuthError('Dieser Browser unterstützt FaceID/Passkeys nicht.');
  }

  return new Promise((resolve) => {
    document.getElementById('login-btn').onclick = async () => {
      if (await doLogin()) { overlay.style.display = 'none'; resolve(); }
    };
    document.getElementById('register-btn').onclick = async () => {
      if (await doRegister()) { overlay.style.display = 'none'; resolve(); }
    };
  });
}

// ---- Google Maps Loader ----
async function loadGoogleMaps(key) {
  if (window.google?.maps) return;
  await new Promise((resolve, reject) => {
    window.__googleMapsReady__ = () => { delete window.__googleMapsReady__; resolve(); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=__googleMapsReady__`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
}

// ---- State ----
let data = [];
let sort = { k: 'idx', dir: -1 };
let cur = { name: null, r: null, sea: null, dist: null };
let manualMode = false, placeRestaurantMode = false;
let userLoc = null;

// ---- Map (Google Maps) ----
let map = null;
let rMarker = null, sMarker = null, polyline = null, youMarker = null;

const COLOR_ORANGE      = '#f5631e';
const COLOR_ORANGE_DARK = '#d94d0c';
const COLOR_SEA         = '#1b9aaa';
const COLOR_SEA_DARK    = '#13707b';

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 43.0, lng: 7.0 },
    zoom: 4,
    mapTypeControl: true,
    mapTypeControlOptions: { style: google.maps.MapTypeControlStyle.DROPDOWN_MENU },
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: 'cooperative',
  });

  map.addListener('click', (event) => {
    const lat = event.latLng.lat(), lng = event.latLng.lng();
    if (placeRestaurantMode) {
      placeRestaurantMode = false;
      setRestaurant(lat, lng);
      cur.sea = null; cur.dist = null;
      if (sMarker) { sMarker.setMap(null); sMarker = null; }
      drawLine();
      findCoast(lat, lng);
      return;
    }
    if (!cur.r) return;
    if (!manualMode && cur.sea) return;
    setSea(lat, lng);
    cur.dist = haversine(cur.r, cur.sea);
    drawLine(); showDist(); validate();
  });
}

function restaurantIcon() {
  return {
    path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
    fillColor: COLOR_ORANGE,
    fillOpacity: 1,
    strokeColor: COLOR_ORANGE_DARK,
    strokeWeight: 1.5,
    scale: 1.9,
    anchor: new google.maps.Point(12, 22),
  };
}

function seaIcon() {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 11,
    fillColor: COLOR_SEA,
    fillOpacity: 0.9,
    strokeColor: COLOR_SEA_DARK,
    strokeWeight: 2,
  };
}

function userIcon() {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 8,
    fillColor: COLOR_SEA,
    fillOpacity: 0.7,
    strokeColor: '#ffffff',
    strokeWeight: 2,
  };
}

function drawLine() {
  if (polyline) { polyline.setMap(null); polyline = null; }
  if (!cur.r || !cur.sea) return;
  const dash = { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 4 };
  polyline = new google.maps.Polyline({
    path: [{ lat: cur.r.lat, lng: cur.r.lng }, { lat: cur.sea.lat, lng: cur.sea.lng }],
    strokeOpacity: 0,
    strokeColor: COLOR_SEA,
    icons: [{ icon: dash, offset: '0', repeat: '20px' }],
    map,
  });
}

function setRestaurant(lat, lng) {
  cur.r = { lat, lng };
  if (rMarker) {
    rMarker.setPosition({ lat, lng });
  } else {
    rMarker = new google.maps.Marker({ position: { lat, lng }, map, icon: restaurantIcon(), title: 'Restaurant', zIndex: 2 });
  }
}

function setSea(lat, lng) {
  cur.sea = { lat, lng };
  if (sMarker) {
    sMarker.setPosition({ lat, lng });
  } else {
    sMarker = new google.maps.Marker({ position: { lat, lng }, map, icon: seaIcon(), title: 'Meerpunkt', draggable: true, cursor: 'grab', zIndex: 2 });
    sMarker.addListener('dragend', (e) => {
      cur.sea = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      cur.dist = haversine(cur.r, cur.sea);
      drawLine(); showDist(); validate();
    });
  }
}

function mapSetView(lat, lng, zoom) {
  if (!map) return;
  map.setCenter({ lat, lng });
  if (zoom !== undefined) map.setZoom(zoom);
}

function mapFitBounds(lat1, lng1, lat2, lng2) {
  if (!map) return;
  const bounds = new google.maps.LatLngBounds();
  bounds.extend({ lat: lat1, lng: lng1 });
  bounds.extend({ lat: lat2, lng: lng2 });
  map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
}

// ---- User Location ----
function locateUser() {
  if (!navigator.geolocation || !map) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (youMarker) youMarker.setMap(null);
    youMarker = new google.maps.Marker({ position: userLoc, map, icon: userIcon(), title: 'Dein Standort', zIndex: 1 });
    if (!cur.r) mapSetView(userLoc.lat, userLoc.lng, 14);
  }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 });
}

// ---- Geo-Mathe (Client-Fallback) ----
function haversine(a, b) {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

// ---- Suche ----
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
    const res = await authFetch(url);
    if (res.status === 501) { showResultsInfo('Suche nicht konfiguriert — GOOGLE_API_KEY fehlt'); return; }
    if (!res.ok) throw new Error('search ' + res.status);
    const results = await res.json();
    lastResults = results; hlIdx = -1;
    if (!results.length) { showResultsInfo('Keine Treffer — Ort ergänzen oder Schreibweise prüfen'); return; }
    resultsEl.innerHTML = results.map((r) => `<div class="res"><b>${esc(r.title)}</b><div class="sub">${esc(r.sub || '')}</div></div>`).join('');
    resultsEl.classList.add('open');
    [...resultsEl.querySelectorAll('.res')].forEach((el, i) => el.onclick = () => chooseResult(results[i]));
  } catch (e) {
    if (e.message !== 'auth') showResultsInfo('Suche nicht erreichbar');
  }
}

function chooseResult(r) {
  cur.name = r.title; searchEl.value = r.title;
  resultsEl.classList.remove('open');
  setRestaurant(r.lat, r.lng);
  cur.sea = null; cur.dist = null;
  if (sMarker) { sMarker.setMap(null); sMarker = null; }
  drawLine();
  mapSetView(r.lat, r.lng, 14);
  findCoast(r.lat, r.lng);
}

// ---- Küstenlinie ----
async function findCoast(lat, lng) {
  setDistState('loading', '🌊 Suche nächste Küstenlinie …');
  document.getElementById('manual').style.display = 'none';
  manualMode = false;
  try {
    const res = await authFetch('/api/coast?lat=' + lat + '&lng=' + lng);
    if (!res.ok) throw new Error('coast ' + res.status);
    const best = await res.json();
    setSea(best.lat, best.lng);
    cur.dist = best.dist;
    drawLine();
    mapFitBounds(cur.r.lat, cur.r.lng, cur.sea.lat, cur.sea.lng);
    showDist();
    document.getElementById('manual').style.display = 'block';
    validate();
  } catch (e) {
    if (e.message !== 'auth') {
      setDistState('err', 'Küste nicht automatisch gefunden — bitte manuell setzen');
      enableManual(true);
    }
  }
}

function setDistState(cls, t) { const el = document.getElementById('dist'); el.className = 'dist' + (cls ? ' ' + cls : ''); el.textContent = t; }
function showDist() { setDistState('', 'Luftlinie zum Meer: ' + fmtDist(cur.dist)); }

// ---- Manuelle Punkte ----
document.getElementById('manualLink').onclick = () => enableManual(true);
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

// ---- Aktueller Standort als Aperol-Spot ----
// Setzt das Restaurant auf die aktuelle GPS-Position, sucht automatisch die Küste
// und springt zur Preiseingabe. Name kommt aus dem Suchfeld oder wird abgefragt.
const locBtn = document.getElementById('useLocation');
locBtn.onclick = () => {
  if (!navigator.geolocation) { setDistState('err', 'Standort wird vom Browser nicht unterstützt'); return; }
  if (!map) { setDistState('err', 'Karte noch nicht geladen — bitte kurz warten'); return; }
  let name = searchEl.value.trim();
  if (!name) {
    name = (prompt('Name für diesen Aperol-Spot (z. B. Bar-/Restaurant-Name):', '') || '').trim();
    if (!name) return;
    searchEl.value = name;
  }
  cur.name = name;
  resultsEl.classList.remove('open');
  placeRestaurantMode = false; manualMode = false;
  locBtn.disabled = true;
  setDistState('loading', '📍 Hole deinen aktuellen Standort …');
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    userLoc = { lat, lng };
    if (youMarker) youMarker.setMap(null);
    youMarker = new google.maps.Marker({ position: userLoc, map, icon: userIcon(), title: 'Dein Standort', zIndex: 1 });
    setRestaurant(lat, lng);
    cur.sea = null; cur.dist = null;
    if (sMarker) { sMarker.setMap(null); sMarker = null; }
    drawLine();
    mapSetView(lat, lng, 15);
    locBtn.disabled = false;
    findCoast(lat, lng);
    document.getElementById('price').focus();
  }, () => {
    locBtn.disabled = false;
    setDistState('err', 'Standort nicht verfügbar — bitte Ortungsfreigabe im Browser erlauben');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
};

// ---- Validierung & Speichern ----
document.getElementById('price').oninput = validate;
function validate() {
  const price = parseFloat(document.getElementById('price').value);
  const ok = cur.name && cur.r && cur.sea && cur.dist != null && cur.dist > 0 && price > 0;
  document.getElementById('add').disabled = !ok;
}

document.getElementById('add').onclick = async () => {
  const btn = document.getElementById('add'); btn.disabled = true;
  const payload = { name: cur.name, price: parseFloat(document.getElementById('price').value), dist: cur.dist, r: cur.r, s: cur.sea };
  try {
    const res = await authFetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('save ' + res.status);
    cur = { name: null, r: null, sea: null, dist: null }; manualMode = false;
    searchEl.value = ''; document.getElementById('price').value = '';
    if (rMarker) { rMarker.setMap(null); rMarker = null; }
    if (sMarker) { sMarker.setMap(null); sMarker = null; }
    if (polyline) { polyline.setMap(null); polyline = null; }
    setDistState('', 'Noch kein Ort gewählt');
    document.getElementById('manual').style.display = 'none';
    await loadEntries();
  } catch (e) {
    if (e.message !== 'auth') { setStatus('Speichern fehlgeschlagen – Server erreichbar?', true); btn.disabled = false; }
  }
};

// ---- Einträge laden / löschen ----
async function loadEntries() {
  try {
    const res = await authFetch('/api/entries');
    if (!res.ok) throw new Error('load ' + res.status);
    data = await res.json();
    setStatus(''); render();
  } catch (e) {
    if (e.message !== 'auth') setStatus('Liste konnte nicht geladen werden – läuft das Backend?', true);
  }
}

async function delEntry(id) {
  if (!confirm('Eintrag wirklich löschen?')) return;
  try {
    const res = await authFetch('/api/entries/' + id, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('del ' + res.status);
    await loadEntries();
  } catch (e) {
    if (e.message !== 'auth') setStatus('Löschen fehlgeschlagen', true);
  }
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
    const idx = d.dist > 0 ? d.price / d.dist * 100 : 0;
    const resid = reg ? d.price - (reg.m * d.dist + reg.b) : null;
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
      // Absoluter Schnäppchen-Preis schlägt alles: unter ABSOLUTE_DEAL_PRICE ist Aperol
      // unabhängig von der Meeresentfernung günstig.
      if (r.price <= ABSOLUTE_DEAL_PRICE) {
        bw = '<span class="badge deal">🟢 Schnäppchen</span>';
      } else if (r.resid != null && sd > 0) {
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
  const cheap     = data.find((d) => d.price === min);
  const expensive = data.find((d) => d.price === max);
  el.innerHTML = `
    <div class="stat"><div class="v">${data.length}</div><div class="l">Spots</div></div>
    <div class="stat"><div class="v">${avg.toFixed(2)} €</div><div class="l">Ø Preis</div></div>
    <div class="stat"><div class="v">${min.toFixed(2)} €</div><div class="l">günstigster<br>(${esc(cheap.name)})</div></div>
    <div class="stat"><div class="v">${max.toFixed(2)} €</div><div class="l">teuerster<br>(${esc(expensive.name)})</div></div>`;
  const ti = document.getElementById('trendinfo');
  if (reg) {
    const t = reg.r < -0.2 ? 'näher = teurer' : reg.r > 0.2 ? 'näher = billiger?!' : 'kein klarer Zusammenhang';
    ti.innerHTML = `Trend: <b>${t}</b> (Korrelation r = ${reg.r.toFixed(2)}). Pro 100 m weiter vom Meer ≈ ${(reg.m * 100).toFixed(2)} € Preisänderung.`;
  }
}

function renderChart(reg) {
  const ctx = document.getElementById('chart');
  const pts = data.map((d) => ({ x: d.dist, y: d.price, name: d.name }));
  const datasets = [{ label: 'Bars', data: pts, backgroundColor: COLOR_ORANGE, pointRadius: 7, pointHoverRadius: 9 }];
  if (reg && data.length >= 2) {
    const xs = data.map((d) => d.dist); const x0 = Math.min(...xs), x1 = Math.max(...xs);
    datasets.push({ label: 'Trend', type: 'line', data: [{ x: x0, y: reg.m * x0 + reg.b }, { x: x1, y: reg.m * x1 + reg.b }], borderColor: COLOR_SEA, borderDash: [6, 6], pointRadius: 0, borderWidth: 2, fill: false });
  }
  if (chart) {
    chart.data.datasets = datasets;
    chart.update('none');
  } else {
    chart = new Chart(ctx, { type: 'scatter', data: { datasets }, options: { responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => { const p = c.raw; return (p.name ? p.name + ': ' : '') + p.y.toFixed(2) + ' € @ ' + fmtDist(p.x); } } } },
      scales: { x: { title: { display: true, text: 'Luftlinie zum Meer (m)' }, beginAtZero: true }, y: { title: { display: true, text: 'Aperol-Preis (€)' }, beginAtZero: true } } } });
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Sort / Toolbar ----
document.querySelectorAll('#tbl th[data-k]').forEach((th) => {
  th.onclick = () => { const k = th.dataset.k; sort.dir = (sort.k === k) ? -sort.dir : -1; sort.k = k; render(); };
});
document.getElementById('reload').onclick = loadEntries;
document.getElementById('csv').onclick = () => {
  if (!data.length) return;
  const bom = '﻿';
  let csv = bom + 'Ort;Preis_EUR;Distanz_m;EUR_pro_100m;Rest_Lat;Rest_Lng;Meer_Lat;Meer_Lng\n';
  data.forEach((d) => { csv += [d.name, d.price.toFixed(2), Math.round(d.dist), (d.price / d.dist * 100).toFixed(2),
    d.r.lat.toFixed(6), d.r.lng.toFixed(6), d.s.lat.toFixed(6), d.s.lng.toFixed(6)].join(';') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aperol-index.csv'; a.click();
};

// ---- Init ----
async function init() {
  let config = { auth: false, mapsKey: '' };
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.status === 503) { location.reload(); return; } // Kontingent erreicht
    config = await cfgRes.json();
  } catch (_e) {}

  // Auth (FaceID). Session steckt im Cookie → Server fragen, ob schon angemeldet.
  if (config.auth) {
    let status = { authed: false, hasCredentials: false };
    try { status = await (await fetch('/api/auth/status')).json(); } catch (_e) {}
    if (!status.authed) await waitForAuth(status.hasCredentials);
  }

  // Google Maps
  const mapDiv = document.getElementById('map');
  if (config.mapsKey) {
    try {
      await loadGoogleMaps(config.mapsKey);
      initMap();
    } catch (_e) {
      mapDiv.innerHTML = '<p class="map-loading" style="color:#c4392c;">Google Maps konnte nicht geladen werden.</p>';
    }
  } else {
    mapDiv.innerHTML = '<p class="map-loading">🗺️ Kein Key gesetzt — <code>GOOGLE_MAPS_KEY</code> in <code>.env</code> eintragen.</p>';
  }

  await loadEntries();
  locateUser();
}

init();
