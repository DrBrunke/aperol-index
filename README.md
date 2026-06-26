# 🍹 Der Aperol Index

Sammelt Aperol-Spritz-Preise verschiedener Bars/Restaurants und setzt sie ins
Verhältnis zur **kürzesten Luftlinie ans Meer**. Frontend + Backend mit
gemeinsamer Datenbank – du und deine Freundin seht dieselbe Liste.

## Features

- **Suche** nach Restaurants/POIs über **Google Places** (Key bleibt serverseitig),
  **priorisiert nach Standort**.
- **Standort-Button**: die aktuelle GPS-Position direkt als Aperol-Spot übernehmen.
- **Interaktive Karte** über die Google Maps JavaScript API.
- **Automatische Luftlinie**: kürzeste lineare Distanz zur nächsten Küstenlinie
  (Overpass-API + Punkt-zu-Segment-Berechnung im Backend); die Distanz wird stets
  serverseitig aus den Koordinaten berechnet.
- **Gemeinsame Liste** über eine REST-API + SQLite – kein localStorage mehr.
- **Rangliste**, **Preis-vs-Meeresnähe-Diagramm** mit Trendlinie, CSV-Export.
- **FaceID/Passkey-Login** (WebAuthn, optional via `REGISTER_CODE`): neues Gerät
  einmal mit Code freischalten, danach Login nur per FaceID/TouchID – inkl.
  „angemeldet bleiben" über Session-Cookie.
- **Kostenschutz**: monatliches Google-Limit, bei Erreichen pausiert die App bis
  zum Monatsersten.

## Architektur

```
aperol-index/
├── server.js            # Express: API + statisches Frontend + Google-/Overpass-Proxy
├── db.js                # SQLite-Zugriff (better-sqlite3) + Google-Nutzungszähler
├── geo.js               # Haversine + kürzeste Distanz zur Küstenlinie
├── public/              # Frontend (statisch)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── Dockerfile
├── docker-compose.yml
├── deploy.sh            # git pull + docker compose up auf dem VPS
├── deploy/              # nginx-Reverse-Proxy-Setup (deploy/SETUP-UBUNTU-NGINX.md)
└── CLAUDE.md            # Orientierung für Agents – bei Änderungen mitpflegen
```

### API

| Methode | Pfad                         | Auth | Zweck                                       |
|--------|-------------------------------|------|---------------------------------------------|
| GET    | `/api/config`                 | nein | `{ auth, mapsKey }` (zählt 1 Map-Ladung)    |
| GET    | `/api/auth/status`            | nein | `{ enabled, authed, hasCredentials }`       |
| POST   | `/api/auth/register/options`  | Code | WebAuthn-Registrierung starten (Einmal-Code)|
| POST   | `/api/auth/register/verify`   | –    | Passkey speichern + Session starten         |
| POST   | `/api/auth/login/options`     | –    | WebAuthn-Login starten                       |
| POST   | `/api/auth/login/verify`      | –    | Login prüfen + Session starten              |
| POST   | `/api/auth/logout`            | nein | Session + Cookie löschen                    |
| GET    | `/api/entries`                | ja   | Alle Einträge                               |
| POST   | `/api/entries`                | ja   | Eintrag anlegen (JSON, `dist` serverseitig) |
| DELETE | `/api/entries/:id`            | ja   | Eintrag löschen                             |
| GET    | `/api/search?q=&lat=&lng=`    | ja   | Google-Places-Suche (Standort-Bias)         |
| GET    | `/api/coast?lat=&lng=`        | ja   | Nächster Küstenpunkt + Distanz (m)          |

„Auth: ja" = gültiger Session-Cookie nötig (nur wenn `REGISTER_CODE` gesetzt ist).

## Lokal starten

```bash
npm install
npm start          # http://localhost:3000
# oder Auto-Reload:
npm run dev
```

Oder per Docker:

```bash
docker compose up --build
```

## Auf GitHub pushen

```bash
cd aperol-index
git init
git add -A
git commit -m "Initial commit: Aperol Index (Frontend + Backend)"
# leeres Repo auf github.com anlegen, dann:
git remote add origin git@github.com:<DEIN_USER>/aperol-index.git
git branch -M main
git push -u origin main
```

## Auf dem VPS deployen

Voraussetzung: Docker + Docker Compose + Git installiert.

```bash
# erstes Mal
cd /opt
git clone git@github.com:<DEIN_USER>/aperol-index.git
cd aperol-index
docker compose up -d --build      # läuft auf Port 3000

# Updates später
./deploy.sh                        # holt git pull + rebuilt den Container
```

Die SQLite-Datenbank liegt im Docker-Volume `aperol-data` und bleibt über
Updates hinweg erhalten.

### Öffentlich erreichbar machen (HTTPS)

Hinter einen Reverse-Proxy setzen und Port 3000 nur lokal binden:

- **nginx**: siehe `deploy/nginx.conf` und die Schritt-für-Schritt-Anleitung in
  `deploy/SETUP-UBUNTU-NGINX.md`, danach `certbot` für HTTPS

Empfehlung: in `docker-compose.yml` `"3000:3000"` auf `"127.0.0.1:3000:3000"`
ändern, damit der Node-Port nicht direkt aus dem Internet erreichbar ist.

### Auto-Deploy bei jedem Push (optional)

```bash
*/5 * * * * /opt/aperol-index/deploy.sh >> /var/log/aperol-deploy.log 2>&1
```

## Zugangsschutz per FaceID / Passkey (optional)

Der Zugang ist per **WebAuthn (FaceID/TouchID/Passkey)** geschützt, sobald
`REGISTER_CODE` gesetzt ist (leer = App komplett offen).

1. `REGISTER_CODE` auf einen geheimen Einmal-Code setzen.
2. Beim ersten Aufruf auf einem neuen Gerät einmalig diesen Code eingeben →
   das Gerät hinterlegt einen Passkey (FaceID/TouchID).
3. Danach meldet sich das Gerät nur noch per FaceID an und bleibt über den
   Session-Cookie angemeldet (`SESSION_TTL_DAYS`, Default 365 Tage).

**Wichtig:** WebAuthn braucht **HTTPS** (Ausnahme: `localhost`). Hinter nginx
müssen `RP_ID` (Domain ohne Protokoll) und `RP_ORIGIN` (volle Origin inkl.
`https://`) auf die echte Domain zeigen, sonst lehnt der Browser FaceID ab:

```bash
RP_ID=aperol.example.com
RP_ORIGIN=https://aperol.example.com
```

Alle Env-Variablen stehen mit Erklärung in `.env.example`.

## Google-Keys einrichten (erforderlich)

Karte und Suche laufen über Google. Beide Keys bleiben **serverseitig** bzw.
werden eingeschränkt; ohne `GOOGLE_MAPS_KEY` zeigt die Karte nur einen Hinweis,
ohne `GOOGLE_API_KEY` liefert die Suche einen 501.

**Keys besorgen:**

1. [Google Cloud Console](https://console.cloud.google.com/) → Projekt anlegen.
2. **Billing** aktivieren (es gibt ein kostenloses Monatskontingent; privater
   Gebrauch bleibt praktisch bei 0 €).
3. Unter *APIs & Dienste* aktivieren: **Maps JavaScript API** (Karte) und
   **Places API (New)** (Suche).
4. *Anmeldedaten* → **API-Key erstellen**. Empfehlung:
   - `GOOGLE_MAPS_KEY`: einschränken auf *Maps JavaScript API* + **HTTP-Referrer** (eure Domain).
   - `GOOGLE_API_KEY`: einschränken auf *Places API (New)* + **IP-Adresse** (eure VPS-IP).
   - Derselbe Key ist möglich, wenn beide APIs erlaubt sind.

**Keys setzen:**

```bash
cp .env.example .env
# .env bearbeiten:  GOOGLE_MAPS_KEY=... und GOOGLE_API_KEY=...
docker compose up -d --build      # liest .env automatisch
```

`.env` ist in `.gitignore` und wird nicht eingecheckt. Lokal ohne Docker:
`GOOGLE_MAPS_KEY=... GOOGLE_API_KEY=... npm start`.

## Kostenschutz

`GOOGLE_MONTHLY_LIMIT` (Default 9000) begrenzt die billbaren Google-Aufrufe
(Karten-Ladungen + Suchen) pro Kalendermonat. Bei Erreichen pausiert die
**komplette App** bis zum Monatsersten (API → 503, Browser → Sperrseite).
Konservativ unter dem kostenlosen Google-Kontingent wählen; `0` = unbegrenzt.

## Hinweis zur Küstenlinie (Overpass/OSM)

Die Küstenlinie wird serverseitig über die öffentliche **Overpass-API**
(OpenStreetMap) ermittelt – mit Fair-Use-Limits, für privaten Gebrauch
unkritisch. Den User-Agent in `server.js` (`const UA = ...`) gern auf eure
echte Repo-URL anpassen.
