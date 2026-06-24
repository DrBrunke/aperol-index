#!/usr/bin/env bash
# Auf dem VPS: neueste Version holen und Container neu bauen/starten.
set -euo pipefail
cd "$(dirname "$0")"
git fetch --quiet origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date) – Update gefunden, deploye ..."
  git pull --ff-only
  docker compose up -d --build
else
  echo "$(date) – schon aktuell."
fi
