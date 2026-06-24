# 🍹 Der Aperol Index

Sammelt Aperol-Spritz-Preise verschiedener Bars/Restaurants und setzt sie ins
Verhältnis zur **kürzesten Luftlinie ans Meer**. Frontend + Backend mit
gemeinsamer Datenbank – du und deine Freundin seht dieselbe Liste.

## Features

- **Suche** nach Restaurants/POIs (OpenStreetMap), **priorisiert nach Standort**.
- **Automatische Luftlinie**: kürzeste lineare Distanz zur nächsten Küstenlinie
  (Overpass-API + Punkt-zu-Segment-Berechnung im Backend).
- **Gemeinsame Liste** über eine REST-API + SQLite – kein localStorage mehr.
- **Rangliste**, **Preis-vs-Meeresnähe-Diagramm** mit Trendlinie, CSV-Export.
- OSM-Aufrufe laufen serverseitig (eigener User-Agent, kein CORS-Problem).

## Architektur

```
aperol-index/
├── server.js            # Express: API + statisches Frontend + OSM-Proxy
├── db.js                # SQLite-Zugriff (better-sqlite3)
├── geo.js               # Haversine + kürzeste Distanz zur Küstenlinie
├── public/              # Frontend (statisch)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── Dockerfile
├── docker-compose.yml
├── deploy.sh            # git pull + docker compose up auf dem VPS
└── deploy/              # Reverse-Proxy-Beispiele (Caddy / nginx)
```

### API

| Methode | Pfad                      | Zweck                                  |
|--------|----------------------------|----------------------------------------|
| GET    | `/api/entries`             | Alle Einträge                          |
| POST   | `/api/entries`             | Eintrag anlegen (JSON)                 |
| DELETE | `/api/entries/:id`         | Eintrag löschen                        |
| GET    | `/api/search?q=&lat=&lng=` | Restaurant-/POI-Suche (Standort-Bias)  |
| GET    | `/api/coast?lat=&lng=`     | Nächster Küstenpunkt + Distanz (m)     |

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

- **Caddy** (am einfachsten, HTTPS automatisch): siehe `deploy/aperol.caddy`
- **nginx**: siehe `deploy/nginx.conf`, danach `certbot` für HTTPS

Empfehlung: in `docker-compose.yml` `"3000:3000"` auf `"127.0.0.1:3000:3000"`
ändern, damit der Node-Port nicht direkt aus dem Internet erreichbar ist.

### Auto-Deploy bei jedem Push (optional)

```bash
*/5 * * * * /opt/aperol-index/deploy.sh >> /var/log/aperol-deploy.log 2>&1
```

## Bessere Suche via Google Places (optional)

OpenStreetMap hat bei kleinen Bars/Beach Clubs Lücken. Mit einem Google-Places-
Key liefert die Suche deutlich mehr Treffer. Der Key bleibt **serverseitig**
(nie im Browser). Ohne Key läuft die Suche automatisch über OSM.

**Key besorgen:**

1. [Google Cloud Console](https://console.cloud.google.com/) → Projekt anlegen.
2. **Billing** aktivieren (es gibt ein kostenloses Monatskontingent; privater
   Gebrauch bleibt praktisch bei 0 €).
3. Unter *APIs & Dienste* die **Places API (New)** aktivieren.
4. *Anmeldedaten* → **API-Key erstellen**. Empfehlung: Key einschränken auf die
   *Places API* und – da serverseitig – per **IP-Adresse** auf eure VPS-IP.

**Key setzen:**

```bash
cp .env.example .env
# .env bearbeiten:  GOOGLE_API_KEY=dein_key_hier
docker compose up -d --build      # liest .env automatisch
```

`.env` ist in `.gitignore` und wird nicht eingecheckt. Lokal ohne Docker:
`GOOGLE_API_KEY=... npm start`.

## Hinweis zu den OSM-Diensten

Suche (Photon/Nominatim), Küste (Overpass) und Kartenkacheln nutzen öffentliche
OpenStreetMap-Server mit Fair-Use-Limits. Für privaten Gebrauch unkritisch; bei
hoher Last bitte eigene Instanzen hosten. Den User-Agent in `server.js`
(`const UA = ...`) gern auf eure echte Repo-URL anpassen.
