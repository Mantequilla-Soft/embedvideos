# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Run with ts-node (development)
npm run build     # Compile TypeScript → dist/
npm start         # Run compiled output (production)
npm run watch     # Watch mode TypeScript compile
```

No test suite exists. Validation is done by running `dev` and exercising endpoints manually.

## Architecture

### Single-file server (`src/index.ts`)

All route handlers, TUS setup, admin endpoints, webhook receivers, and startup logic live in `src/index.ts`. It is intentionally a monolith. Supporting modules in `src/` are utilities and services only — they contain no route logic.

### Upload flow (the critical path)

TUS server is mounted at `/uploads` via `@tus/server` + `@tus/file-store`. All upload logic runs through two hooks:

- **`onUploadCreate`** — auth (API key or upload token), user ban check, video document creation, returns embed URL in `X-Embed-URL` header
- **`onUploadFinish`** — pins file to IPFS (blocking), creates encoding job, deletes local TUS file

IPFS pinning in `onUploadFinish` is **synchronous and blocking** — the client waits for the full pin before receiving the success response. This is the primary upload latency issue.

After `onUploadFinish`, the `JobDispatcher` (polling every 30s) picks up the `pending` job and dispatches it to an encoder.

### Two encoder dispatch models

**Managed encoders (push):** The dispatcher calls `POST {encoder.url}/encode` directly with the IPFS CID. These encoders must be reachable from this server.

**Community encoders (pull):** They poll `POST /api/v0/gateway/myJob` on their own schedule. Auth is JWS signature (DID-based, via `src/utils/jws.ts`). Community encoders only receive free, non-short jobs (`premium=false, short=false`). They never get push-dispatched.

### Encoder tier system

Encoders have `tier` (`performance` | `standard` | `lite`) and `access` (`managed` | `community`). Dispatch rules in `src/dispatcher/jobDispatcher.ts`:
- Premium jobs → managed performance → fallback managed standard
- Free jobs → managed standard → fallback managed lite
- Short videos → any managed encoder (tier ignored, 480p doesn't need GPU)
- Community encoders always pull; never push-dispatched regardless of tier

### Upload token flow (client-side auth)

Frontends request a short-lived HMAC-SHA256 token from their backend (`POST /uploads/token`, requires API key). The token carries `owner`, `app`, `short`, `maxFileSize`, and `allowedOrigins`. Single-use enforcement uses a MongoDB TTL collection (`embed-upload-tokens`) — token `jti` is inserted atomically; duplicate = rejected.

Token claims override any metadata the TUS client sends, so `owner`/`short`/`frontend_app` in TUS metadata are ignored when a Bearer token is present.

### MongoDB collections

| Collection | Held in |
|---|---|
| `embed-video` | Video metadata, status, CIDs |
| `embed-users` | Users (auto-created on first upload), premium/banned flags |
| `embed-api-keys` | API keys |
| `embed-jobs` | Encoding job queue |
| `embed-encoders` | Encoder registry (seeded from `ENCODERS` env on first start) |
| `spk-encoder-gateway` / `cluster_nodes` | Community encoder DID identity (different DB, same server) |

### Encoder seeding

On startup, `ENCODERS` env (JSON array) is seeded into `embed-encoders` only if the collection is empty. After the first run, encoders are managed via the admin API — env changes are ignored until the collection is wiped.

### Key patterns

- All `/admin/*` routes use `requireAdminAuth` middleware (password from `ADMIN_PASSWORD` env)
- All frontend-facing protected routes use `requireApiKey` middleware
- Mutations return `{ success: true, ... }`
- `isUserPremium(owner)` is the single lookup point for premium status
- `X-Embed-URL` header is set both in `onUploadCreate` (for early capture) and `onUploadFinish` (for tus-js-client `onAfterResponse`)
