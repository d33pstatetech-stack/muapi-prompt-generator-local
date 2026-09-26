# MuAPI Prompt Generator — Local

The same interface as [muapi-prompt-generator](https://github.com/d33pstatetech-stack/muapi-prompt-generator), running on plain Node with no Cloudflare account, no Access wall, and no hosted database. The MuAPI key stays in a local `.env` and never leaves the machine.

Useful when the hosted deployment is unavailable, when a key should not be put behind a shared login, or simply to avoid a network hop.

---

## Contents

- [What differs from the Workers version](#what-differs-from-the-workers-version)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Updating the catalog](#updating-the-catalog)
- [Endpoints](#endpoints)
- [Environment](#environment)
- [Private LoRA proxy](#private-lora-proxy)
- [Prompt enhancer](#prompt-enhancer)
- [Content scope](#content-scope)
- [License](#license)

---

## What differs from the Workers version

| | Workers | Local |
|---|---|---|
| Runtime | Cloudflare Workers + D1 + R2 | Node 18+, single `server.js` |
| Catalog storage | D1 SQLite, synced in place | `data/catalog.json`, rebuilt from the API |
| Model count | 723 (live D1) | 629 as shipped; re-sync to refresh |
| Auth | Cloudflare Access (private) | None — binds to localhost, key never leaves the host |
| Output capture | R2 bucket, free egress | None — outputs stay as provider URLs |
| Run history | Shared `genai-history` D1, cross-app | `localStorage` only |
| Cost | Free hosting, metered inference | Free hosting, metered inference |

Everything else is deliberately the same: the prompt enhancer, the LoRA picker with
its compatibility tiers, the parameter forms, the library modals, and the API
surface. Code that differs is limited to storage — the local server reads and
writes flat JSON where the Worker reads and writes D1.

The catalog is rebuilt rather than mutated in place, so it can lag the hosted
version until `POST /api/sync` is called.

---

## Requirements

- Node 18 or newer
- A MuAPI API key
- Optional: keys for whichever LLM provider the enhancer should use

No dependencies are installed for the server itself — it is stdlib only, using the
built-in `fetch` available from Node 18 onward.

---

## Quick start

```bash
cp .env.example .env      # add MUAPI_API_KEY=...
node scripts/build-catalog.js   # first fetch: 629 models, ~10s
node server.js                  # http://localhost:3000
```

The header shows the model count and last sync time. The sync control (`↻`) pulls
newly released models without a restart.

To confirm the server is up:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","mode":"local","models":629,"synced_at":"…","hasApiKey":true}
```

`.env` is gitignored. It is read directly by `server.js`, so the file must be in
the project root.

---

## Docker

Works on Linux and on Windows via Docker Desktop with WSL2 — a Linux container
engine, so no Windows-container image is needed.

```bash
docker compose up --build -d
docker compose logs -f
```

Or plain Docker:

```bash
docker build -t muapi-local .
docker run -p 3000:3000 --env-file .env -v ./data:/app/data muapi-local
```

The `./data` mount is what makes the catalog and prompt history survive a
container rebuild. Without it the container starts from whatever the image baked
in and re-syncs on first start.

---

## Updating the catalog

The app does not auto-update. When MuAPI ships new models, use the header control
or:

```bash
node scripts/build-catalog.js              # rebuild data/catalog.json
curl -X POST http://localhost:3000/api/sync  # or trigger it on a running server
```

The catalog comes from `https://api.muapi.ai/api/v1/models` with parameter schemas
matched from `https://api.muapi.ai/openapi.json` — the same pipeline as the
Workers seed script. Sync rewrites `data/catalog.json` and swaps it in without a
restart.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Model count, last sync, key status |
| GET | `/api/models` | Catalog listing — `?category=&family=&q=&limit=` |
| GET | `/api/categories` | Category counts |
| POST | `/api/sync` | Rebuild the catalog from the MuAPI API |
| POST | `/api/generate` | Submit a job — `{modelId, params}` |
| GET | `/api/predictions/:id` | Poll a job |
| POST | `/api/upload` | Upload a reference file → hosted URL |
| POST | `/api/estimate` | Cost estimate without generating |
| POST | `/api/enhance` | Stream an enhanced prompt (SSE) |
| POST | `/api/optimize` | Same, buffered to JSON |
| GET/PUT | `/api/llm-config` | Read (redacted) or write the enhancer's LLM chain, stored in `data/llm.json` |
| GET | `/api/prompts` | List persisted prompts (`data/prompts.json`) |
| GET | `/api/hf/file` | Proxy an allowlisted private Hugging Face repo |

There is no auth on any route, which is safe only because the server binds to
localhost. Do not expose this port.

---

## Environment

| Var | Required | Default |
|---|---|---|
| `MUAPI_API_KEY` | yes, for generation | — |
| `PORT` | no | `3000` |
| `MUAPI_BASE_URL` | no | `https://api.muapi.ai/api/v1` |
| `OPENROUTER_API_KEY` | for enhancer | — |
| `VENICE_API_KEY` | optional, alternative provider | — |
| `HUGGINGFACE_API_KEY` | for the private LoRA proxy | — |
| `HF_PROXY_REPO_ALLOWLIST` | no | empty (deny all) |
| `HF_PROXY_BASE_URL` | no | the request's own host |

---

## Private LoRA proxy

`GET /api/hf/file?repo=owner/repo&file=…` serves a Hugging Face file using
`HUGGINGFACE_API_KEY`, so a private LoRA can be referenced by URL without the key
ever appearing in a LoRA field. When a generation is submitted, any allowlisted
Hugging Face URL in the payload is rewritten to point at this local endpoint so
MuAPI's servers can fetch it.

The endpoint has to be reachable without credentials for that to work, which is
exactly why it is allowlisted. An open proxy would let anything on the network
spend this machine's Hugging Face token to download arbitrary files, so
`HF_PROXY_REPO_ALLOWLIST` is empty by default and only exact `owner/repo` entries
or `owner/*` wildcards are honoured:

```bash
# .env
HF_PROXY_REPO_ALLOWLIST=my-hf-user/some-private-lora,my-hf-user/*
```

Weight downloads are proxied without `Range` support in this build, so large files
are buffered whole; keep that in mind for multi-gigabyte adapters.

---

## Prompt enhancer

The enhancer rewrites a prompt for the selected model, adding sound-effect and
dialogue cues when the target generates audio and timestamp directions for video
models based on the requested duration. Output streams to the browser as
server-sent events and the full text is persisted to `data/prompts.json`.

Providers are tried in order until one succeeds:

1. `https://openrouter.ai/api/v1` — `liquid/lfm-2.5-2.6b:free`
2. `https://openrouter.ai/api/v1` — `openrouter/free`
3. `https://api.venice.ai/api/v1` — `venice-uncensored`

The chain can be replaced through Settings → LLM and is stored in `data/llm.json`.
Keys entered there are returned redacted (`***`) rather than echoed back.

`scripts/venice-test.js` is a standalone smoke test that issues a single
`/chat/completions` request against a chosen provider and model — useful for
confirming a key and a model ID before wiring either into the chain:

```bash
node scripts/venice-test.js
```

The system prompt is deliberately framed as format optimization only, so the
enhancer performs mechanical conversion for any subject matter and leaves content
policy to the downstream generative model.

---

## Content scope

This is a prompt-engineering tool, and it treats prompts as an optimization
problem rather than a content-moderation one. The enhancer does not filter: it
rewrites a prompt for the target model regardless of subject matter and leaves
policy to MuAPI and the individual model.

The LoRA picker keeps uncensored and adult-oriented adapters in a separate bucket
(`NSFW_LORAS` in `public/loras.js`) so the default view stays clean. Those are
ordinary public community checkpoints; the only thing distinguishing them is
which list they appear in, and they are handled identically to any other adapter.
The curated list alongside them is public community adapters spanning FLUX.1,
Qwen-Image, Krea, and Wan 2.1, one per family the compatibility filter
understands.

Use of any adapter is subject to the licence of the individual checkpoint and to
the terms of the service actually generating the output.

---

## License

MIT
