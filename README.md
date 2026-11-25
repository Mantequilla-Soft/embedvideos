<h1 align="center">3Speak Embed Video Upload</h1>

<p align="center">
  <strong>Resumable video uploads, encoding and an embeddable player for any Hive frontend or website.</strong><br>
  Upload with tus, get the embed URL before the first byte moves, and let the encoders do the rest.
</p>

<p align="center">
  <img alt="TypeScript 5.3" src="https://img.shields.io/badge/TypeScript-5.3-3178C6">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933">
  <img alt="Express 4.18" src="https://img.shields.io/badge/Express-4.18-000000">
  <img alt="MongoDB driver 6" src="https://img.shields.io/badge/MongoDB-6-47A248">
  <img alt="tusd 2.9.2" src="https://img.shields.io/badge/tusd-2.9.2-0F7DC2">
  <img alt="Vitest 3.2" src="https://img.shields.io/badge/Vitest-3.2-6E9F18">
  <a href="https://github.com/Mantequilla-Soft/embedvideos/actions/workflows/tests.yml"><img alt="tests" src="https://github.com/Mantequilla-Soft/embedvideos/actions/workflows/tests.yml/badge.svg"></a>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

This is the upload and encoding service behind 3Speak videos. Any app (a Hive frontend, a
mobile app, a plain website) can hand a video file to it and get back a player URL such as
`https://play.3speak.tv/embed?v=badadib/yn77aj9g` that works the moment the upload starts:
the player shows an uploading or processing state until the encoded HLS stream is ready.

The hard parts stay on this side. Uploads are resumable ([tus](https://tus.io), with
parallel chunks), and there are single-request and chunked fallbacks for networks that
block tus. Finished files are pinned to IPFS and queued for encoding on a pool of encoder
nodes, from 3Speak-run machines to community encoders that pull work on their own. Your
app needs one API key, kept on your server, and never has to run ffmpeg, IPFS or a job
queue.

## Contents

- [How it works](#how-it-works)
- [Use it in your app](#use-it-in-your-app): [token](#1-get-an-upload-token-server-side) · [upload](#2-upload-from-the-browser) · [poll](#3-track-progress) · [embed](#4-embed-the-video) · [link the post](#5-link-the-hive-post-optional)
- [Quick start](#quick-start) (run your own instance)
- [Configuration](#configuration)
- [Reference](#reference): [auth](#authentication) · [uploads](#uploads) · [videos](#videos) · [upload limits](#daily-upload-limits) · [service](#service-and-encoders) · [admin](#admin)
- [Development and tests](#development-and-tests)
- [Repository layout](#repository-layout)
- [Security notes](#security-notes)
- [Contributing](#contributing)

## How it works

```
 your backend ── POST /uploads/token (X-API-Key) ──▶ embedvideos ──▶ MongoDB (video row: uploading)
      │ token, permlink, embed_url                       │
      ▼                                                  │ /uploads is proxied to tusd on 127.0.0.1
 browser ── tus upload (Bearer token) ──────────────────▶│ tusd hooks: pre-create (auth, limits)
                                                         │             post-finish (async)
                                                         ▼
                                         pin to local IPFS, announce, create job (processing)
                                                         │
                     job dispatcher, every 30 s ─────────┤
                       managed encoders: POST {url}/encode (push)
                       community encoders: poll /api/v0/gateway/myJob (pull)
                                                         │
                     encoder ── POST /webhook (manifest_cid) ──▶ video row: published
                                                         │
 viewer ◀── https://play.3speak.tv/embed?v=owner/permlink (player, separate project)
```

1. **Upload starts.** The `pre-create` hook checks the API key or upload token, the owner's
   ban flag and the daily upload limit, then creates the video row (`uploading`). The embed
   URL is known at this point, so the client can show or post it right away.
2. **Upload finishes.** tusd answers the client first. Then, in the background, the file is
   pinned to the local IPFS daemon, its CID is announced to the DHT, an encoding job is
   created (`pending`) and the temp file is removed. The video row moves to `processing`.
3. **Encoding.** The dispatcher picks an encoder by tier (premium jobs prefer
   `performance` encoders, free jobs `standard`, shorts any managed encoder). Community
   encoders only pull free, non-short jobs. A job that fails, stalls or cannot be sent goes
   back to `pending` and avoids the encoder that failed it; the third failed attempt fails
   the job. Encoders report progress to `/webhook/progress` and the result to `/webhook`.
4. **Published.** The row gets its `manifest_cid` and turns `published`; the embed URL now
   plays the HLS stream.

Paid ("gated") videos are AES-128 encrypted at encode time and only go to encoders marked
`trusted`. See [CLAUDE.md](CLAUDE.md) for the design notes on gating, deferred encoding,
encoder tiers and retries, and [ENCODERS.md](ENCODERS.md) for the `ENCODERS` seed format.

## Use it in your app

The flow below is the recommended one for web apps: the API key stays on your server and
the browser only ever sees a short-lived, single-use upload token. The hosted instance is
`https://embed.3speak.tv`; API keys are issued by whoever runs the instance (for
embed.3speak.tv, ask the 3Speak team on [Discord](https://discord.gg/NSFS2VGj83)).

> **This service does not verify `owner`.** Whoever holds an API key can upload under any
> owner name. Authenticate your user (Hive Keychain, HiveSigner, your own login) on your
> backend before you ask for a token in their name.

### 1. Get an upload token (server side)

```js
// Your backend. EMBED_API_KEY never reaches the browser.
const res = await fetch('https://embed.3speak.tv/uploads/token', {
  method: 'POST',
  headers: { 'X-API-Key': process.env.EMBED_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    owner: 'badadib',                         // the Hive account the video belongs to
    frontend_app: 'my-video-app',
    short: false,                             // true for a Short (encoded at 480p)
    allowed_origins: ['https://my-video-app.com'],
    ttl: 600,                                 // seconds, capped by UPLOAD_TOKEN_MAX_TTL
  }),
});
if (res.status === 429) { /* daily upload limit: show body.message, see below */ }
const { token, upload_url, permlink, embed_url, expires_at } = await res.json();
// Hand token, upload_url and embed_url to the browser.
```

The `permlink` and `embed_url` are fixed at issuance and bound to the token, so you have
the final embed URL before the upload starts. Full body and response:
[POST /uploads/token](#post-uploadstoken).

### 2. Upload from the browser

```js
import * as tus from 'tus-js-client';

const upload = new tus.Upload(file, {
  endpoint: upload_url,                          // from step 1
  headers: { Authorization: `Bearer ${token}` }, // from step 1
  metadata: { filename: file.name, filetype: file.type }, // owner/short come from the token
  chunkSize: 10 * 1024 * 1024,
  parallelUploads: 3,                            // tus Concatenation is enabled
  retryDelays: [0, 1000, 3000, 5000],
  onProgress: (sent, total) => console.log(`${((sent / total) * 100).toFixed(1)}%`),
  onError: (err) => console.error(err),          // 429/401/403/413 carry a JSON body
  onSuccess: () => console.log('Uploaded, now encoding:', embed_url),
});
upload.start();
```

With `parallelUploads`, always use the token's `embed_url`: the `X-Embed-URL` response
header is still sent for older clients, but it can be missed on the final concatenation
request. If tus `PATCH` requests are blocked on the user's network, fall back to
[`/upload/simple` or the chunked endpoints](#fallback-uploads) with the same token.

### 3. Track progress

`GET /video/:permlink` is public and returns the video row. Poll it every few seconds:

```js
async function waitForVideo(permlink) {
  const video = await (await fetch(`https://embed.3speak.tv/video/${permlink}`)).json();
  if (video.status === 'published') return video;            // video.manifest_cid is set
  if (video.status === 'failed') throw new Error('Encoding failed');
  console.log(video.status, `${video.encodingProgress}%`);   // uploading / processing, 0 to 100
  await new Promise((r) => setTimeout(r, 5000));
  return waitForVideo(permlink);
}
```

```text
uploading ──▶ processing ──▶ published
    │              └──────▶ failed
    └──▶ awaiting_encode (only with defer_encode, until POST /video/:permlink/encode)
```

Polling is optional: the player already shows the uploading and processing states.

### 4. Embed the video

```html
<iframe src="https://play.3speak.tv/embed?v=badadib/yn77aj9g"
        width="100%" height="500" frameborder="0" allowfullscreen></iframe>
```

For Hive post bodies (PeakD, Ecency and other composers), the landing page in
[`public/index.html`](public/index.html) uses the plain video tag form:

```html
<video src="play.3speak.tv/watch?v=badadib/yn77aj9g" controls></video>
```

The player itself is a separate project; this service only builds the URL
(`BASE_URL?v={owner}/{permlink}`).

### 5. Link the Hive post (optional)

After you broadcast the Hive post that carries the video, tell the service which post it
belongs to:

```bash
curl -X POST https://embed.3speak.tv/video/yn77aj9g/hive \
  -H "X-API-Key: <your-api-key>" -H "Content-Type: application/json" \
  -d '{"hive_author": "badadib", "hive_permlink": "my-first-video", "hive_title": "My first video", "hive_tags": ["3speak"]}'
```

The first link wins: a later call naming a different post is a no-op that returns
`relinked: false` with the existing link, while repeating the same post is idempotent.

Server-to-server apps and mobile apps can skip step 1 and upload with the `X-API-Key`
header directly, passing `owner`, `frontend_app` and `short` as tus metadata
([details](#authentication)).

## Quick start

Run your own instance. You need Node.js 20 or newer, MongoDB, a local IPFS daemon
(Kubo, API on `127.0.0.1:5001`) and at least one encoder node such as
[3speakencoder](https://github.com/Mantequilla-Soft/3speakencoder).

```bash
git clone https://github.com/Mantequilla-Soft/embedvideos.git
cd embedvideos
npm install
bash scripts/install-tusd.sh   # downloads tusd v2.9.2 (linux_amd64) to ./bin/tusd
cp .env.example .env           # then set MONGODB_URI, ADMIN_PASSWORD, UPLOAD_TOKEN_SECRET,
                               # WEBHOOK_API_KEY, WEBHOOK_URL and ENCODERS
npm run dev                    # ts-node; or: npm run build && npm start
```

The server starts tusd as a child process once Express is listening, so there is nothing
else to launch. Then:

1. Open `http://localhost:3000/admin.html` (default `PORT` is 3000), sign in with
   `ADMIN_PASSWORD` and create an API key for your app.
2. Try an upload in `http://localhost:3000/demo.html`, or follow
   [Use it in your app](#use-it-in-your-app) against `http://localhost:3000`.
3. `GET /health` reports `status`, `activeUploads` and `freeDiskPct`.

Put a reverse proxy with TLS in front for production; the app trusts `X-Forwarded-*`
headers (`trust proxy` is on) and builds `upload_url` from them.

## Configuration

Set in `.env` (template: [.env.example](.env.example)). Names and defaults only; never
commit real values.

**Core**

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `MONGODB_URI` | MongoDB connection string | none (required) |
| `MONGODB_DATABASE` | Database name | `threespeak` |
| `MONGODB_COLLECTION_VIDEOS` | Videos collection | `embed-video` |
| `MONGODB_COLLECTION_USERS` | Users collection | `embed-users` |
| `MONGODB_COLLECTION_KEYS` | API keys collection | `embed-api-keys` |
| `MONGODB_COLLECTION_JOBS` | Encoding jobs collection | `embed-jobs` |
| `LEGACY_VIDEOS_COLLECTION` | Pre-embed 3Speak videos, used for media replacement | `videos` |
| `UPLOAD_DIR` | Temp storage for uploads in flight | `./uploads` |
| `TUSD_PORT` | Port tusd listens on (127.0.0.1 only) | `1080` |
| `TUSD_BINARY_PATH` | Path to the tusd binary | `./bin/tusd` |
| `MAX_UPLOAD_SIZE` | Hard cap per video in bytes, every upload path | 5 GiB |
| `BASE_URL` | Player base for embed URLs | `https://play.3speak.tv/embed` |
| `ADMIN_PASSWORD` | Admin panel and `/admin/*` password | `change-me-in-production` (change it) |
| `IP_HASH_SECRET` | Key for the keyed uploader address hashes; empty records nothing | empty |

**Upload tokens**

| Variable | Purpose | Default |
|---|---|---|
| `UPLOAD_TOKEN_SECRET` | HMAC key for upload tokens; empty disables `POST /uploads/token` (503) | empty |
| `UPLOAD_TOKEN_DEFAULT_TTL` | Token lifetime when the request names none (s) | `600` |
| `UPLOAD_TOKEN_MAX_TTL` | Longest token lifetime allowed (s) | `1800` |
| `UPLOAD_TOKEN_MAX_FILE_SIZE` | Largest file a token allows (bytes) | 1 GiB |

**Encoding**

| Variable | Purpose | Default |
|---|---|---|
| `ENCODERS` | JSON array that seeds the encoder registry on first start (see [ENCODERS.md](ENCODERS.md)) | empty |
| `ENCODER_API_URL`, `ENCODER_API_KEY` | Legacy single-encoder seed, used when `ENCODERS` is empty | empty |
| `WEBHOOK_URL` | Callback URL sent to encoders with each job | empty |
| `WEBHOOK_API_KEY` | Key managed encoders send to `/webhook` and `/webhook/progress` | empty (set it) |
| `DISPATCHER_ENABLED` | `false` on a secondary instance sharing the jobs collection, so only one dispatches | on |
| `CLEANUP_ENABLED` | Periodic removal of stale temp upload files | on |
| `CLEANUP_INTERVAL_HOURS` | Cleanup interval | `24` |
| `CLEANUP_RETENTION_DAYS` | Age after which temp files are removed | `7` |

`ENCODERS` only seeds an empty registry; after the first start, encoders are managed in
the admin panel and env changes are ignored.

**Gated (paid) content**

| Variable | Purpose | Default |
|---|---|---|
| `GATE_URL` | 3speak-gate service; empty refuses gated uploads (503 `gate_not_configured`) | empty |
| `GATE_INTERNAL_API_KEY` | Key for the gate service | empty |
| `GATE_CDN_BASE` | Base the gate fetches encrypted manifests from | `https://ipfs.3speak.tv/ipfs` |

**Daily upload limits** (see [Daily upload limits](#daily-upload-limits))

| Variable | Purpose | Default |
|---|---|---|
| `UPLOAD_DAILY_LIMITS_ENABLED` | `false` switches the limits off | on |
| `UPLOAD_LIMIT_FREE_UPLOADS_CAPPED` | `true` caps free Hive accounts' uploads too | off |
| `UPLOAD_LIMIT_VIDEOS_PER_DAY` | Videos per 24 h, free Hive account, while capped | `1` |
| `UPLOAD_LIMIT_SHORTS_PER_DAY` | Shorts per 24 h, free Hive account, while capped | `3` |
| `UPLOAD_LIMIT_WARMUP_VIDEOS_PER_DAY` | Videos per 24 h, warm-up account | `3` |
| `UPLOAD_LIMIT_WARMUP_SHORTS_PER_DAY` | Shorts per 24 h, warm-up account | `3` |
| `UPLOAD_LIMIT_EXEMPT` | Comma list of owners never limited | empty |
| `UPLOAD_LIMIT_WARMUP_LOOKUP_URL` | Warm-up account registry | `https://checker.3speak.tv/incubation/authors` |
| `UPLOAD_LIMIT_HIVE_NODES` | Comma list of Hive API nodes | `api.hive.blog`, `api.deathwing.me`, `anyx.io` |
| `UPLOAD_UPGRADE_URL` | `upgrade_url` in refusals; `{owner}` or `{user}` is replaced | `https://3speak.tv/wallet/{owner}#pro` |
| `UPLOAD_PUBLISH_CHECK_ENABLED` | `false` stops checking the publish limit for other apps | on |
| `UPLOAD_PUBLISH_CHECK_URL` | Checker that answers `GET /publish-quota/:owner?kind=` | `https://checker.3speak.tv` |
| `UPLOAD_PUBLISH_CHECK_SKIP_APPS` | Comma list of API key `app_name`s whose uploads skip the publish check (case-insensitive) | `3speak,3speak-editor` |

`.env.example` also lists `IPFS_API_ADDR` and `DEMO_API_KEY`; neither is read at the
moment (the IPFS API address is fixed at `http://127.0.0.1:5001`).

## Reference

Unless noted, request and response bodies are JSON, and errors are `{"error": "..."}`
with an HTTP status. Owner names are stored lowercased with any leading `@` removed, so
`Badadib`, `@badadib` and `badadib` are one owner.

### Authentication

| Method | Header | Use it for |
|---|---|---|
| API key | `X-API-Key: <your-api-key>` | Your backend; server-to-server and mobile uploads |
| Upload token | `Authorization: Bearer <token>` (or a `token` form field on the fallback endpoints) | Browser uploads |

Upload tokens are HMAC-SHA256 signed, time-limited and single-use. A token is used up
only when an upload is accepted: a refused upload (daily limit, size, ban) leaves it
valid for a retry until it expires. With a token, `owner`, `frontend_app`, `short` and the
permlink come from the token and any metadata values are ignored. Tokens with
`allowed_origins` are refused (403) from any other `Origin`.

### Uploads

#### `POST /uploads/token`

API key required. Returns 201.

| Field | Type | Description |
|---|---|---|
| `owner` | string | **Required.** Hive account the video belongs to |
| `frontend_app` | string | Your app id; defaults to the API key's app name |
| `short` | boolean | `true` for a Short (encoded at 480p). Default `false` |
| `allowed_origins` | string[] | Origins allowed to use the token (recommended for web) |
| `max_file_size` | number | Bytes, capped by `UPLOAD_TOKEN_MAX_FILE_SIZE` |
| `ttl` | number | Seconds, capped by `UPLOAD_TOKEN_MAX_TTL` |
| `replaces` | string | Permlink of the owner's existing video whose media this upload replaces (free under the daily limit) |
| `defer_encode` | boolean | Upload now, start the encode later with `POST /video/:permlink/encode` |
| `gated` | boolean | Paid video, encrypted at encode time. Requires 3Speak Pro and a configured gate |
| `allowlist` | string[] | Gated only: up to 500 Hive accounts that may watch without Pro |

```json
{
  "success": true,
  "token": "<upload-token>",
  "upload_url": "https://embed.3speak.tv/uploads",
  "permlink": "yn77aj9g",
  "embed_url": "https://play.3speak.tv/embed?v=badadib/yn77aj9g",
  "expires_at": "2026-11-25T12:10:00.000Z",
  "gated": false,
  "defer_encode": false,
  "replaces": null
}
```

`gated`, `defer_encode` and `replaces` are echoed so a client can confirm what was
honoured (`replaces` is `null` when the target did not check out). With
`defer_encode: true` the response also carries a `finalize_token` (valid 12 hours).
Errors: 422 (bad `owner`, `gated` or `allowlist`), 403 `pro_required`, 503 (tokens or gate
not configured), 429 [`daily_upload_limit`](#daily-upload-limits).

#### `POST /uploads` (tus)

The tus endpoint (tus 1.0 with the Creation and Concatenation extensions, served by tusd).
Send a Bearer token or `X-API-Key`.

| Metadata | Description |
|---|---|
| `filename` | Original file name (optional) |
| `owner` (or `username`) | Owner, API key uploads only |
| `frontend_app` | App id, API key uploads only |
| `short` | `"true"` or `"false"`, API key uploads only |
| `permlink` | Choose the permlink, API key uploads only; a taken one is refused with 409 |
| `duration` | Seconds (optional) |
| `replaces` | Permlink of the video being replaced, API key uploads only |

The creation response carries `X-Embed-URL` (also on the final 204 for mobile SDKs) and,
on a daily-limit refusal, `Retry-After`; both are exposed to browsers via CORS. Refusals
are JSON: 401 (bad key or token), 403 (token used, wrong origin, banned owner), 409
(permlink taken), 413 (over the token's size or `MAX_UPLOAD_SIZE`), 429
(`daily_upload_limit`).

#### Fallback uploads

For clients where tus is blocked (some mobile carriers and WebViews). All take
`multipart/form-data`, a `token` form field or the `X-API-Key` header, and the same
optional fields as the tus metadata (`filename`, `owner`, `short`, `permlink`,
`frontend_app`, `duration`, `replaces`). Put text fields **before** the file part.

| Endpoint | Purpose |
|---|---|
| `POST /upload/simple` | Whole file in one request (`file` as the last part), no resume. 201 `{success, embed_url, permlink, owner}` |
| `POST /upload/probe` | Unauthenticated throughput probe (body up to 512 KiB), returns `{ok, bytes}`, to size chunks |
| `POST /upload/chunk/create` | Fields `size` (total bytes), `chunkSize` (256 KiB to 64 MiB) and `probed=1` if you measured; without `probed` the chunk size is clamped to 256 KiB. 201 `{success, sessionId, chunkSize, totalChunks, received, permlink, owner, embed_url}`: slice to the returned `chunkSize` |
| `POST /upload/chunk` | Fields `sessionId`, `index`, and the chunk as a file part. Chunks may arrive in any order and in parallel; a repeated index is a no-op |
| `POST /upload/chunk/status` | `sessionId` → `{chunkSize, totalChunks, receivedBytes, size, received, finished}`, to resume |
| `POST /upload/chunk/finish` | `sessionId` → 201 `{success, embed_url, permlink, owner}` once every chunk is in |

Chunk sessions live in the memory of the instance that created them and expire after 2
hours idle, so send every request of one session to the same server.

### Videos

| Endpoint | Auth | Description |
|---|---|---|
| `GET /video/:permlink` | public | The video row: `status`, `encodingProgress`, `manifest_cid`, `thumbnail_url`, `duration`, `short`, `hive_*`, timestamps. 404 if unknown |
| `POST /video/:permlink/hive` | API key | Link the Hive post: `{hive_author, hive_permlink, hive_title?, hive_body?, hive_tags?}`. First link wins (see [step 5](#5-link-the-hive-post-optional)) |
| `POST /video/:permlink/thumbnail` | API key | Set a custom thumbnail: `{thumbnail_url}` |
| `POST /video/:permlink/encode` | finalize token | Deferred uploads: `{gated, allowlist?}` writes the gating choice and queues the encode in one step. Idempotent (`already_queued: true`); 409 `not_awaiting_encode` / `not_pinned` |
| `GET /video/:permlink/replace-target` | API key | Can this video's media be replaced? `{found, kind: "embed" \| "legacy", owner, status}` |
| `POST /video/:permlink/replaces` | API key | Register `:permlink` (the new upload) as the replacement for `{replaces}` (the original, same owner). When the new upload finishes encoding, its media moves onto the original row, which keeps its permlink, views and Hive post |
| `GET /users/:username/premium` | API key | `{username, premium}`; premium (3Speak Pro) owners get multi-resolution encodes. 404 if the user has never uploaded |

Deferred uploads that never get their `POST /video/:permlink/encode` are unpinned and
marked `failed` after 12 hours (one whose Hive post was already linked is queued instead). A replacement upload must be registered with
`POST /video/:permlink/replaces` within 6 hours to stay free under the daily limit.

### Daily upload limits

Enforced by this service for every app and every upload path (`POST /uploads/token`, tus,
`/upload/simple`, `/upload/chunk/create`), per owner name, over a rolling 24 hours:

| Account | Videos | Shorts |
|---|---|---|
| Warm-up account (a 3Speak handle with no Hive account yet) | 3 | 3 |
| Free Hive account, through 3speak.tv | no upload cap (limited when publishing, by the 3Speak checker) | no upload cap |
| Free Hive account, through any other app | refused while the publish limit (1 video per 24 h by publish time) is used up | same (3 shorts) |
| Free Hive account, with `UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true` | 1 | 3 |
| 3Speak Pro, or listed in `UPLOAD_LIMIT_EXEMPT` | unlimited | unlimited |

- **Counts:** uploads whose bytes landed (`processing`, `awaiting_encode`, `published`).
  In-flight, failed and deleted uploads do not.
- **Never counts:** verified stream recordings from the 3Speak streaming server, media
  replacements (`replaces`), and uploads a warm-up account made before it got its Hive
  account.
- **Other apps:** an app that publishes to Hive straight after the upload cannot schedule,
  so for an upload through an API key whose `app_name` is not in
  `UPLOAD_PUBLISH_CHECK_SKIP_APPS` (default `3speak`, `3speak-editor`: 3speak.tv checks
  the publish limit itself and lets people schedule), this service asks the 3Speak checker
  (`GET /publish-quota/:owner?kind=video|short`) whether a free Hive account may publish
  one more of that kind now, and refuses the upload when it may not. The app is the API
  key's (for a token upload, the key that issued the token), never `frontend_app`. Answers
  are cached 30 seconds per owner and kind. Not checked while
  `UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true` (the upload cap applies then).
- **Fails open:** if MongoDB, the warm-up registry, Hive or the checker cannot answer
  (3 second timeout), the upload is allowed.

A refusal is HTTP 429 with a `Retry-After` header (seconds) and this body on every path.
tus-js-client does not retry a 429; read it with `error.originalResponse.getBody()`.

```json
{
  "error": "Daily video upload limit reached",
  "code": "daily_upload_limit",
  "kind": "video",
  "plan": "warmup",
  "limit": 3,
  "used": 3,
  "next_at": "2026-11-21T14:32:00Z",
  "retry_after_seconds": 68400,
  "message": "Warm-up accounts can upload 3 videos per 24 hours. Your next video upload is possible at 2026-11-21T14:32:00Z.",
  "upgrade_url": "https://3speak.tv/wallet/badadib#pro"
}
```

Branch on `code`, show `message` as is. `kind` is `video` or `short`; `plan` is `warmup`
or `free`; `next_at` and `retry_after_seconds` are `null` only when an allowance is set to
0 (or the checker gave no time). `upgrade_url` only matters for `plan: "free"`.

The publish limit (other apps) answers the same way, with `"plan": "free"`, `limit` and
`next_at` (when the next one can be published) from the checker, `used` = the publishes
holding the window:

```json
{
  "error": "Daily video publish limit reached",
  "code": "daily_upload_limit",
  "kind": "video",
  "plan": "free",
  "limit": 1,
  "used": 1,
  "next_at": "2026-11-26T09:15:00Z",
  "retry_after_seconds": 41400,
  "message": "The free plan publishes 1 video per 24 hours. Your next video can be published at 2026-11-26T09:15:00Z. 3Speak Pro removes this limit.",
  "upgrade_url": "https://3speak.tv/wallet/badadib#pro"
}
```

**Check the allowance first** with `GET /uploads/quota?owner=<name>` (API key):

```json
{
  "enabled": true,
  "exempt": false,
  "reason": null,
  "plan": "warmup",
  "video": { "limit": 3, "used": 3, "remaining": 0, "next_at": "2026-11-21T14:32:00Z" },
  "short": { "limit": 3, "used": 1, "remaining": 2, "next_at": null }
}
```

For an exempt owner, `exempt` is `true`, `reason` is `pro`, `listed` or `publish_limit`
(a free Hive account through 3speak.tv while uploads are not capped), `plan` is `null`,
and `limit`, `remaining` and `next_at` are `null`. Through any other app's key a free Hive
account gets `exempt: false`, `plan: "free"` and, per kind, the checker's publish limit
(`used` = publishes in the window, `next_at` = when the next one can be published while
`remaining` is 0); if the checker cannot answer, the `publish_limit` answer above. With limits switched off, `enabled` is `false`. 503
when the count cannot be read (uploads are not blocked then).

### Service and encoders

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | public | `{status, service, activeUploads, freeDiskPct}`, also a load signal for picking the least busy server |
| `GET /api/v0/encoders/status` | public | Every encoder: `name`, `access` (`managed` or `community`), `operator`, `lastSeenAt` |
| `GET /api/v0/encoders/community` | public | Community encoders with `enabled`, `banned`, `lastSeenAt`, `commit`, `behindBy` and `alive` (polled in the last 5 minutes) |
| `POST /webhook` | `WEBHOOK_API_KEY` or per-job token | Encoder result: `{owner, permlink, status: "complete" \| "failed", manifest_cid, ...}` |
| `POST /webhook/progress` | `WEBHOOK_API_KEY` or per-job token | `{owner, permlink, progress, stage?}` |
| `POST /api/v0/gateway/updateNode`, `/myJob`, `/heartbeat` | JWS signed by the encoder's DID | Community encoder registration, job pull and heartbeat |
| `POST /tusd-hooks` | loopback only | tusd hook receiver, not for clients |

Managed encoders receive jobs at `POST {encoder.url}/encode`. Encoder setup lives in
[3speakencoder](https://github.com/Mantequilla-Soft/3speakencoder).

### Admin

`/admin.html` is the admin panel. The `/admin/*` API behind it (API keys, users with ban
and premium flags, encoders with tier, access and trust, jobs and redispatch, encoder
stats, temp file cleanup) requires `ADMIN_PASSWORD` in the `X-Admin-Password` header and
is meant for the instance operator only.

## Development and tests

```bash
npm run dev            # run src/index.ts with ts-node
npm run build          # compile to dist/
npm start              # run dist/index.js
npm run watch          # tsc --watch
npm test               # Vitest suite (test/**/*.test.ts)
npm run test:coverage  # same with coverage; fails below 75% lines
```

Tests run against a real MongoDB from `mongodb-memory-server`, with IPFS, tusd, encoders,
the gate and webhooks stubbed per test. `src/index.ts` only connects and listens when run
directly, so tests import the app and drive it with supertest. CI
([tests.yml](.github/workflows/tests.yml)) runs `tsc --noEmit` and the coverage suite on
Node 22 for every pull request and every push to `master`.

The `scripts/test-*.ts` files are older standalone checks that need no MongoDB; run one
with `npx ts-node --transpile-only scripts/test-upload-limits.ts`.

## Repository layout

```
.
├── src/
│   ├── index.ts              # Express app: every route, tusd proxy and hooks, webhooks, startup
│   ├── config/config.ts      # env loading, encoder seed parsing, upload limit config
│   ├── database/mongodb.ts   # MongoDB access: videos, users, API keys, jobs, encoders, tokens
│   ├── dispatcher/
│   │   └── jobDispatcher.ts  # 30 s job loop: tier and trust rules, retries, stall detection
│   ├── middleware/
│   │   ├── auth.ts           # API key check
│   │   └── adminAuth.ts      # admin password check
│   └── utils/
│       ├── tusd.ts           # spawns tusd on 127.0.0.1
│       ├── uploadAuth.ts     # one auth path for tus, simple and chunked uploads
│       ├── uploadToken.ts    # HMAC upload and finalize tokens
│       ├── uploadLimits.ts   # daily upload limits and quota
│       ├── ipfs.ts           # pin, unpin and DHT announce on the local daemon
│       ├── gate.ts           # 3speak-gate registration for gated videos
│       ├── jws.ts            # DID-signed requests from community encoders
│       ├── encoderVersion.ts # encoder commit reporting
│       ├── cleanup.ts        # stale temp file cleanup
│       ├── ipHash.ts         # keyed uploader address hashes
│       ├── keyGenerator.ts   # API key generation
│       └── videoId.ts        # permlink generation
├── public/
│   ├── index.html            # landing page with integration docs
│   ├── demo.html             # upload demo
│   └── admin.html            # admin panel
├── scripts/                  # install-tusd.sh, maintenance and standalone checks
├── test/                     # Vitest suites (admin, db, dispatcher, hooks, unit, uploads)
├── ENCODERS.md               # ENCODERS seed format
├── CLAUDE.md                 # architecture and design notes
└── .env.example              # configuration template
```

## Security notes

- **Keep the API key on a server.** For browsers, mint upload tokens on your backend and
  set `allowed_origins`. Treat the key as something that can leak: gated uploads and
  deferred encodes are only possible through signed token claims, never through API key
  metadata, and the daily limits apply to API key uploads too.
- **`owner` is a claim.** The service records whatever owner your backend names; verifying
  that the user really is that Hive account is your job.
- **Gated videos only reach trusted encoders.** An encoder holds the plaintext source of
  everything it encodes, so gated jobs go only to managed encoders marked `trusted`, with
  no fallback, and community encoders can never claim them.
- **Set the secrets.** `ADMIN_PASSWORD` has a placeholder default, and `WEBHOOK_API_KEY`
  and `UPLOAD_TOKEN_SECRET` are empty by default. Set all three to long random values on
  any instance reachable from the internet.
- **tusd and its hooks stay on loopback.** tusd binds to `127.0.0.1`, and `/tusd-hooks`
  refuses any caller that is not local.
- **No raw addresses are stored.** With `IP_HASH_SECRET` set, uploads record only keyed
  hashes of the client address and its network; rotating the key makes old hashes
  unlinkable.

## Contributing

Issues and pull requests are welcome. Questions and ideas: [3Speak Discord](https://discord.gg/NSFS2VGj83).

## License

[MIT](LICENSE) © Mantequilla Soft.
