# Deploy auf eurem VPS (Ubuntu 24.04 + nginx + Docker)

Maßgeschneidert für die erkannte Umgebung:
Docker 29 + Compose v5 ✓, nginx 1.24 läuft bereits auf 80/443, Port 3000 frei,
ufw aktiv (80/443/22 offen). Zugriff: **öffentlich**, über eine **Subdomain**.

Ersetze unten `<DOMAIN>` durch eure Subdomain, z.B. `aperol.deinedomain.de`.

---

## 1) DNS

Lege einen **A-Record** (und AAAA, falls IPv6) für `<DOMAIN>` an, der auf die
öffentliche IP des VPS zeigt. Kurz warten, bis es auflöst:

```bash
dig +short <DOMAIN>      # muss die Server-IP zeigen
```

## 2) Code holen & Container starten

```bash
cd /opt
sudo git clone https://github.com/<DEIN_USER>/aperol-index.git
cd aperol-index
sudo docker compose up -d --build
# Test lokal auf dem Server:
curl -s localhost:3000/api/entries     # -> []
```

Der Container lauscht nur auf `127.0.0.1:3000` (nicht öffentlich) – der Zugriff
von außen läuft über nginx.

## 3) nginx-Vhost einrichten

```bash
sudo cp /opt/aperol-index/deploy/nginx.conf /etc/nginx/sites-available/aperol
sudo sed -i 's/<DOMAIN>/aperol.deinedomain.de/' /etc/nginx/sites-available/aperol   # <- anpassen
sudo ln -s /etc/nginx/sites-available/aperol /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Jetzt sollte `http://<DOMAIN>` schon die Seite zeigen.

## 4) HTTPS (Let's Encrypt)

```bash
# certbot installieren, falls noch nicht vorhanden:
sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <DOMAIN>
```

certbot ergänzt automatisch den 443-Block und die Weiterleitung von HTTP→HTTPS.
**Wichtig:** Geolocation (Standort-Priorisierung) funktioniert im Browser nur
über HTTPS – dieser Schritt ist also empfohlen.

## 5) Updates ausrollen

```bash
cd /opt/aperol-index
sudo ./deploy.sh        # git pull + docker compose up -d --build, nur wenn es Änderungen gibt
```

Optional automatisch per Cron (alle 5 Min):

```bash
echo '*/5 * * * * root cd /opt/aperol-index && ./deploy.sh >> /var/log/aperol-deploy.log 2>&1' | sudo tee /etc/cron.d/aperol
```

## Nützliche Befehle

```bash
sudo docker compose logs -f          # Live-Logs
sudo docker compose restart          # Neustart
sudo docker compose down             # stoppen (Daten bleiben im Volume aperol-data)
sudo docker volume inspect aperol-index_aperol-data   # wo die SQLite-DB liegt
```

## Backup der Daten

Die Liste liegt im Docker-Volume `aperol-index_aperol-data`:

```bash
sudo docker run --rm -v aperol-index_aperol-data:/data -v $PWD:/backup alpine \
  tar czf /backup/aperol-backup-$(date +%F).tgz -C /data .
```
