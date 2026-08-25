# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests first (cache-friendly)
COPY package.json ./

# No npm deps (zero-dependency server), but keep layer for future deps
RUN npm install --omit=dev 2>/dev/null || true

# App source
COPY server.js ./
COPY scripts ./scripts
COPY public ./public

# Data dir — pre-seeded at build time so the image works offline
# (rebuilt on first run and on POST /api/sync)
RUN mkdir -p data

# Build catalog at image-build time (best-effort; falls back to runtime build)
RUN node scripts/build-catalog.js || echo "catalog build deferred to runtime"

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
