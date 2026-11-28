# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Run with ts-node (development)
npm run build     # Compile TypeScript → dist/
npm start         # Run compiled output (production)
npm run watch     # Watch mode TypeScript compile
```

```bash
npm test              # Vitest suite (test/**/*.test.ts)
npm run test:coverage # same, with coverage; fails below 75% lines (vitest.config.ts)
```

Tests run against a real MongoDB from `mongodb-memory-server` (started once in `test/globalSetup.ts`; each test file gets its own database in `test/setup.ts`). `src/index.ts` only connects, listens and starts tusd, the dispatcher and the cleanup service when run directly (its sweeps are exported functions; their timers are `unref`'d), so tests import the app (`test/helpers/app.ts`) and drive it with supertest; IPFS, tusd, encoders, the gate and webhooks are stubbed per test. CI (`.github/workflows/tests.yml`) runs the type check and the suite with coverage on every pull request.

The `scripts/test-*.ts` files are older standalone checks (run each with `npx ts-node --transpile-only`).

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
- Retries skip encoders in the job's `failedWorkers` when another encoder can take it (see below)

### Retrying on a different encoder

A job that fails (failure webhook), stalls, or can't be sent (dispatch error) goes back to `pending`, and the encoder involved is `$addToSet` into `failedWorkers` on the job. `getNextEncoder` drops those encoders from the pool right after the trusted filter, and only if the tier rules can't place the job without them does it try again with the full pool. So a job is never stuck just because its only suitable encoder failed it once. Like the trusted filter, this only narrows the pool: a gated job can't reach an untrusted encoder through it.

A dispatch error is recorded after the cycle's claim loop, so a job gets at most one dispatch attempt per poll cycle (30 s), and the third failed attempt (`attemptCount` reaching 3, shared with the failure webhook) fails the job and its video.

Community pull uses `failedWorkers: { $ne: encoderName }`, which also matches jobs without the field. `resetJob` (admin retry) clears the list along with `attemptCount`.

Tests: `npx ts-node --transpile-only scripts/test-retry-dispatch.ts` (18 checks, no MongoDB required).

### Pick order

Pending jobs are taken by `priority` descending, then `createdAt` ascending (`PENDING_JOB_SORT`, index `{ status: 1, priority: -1, createdAt: 1 }`), by the managed dispatcher and by community pull alike. The 3Speak checker sets `priority: 1` on a pending job when its owner spends points on a faster encode. It only changes the order: tier, trust and community filters are untouched.

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

### Deferred encoding (`defer_encode`)

Gating must be decided **before** the encoder runs: the encoder is what encrypts, and an unencrypted rendition is public the instant its CID is pinned. But the upload starts as soon as the user reaches the details step, which is the same screen the gated toggle lives on — so eager job creation committed the file before the choice could be made.

`defer_encode: true` on `POST /uploads/token` splits the two:

1. The token response also returns a `finalize_token` (12h TTL, `scope: 'finalize'`).
2. The upload runs normally; `post-finish` pins the input but creates **no job**, parking the video at `status: 'awaiting_encode'`.
3. `POST /video/:permlink/encode` (Bearer finalize token, body `{ gated, allowlist, public_at }`) writes the gating and queues the job atomically, gating first, so the dispatcher can never see a job whose video is not yet marked gated.

Pro status is re-checked at step 3, not trusted from issuance, because it can lapse in between and that is the moment the capability is granted.

A finalize token is rejected by `validateUploadAuth` (before consumption) so it can never be used as upload credentials, and it is bound to one permlink + owner.

Deferred uploads that never reach step 3 are swept after `DEFERRED_ENCODE_ABANDON_HOURS` (12h): the input is unpinned and the row marked failed. This matters most for gated content, since that pinned input is the plaintext original.

Tests: `npx ts-node --transpile-only scripts/test-deferred-encode.ts` (14 checks, no MongoDB required).

### Community encoder version reporting

Encoders running 3speakencoder with `EMBED_REPORT_COMMIT=true` add `encoder_commit` (full 40-char lowercase SHA) and `behind_by` (integer 0–100000) to the `updateNode` `node_info` and to the heartbeat payload. Stored as `encoderCommit` / `behindBy` / `versionReportedAt`; shown in the admin "Version" column and, shortened, on `GET /api/v0/encoders/community`.

Observability only: invalid values are dropped, never rejected, and an encoder that doesn't report is shown as "legacy". Registration describes the code running now, so it clears whatever it doesn't report. Heartbeats only add, because encoders with the flag off never send the fields. Parsing and update building live in `src/utils/encoderVersion.ts` (pure).

Tests: `npx ts-node --transpile-only scripts/test-encoder-version.ts` (31 checks, no MongoDB required).

### Daily upload limits (`src/utils/uploadLimits.ts`)

Warm-up accounts: `UPLOAD_LIMIT_WARMUP_VIDEOS_PER_DAY` (3) videos and `UPLOAD_LIMIT_WARMUP_SHORTS_PER_DAY` (3) shorts per rolling 24h. Free Hive accounts have no upload cap (their limit is on publishing, enforced by the checker; quota answers `exempt: true, reason: 'publish_limit'`) unless `UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true`, which brings back `UPLOAD_LIMIT_VIDEOS_PER_DAY` (1) videos and `UPLOAD_LIMIT_SHORTS_PER_DAY` (3) shorts. On unless `UPLOAD_DAILY_LIMITS_ENABLED=false`. Checked at `POST /uploads/token` AND inside `validateUploadAuth` (so X-API-Key uploads on TUS, simple and chunked are held to it too; the key is public). Other apps: through an API key whose `app_name` is not in `UPLOAD_PUBLISH_CHECK_SKIP_APPS` (default `3speak,3speak-editor`, case-insensitive), a free Hive account is refused (same 429, `plan: 'free'`, `next_at` = checker's `next_free_at`) while the checker's `GET <UPLOAD_PUBLISH_CHECK_URL>/publish-quota/:owner?kind=` (default `https://checker.3speak.tv`) says `allowed: false`, and its quota is the free plan from the checker. The app comes from the key (`keyData.app_name`, or the token's `issuedByKey`), never `frontend_app`. Off with `UPLOAD_PUBLISH_CHECK_ENABLED=false`, and while `UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true`. 3 s timeout, answers and failures cached 30 s per owner+kind. Refusal is a 429 with `code: 'daily_upload_limit'` (contract in README "Upload Limits"); `GET /uploads/quota` reports the allowance.

- Counts rows with `COUNTED_UPLOAD_STATUSES` (`processing`, `awaiting_encode`, `published`) in `embed-video`, index `{ owner: 1, createdAt: -1 }`.
- Stream VODs: X-API-Key + `frontend_app: '3speak-hangouts'` + not short is only a CLAIM (the hangouts server uses the same public key as the browser). It is verified against `stream-stats` / `stream-golive` (owner + permlink = room name) and stored as `stream_vod` on the row; `true` rows never count.
- Media replacements are free: `replaces` (signed token claim, or `replaces` metadata on X-API-Key uploads) is verified by `verifyReplacementTarget` (target exists in embed-video or legacy `videos` AND same owner), stored as `replaces_existing` / `replaces_target`, unlisted from creation. Not counted once registered (`replacesPermlink` set) or within `REPLACEMENT_REGISTER_GRACE_MS` (6h); unregistered after that it counts.
- Exempt: `UPLOAD_LIMIT_EXEMPT`, `isUserPremium`, and free Hive accounts while uncapped. Warm-up = checker `POST /incubation/authors` says `incubating` AND Hive has no account of that name; cached 5 min.
- Everything fails open.

Tests: `npx ts-node --transpile-only scripts/test-upload-limits.ts` (no MongoDB, no network).
