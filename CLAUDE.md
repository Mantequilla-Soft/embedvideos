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

All route handlers, tusd proxy, hook endpoint, admin endpoints, webhook receivers, and startup logic live in `src/index.ts`. It is intentionally a monolith. Supporting modules in `src/` are utilities and services only — they contain no route logic.

### Upload flow (the critical path)

The `tusd` Go binary (v2.9.2) runs as a child process on `127.0.0.1:1080`, spawned after Express starts. Express proxies all `/uploads/*` traffic to tusd. All upload logic runs through the `POST /tusd-hooks` HTTP endpoint:

- **`pre-create` event** — auth (API key or upload token), user ban check, video document creation (non-partial uploads only), injects `X-Embed-URL` into tusd's 201 response via hook response headers. Partial uploads (parallel chunk pieces) are auth-validated but not DB-recorded — token is consumed only on the final concatenated upload.
- **`post-finish` event** — tusd fires this *after* the 204 has already been sent to the client. The hook responds immediately, then runs IPFS pinning, DHT announcement, job creation, and temp file cleanup asynchronously via `setImmediate`.

IPFS pinning is **asynchronous** — clients receive their success response the moment the file lands on disk. tusd's Concatenation extension (enabled by default) allows `tus-js-client` `parallelUploads: 3` so three 10MB chunks upload simultaneously.

After IPFS pinning completes, the `JobDispatcher` (polling every 30s) picks up the `pending` job and dispatches it to an encoder.

### Two encoder dispatch models

**Managed encoders (push):** The dispatcher calls `POST {encoder.url}/encode` directly with the IPFS CID. These encoders must be reachable from this server.

**Community encoders (pull):** They poll `POST /api/v0/gateway/myJob` on their own schedule. Auth is JWS signature (DID-based, via `src/utils/jws.ts`). Community encoders only receive free, non-short jobs (`premium=false, short=false`). They never get push-dispatched.

### Encoder tier system

Encoders have `tier` (`performance` | `standard` | `lite`) and `access` (`managed` | `community`). Dispatch rules in `src/dispatcher/jobDispatcher.ts`:
- Premium jobs → managed performance → fallback managed standard
- Free jobs → managed standard → fallback managed lite
- Short videos → any managed encoder (tier ignored, 480p doesn't need GPU)
- Community encoders always pull; never push-dispatched regardless of tier
- **Gated jobs → `trusted: true` managed encoders only, any tier, no fallback**

### Gated (paid) content and encoder trust

Videos with `gated: true` are AES-128 encrypted at encode time; only `3speak-gate` can hand a viewer the key. Dispatch is restricted to encoders carrying `trusted: true`.

This restriction is **not** about key handling. An encoder cannot transcode what it cannot read, so it holds the plaintext source of every video it touches. Trust means "we operate this machine", nothing weaker. There is no fallback: a gated job with no trusted encoder available goes back to `pending` and retries rather than dispatching to an untrusted node, because the disclosure cannot be undone.

The trusted filter is applied **once, up front**, narrowing the candidate pool before the ordinary tier rules run. Do not re-implement it per branch: every existing fallback (premium → standard, short-video `maxFileSize` bypass) would otherwise need its own copy, and the one that gets missed is a leak.

Three independent guards, because a single missed check publishes paid content:
1. `getNextEncoder` filters to trusted candidates for gated jobs
2. `dispatchJob` re-asserts `encoder.trusted === true` immediately before the request
3. `claimNextCommunityJob` filters `gated: { $ne: true }`, and `/api/v0/gateway/myJob` re-checks the **video** after claiming and resets the job if it is gated

Guard 3 uses `$ne: true` rather than an equality on `false` (unlike the neighbouring `premium`/`short` checks) because `gated` is a new field: demanding `gated: false` would strand every pre-existing pending job.

`trusted` is settable only through `POST/PATCH /admin/encoders`, and is rejected for `access: 'community'`. `upsertCommunityEncoder` writes a fixed field whitelist, so a self-registering node cannot grant itself the flag.

Tests: `npx ts-node --transpile-only scripts/test-gated-dispatch.ts` (14 checks, no MongoDB required).

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
- `X-Embed-URL` header is injected in the `pre-create` hook response (captured by tus-js-client `onAfterResponse` on the 201 Created)
