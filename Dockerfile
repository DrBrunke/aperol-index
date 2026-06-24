FROM node:20-bookworm-slim

# Build-Tools nur falls für better-sqlite3 kein Prebuilt vorhanden ist.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DB_PATH=/app/data/aperol.db
EXPOSE 3000

# Datenverzeichnis als Volume (persistente DB)
VOLUME ["/app/data"]

CMD ["node", "server.js"]
