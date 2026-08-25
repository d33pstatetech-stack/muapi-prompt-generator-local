# MuAPI Prompt Generator — Local

Browser-only, zero-dependency local version of [muapi-prompt-generator](https://github.com/d33pstatetech-stack/muapi-prompt-generator). No Cloudflare Workers, no auth wall. Your `MUAPI_API_KEY` stays on your machine.

![local badge](https://img.shields.io/badge/mode-local-green)

## What's different vs the Workers version?

| | Workers | Local |
|---|---|---|
| Runtime | Cloudflare Workers + D1 | Node 18+ (`node server.js`) |
| Catalog storage | D1 SQLite | `data/catalog.json` (flat file) |
| Auth | Cloudflare Access (private) | None — runs on `localhost`, key never leaves host |
| Update models | `POST /api/sync` → D1 | `POST /api/sync` → rebuilds `data/catalog.json` from `GET /api/v1/models` + `GET /openapi.json` (same "Update" button in header) |

## Quick start (no Docker)

```bash
cp .env.example .env   # put MUAPI_API_KEY=...
node scripts/build-catalog.js   # first fetch (~629 models, ~10s)
node server.js                  # http://localhost:3000
```

Open http://localhost:3000. The header shows model count + last sync time. Click the sync icon (`↻`) to pull newly released models (e.g. **Wan 3.0** — 10 models added June 2025, absent from the original 609-model D1 snapshot).

## Docker (Linux or Windows)

Works on **Linux** and **Windows** — uses the Linux container engine (WSL2 on Windows via Docker Desktop). No Windows-container image needed.

```bash
# 1. Build + run
docker compose up --build -d

# 2. Logs
docker compose logs -f

# 3. Update catalog inside the running container
curl -X POST http://localhost:3000/api/sync
```

Or plain Docker:

```bash
docker build -t muapi-local .
docker run -p 3000:3000 --env-file .env -v ./data:/app/data muapi-local
```

## Updating

The app does **not** auto-update. When MuAPI ships new models (e.g. Wan 3.0, FLUX 3), click **Update** in the header or:

```bash
node scripts/build-catalog.js   # local
# or
curl -X POST http://localhost:3000/api/sync   # running server
# or
docker exec muapi-local node scripts/build-catalog.js
```

The catalog is fetched live from `https://api.muapi.ai/api/v1/models` + parameter schemas from `https://api.muapi.ai/openapi.json` (same pipeline as the Workers seed script). The sync endpoint writes `data/catalog.json` and swaps it in without a restart.

## Endpoints

Same as the Workers version: `GET /api/models`, `GET /api/models/:id`, `POST /api/generate`, `GET /api/predictions/:id`, `POST /api/upload`, `POST /api/sync`, `GET /api/health`.

## Env

| Var | Required | Default |
|---|---|---|
| `MUAPI_API_KEY` | yes (for generation) | — |
| `PORT` | no | `3000` |
| `MUAPI_BASE_URL` | no | `https://api.muapi.ai/api/v1` |

## Fork note

Forked from `d33pstatetech-stack/muapi-prompt-generator` (Workers + D1). Kept the `public/` frontend as-is; replaced `src/worker.js` + D1 with `server.js` + `data/catalog.json`.
