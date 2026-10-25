# ============================================================
# TradingControl Bot
#
# Alle fuenf Arbeitsbereiche gehoeren hinein. Fruehere Fassungen kannten
# nur core und docker-bot — mit indicators, copytrading und signals
# scheiterte der Bau an fehlenden Abhaengigkeiten.
# ============================================================

FROM node:22-alpine AS builder
WORKDIR /app

# Erst die Manifeste, dann npm ci: So bleibt die Schicht mit den
# Abhaengigkeiten erhalten, solange sich nur Quelltext aendert.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/indicators/package.json ./packages/indicators/
COPY packages/copytrading/package.json ./packages/copytrading/
COPY packages/signals/package.json ./packages/signals/
COPY packages/docker-bot/package.json ./packages/docker-bot/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/core/ ./packages/core/
COPY packages/indicators/ ./packages/indicators/
COPY packages/copytrading/ ./packages/copytrading/
COPY packages/signals/ ./packages/signals/
COPY packages/docker-bot/ ./packages/docker-bot/

# Der Bau kopiert die Oberflaeche selbst nach dist (copy-ui.mjs).
RUN npm run build

FROM node:22-alpine
RUN addgroup -g 1001 botgroup && adduser -u 1001 -G botgroup -s /bin/sh -D botuser
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./

COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/indicators/package.json ./packages/indicators/
COPY --from=builder /app/packages/indicators/dist ./packages/indicators/dist
COPY --from=builder /app/packages/copytrading/package.json ./packages/copytrading/
COPY --from=builder /app/packages/copytrading/dist ./packages/copytrading/dist
COPY --from=builder /app/packages/signals/package.json ./packages/signals/
COPY --from=builder /app/packages/signals/dist ./packages/signals/dist
COPY --from=builder /app/packages/docker-bot/package.json ./packages/docker-bot/
COPY --from=builder /app/packages/docker-bot/dist ./packages/docker-bot/dist

RUN npm ci --omit=dev --workspaces && \
    mkdir -p /app/data /app/logs && \
    chown -R botuser:botgroup /app/data /app/logs

USER botuser

# Der Bot lauscht auf WEB_PORT, voreingestellt 3300.
EXPOSE 3300

# Die Pruefung laeuft gegen den Webhook-Ping: Er liegt vor der
# Passwortabfrage und antwortet ohne Zugangsdaten.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3300/webhook/signal/ping || exit 1

CMD ["node", "packages/docker-bot/dist/server.js"]
