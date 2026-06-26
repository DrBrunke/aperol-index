# CLAUDE.md — Aperol Index

> **Pflege-Hinweis an zukünftige Agents:** Diese Datei ist die zentrale Orientierung.
> Wenn du Architektur, API, Datenmodell, Env-Variablen oder den Datenfluss änderst,
> **aktualisiere diese Datei im selben Commit**. Halte sie kurz und faktisch.
> Stand zuletzt geprüft: 2026-06-27.

## Was die App macht

Sammelt **Aperol-Spritz-Preise** von Bars/Restaurants und setzt sie ins Verhältnis
zur **kürzesten Luftlinie ans Meer**. Eine gemeinsame Liste (SQLite) für mehrere
Nutzer. Rein für **privaten Gebrauch** — bewusst minimale, nicht kommerzielle
Sicherheits-/Robustheitsanforderungen.

## Tech-Stack

- **Backend:** Node.js (ESM, `"type": "module"`), Express 4, `better-sqlite3` (synchron), `express-rate-limit`, `@simplewebauthn/server` (FaceID/Passkey-Login).
- **Frontend:** statisches HTML/CSS/Vanilla-JS in `public/` (kein Build-Schritt). Chart.js per CDN.
- **Externe Dienste:** Google Maps JS API (Karte), Google Places API New (Suche), Overpass/OpenStreetMap (Küstenlinie).
- **Deploy:** Docker + docker-compose, hinter nginx Reverse-Proxy. Node >=18 (lokal getestet mit v24).

## Dateien (Verantwortlichkeiten)

| Datei | Zweck |
|-------|-------|
| `server.js` | Express-App: API-Routen, WebAuthn-Auth (Passkey-Registrierung/Login, Sessions, Cookies, Challenge-Store), Rate-Limits, Quota-Sperre, Google-Places-Proxy, Overpass-Proxy, liefert `public/` statisch. |
| `db.js` | SQLite-Zugriff: `entries`-Tabelle + monatlicher Google-Nutzungszähler (`usage`) + `credentials` (Passkeys) + `sessions`. Exporte u.a.: `listEntries`, `addEntry`, `deleteEntry`, `getMonthlyUsage`, `bumpUsage`, `listCredentials`, `getCredential`, `hasCredentials`, `addCredential`, `updateCredentialCounter`, `createSession`, `getSession`, `deleteSession`, `purgeExpiredSessions`. |
| `geo.js` | Reine Geo-Mathematik: `haversine` + `nearestCoastPoint` (Punkt-zu-Segment auf lokaler Meter-Projektion). |
| `public/index.html` | UI-Gerüst: Auth-Overlay, Eingabe-Card, Chart-Card, Rangliste, Stats. |
| `public/app.js` | Gesamte Client-Logik: Auth-Flow, Google-Maps-Loader, Suche, **Standort-Button** (aktuelle GPS-Position als Aperol-Spot), Küsten-Lookup, manuelles Setzen, Validierung, Speichern, Tabelle/Chart/Stats, CSV-Export. |
| `public/styles.css` | Styling. |
| `Dockerfile`, `docker-compose.yml`, `deploy.sh`, `deploy/` | Build & Deployment (nginx-Setup in `deploy/SETUP-UBUNTU-NGINX.md`). |

## API

| Methode | Pfad | Auth | Rate-Limit | Zweck |
|--------|------|------|-----------|-------|
| GET | `/api/config` | nein | – | `{ auth, mapsKey }`. **Bumpt Google-Zähler +1** wenn `GOOGLE_MAPS_KEY` gesetzt (≈ 1 Map-Ladung). |
| GET | `/api/auth/status` | nein | – | `{ enabled, authed, hasCredentials }` — Frontend entscheidet, ob Overlay/Login/Registrierung nötig ist. |
| POST | `/api/auth/register/options` | nein¹ | – | WebAuthn-Registrierungs-Optionen. Body `{ code, label }`; `code` muss `REGISTER_CODE` sein (sonst 403). Setzt Challenge-Cookie. |
| POST | `/api/auth/register/verify` | nein¹ | – | Verifiziert Authenticator-Antwort, speichert Passkey in `credentials`, startet Session-Cookie. |
| POST | `/api/auth/login/options` | nein¹ | – | WebAuthn-Auth-Optionen (discoverable). Setzt Challenge-Cookie. |
| POST | `/api/auth/login/verify` | nein¹ | – | Verifiziert Assertion, aktualisiert Counter, startet Session-Cookie. |
| POST | `/api/auth/logout` | nein | – | Löscht Session + Cookie. |
| GET | `/api/entries` | ja | – | Alle Einträge. |
| POST | `/api/entries` | ja | – | Eintrag anlegen (JSON, siehe Datenmodell). Validiert Pflichtfelder. |
| DELETE | `/api/entries/:id` | ja | – | Eintrag löschen (204 / 404). |
| GET | `/api/search?q=&lat=&lng=` | ja | 30/min | Google Places Text Search (serverseitig, Key bleibt im Backend). `q` >= 3 Zeichen. Bumpt Zähler +1. |
| GET | `/api/coast?lat=&lng=` | ja | 20/min | Nächster Küstenpunkt + Distanz via Overpass (Radien 12/40/120 km, 45 s Gesamt-Timeout). |

¹ Durch Einmal-Code (Registrierung) bzw. WebAuthn-Challenge (Login) selbst abgesichert.

**Auth:** Zugang per **FaceID/TouchID (WebAuthn/Passkeys)**, aktiv wenn `REGISTER_CODE` gesetzt
(leer = App offen). Erstes/neues Gerät wird mit dem Einmal-Code `REGISTER_CODE` freigeschaltet
(`authenticatorAttachment: 'platform'`, discoverable Passkey), danach Login nur per FaceID.
Erfolgreiche Auth setzt einen **HttpOnly-Session-Cookie** `aperol_session` (Default 365 Tage →
"angemeldet bleiben"); Sessions liegen in der `sessions`-Tabelle. WebAuthn braucht **HTTPS**
(Ausnahme localhost) und korrekt gesetzte `RP_ID`/`RP_ORIGIN`. Challenges werden serverseitig
in-memory gehalten (kurzlebiges Cookie `aperol_chal`).

## Datenmodell (`entries`)

`id, name, price (REAL), dist (REAL, Meter), r_lat, r_lng, s_lat, s_lng, created_at`.
`r` = Restaurant-Koordinate, `s` = Meerpunkt. API-Form: `{ id, name, price, dist, r:{lat,lng}, s:{lat,lng}, createdAt }`.
**Wichtig:** `dist` wird in `POST /api/entries` **serverseitig** aus `r`/`s` per `haversine` berechnet;
ein vom Client mitgeschicktes `dist` wird ignoriert.

## Kostenschutz / Quota (zentral!)

- `GOOGLE_MONTHLY_LIMIT` (Default 9000). Bei Erreichen sperrt eine Middleware **die komplette App**
  bis zum Monatsersten: API → 503 `{error:'quota'}`, sonst HTML-Sperrseite (`lockPageHtml`).
- Zähler liegt in Tabelle `usage` pro `YYYY-MM`. Inkrementiert bei `/api/config` (Maps) und `/api/search` (Places).
- Coast/Overpass kostet nichts und zählt nicht.

## Env-Variablen

`PORT` (3000) · `DB_PATH` (`./data/aperol.db`) ·
`REGISTER_CODE` (Einmal-Code; leer = kein Zugangsschutz) · `RP_ID` (Domain ohne Protokoll, Default `localhost`) ·
`RP_ORIGIN` (volle Origin inkl. Protokoll, Default `http://localhost:PORT`) · `RP_NAME` (`Aperol Index`) ·
`SESSION_TTL_DAYS` (365) · `GOOGLE_MAPS_KEY` · `GOOGLE_API_KEY` · `GOOGLE_MONTHLY_LIMIT` (9000).
Vorlage: `.env.example`. `.env` ist gitignored. Google-Keys einschränken: Maps-Key auf HTTP-Referrer, Places-Key auf VPS-IP.
**Wichtig hinter nginx:** `RP_ID`/`RP_ORIGIN` auf die echte HTTPS-Domain setzen, sonst lehnt der Browser FaceID ab.

## Lokal entwickeln

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # node --watch
```

Ohne `GOOGLE_MAPS_KEY` zeigt die Karte einen Hinweis; ohne `GOOGLE_API_KEY` liefert die Suche 501.
DB-Dateien (`data/*.db*`) und `.env` sind gitignored.

## Konventionen

- Code-Kommentare und UI-Texte sind **deutsch**. Bei Änderungen beibehalten.
- Backend ist synchron (better-sqlite3) — keine async-DB-Layer einführen ohne Grund.
- Frontend ohne Framework/Build-Tool halten, solange es geht.
- HTML-Ausgaben im Client immer durch `esc()` escapen (XSS-Schutz in der Tabelle).

## Bekannte Lücken / TODO (Stand 2026-06-27)

- Einträge können **nicht bearbeitet** werden (nur anlegen/löschen).
- `/api/config` ist unauthentifiziert und erhöht den Google-Zähler — wiederholte Aufrufe können den
  Zähler künstlich treiben und die App selbst sperren. Für privaten Gebrauch akzeptiert.
- Keine Duplikat-Erkennung gleicher Bars.
- `created_at` wird gespeichert, aber im UI nicht angezeigt.
- Kein Health-Check-Endpoint für Docker/nginx.
