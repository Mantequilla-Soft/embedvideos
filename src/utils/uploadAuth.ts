import { Database } from '../database/mongodb';
import { Config } from '../config/config';
import { verifyUploadToken, UploadTokenClaims } from './uploadToken';
import { generateVideoId } from './videoId';
import { getUploadLimiter, STREAM_VOD_APP, UploadLimiter, verifyReplacementTarget } from './uploadLimits';

export interface AuthSuccess {
  ok: true;
  owner: string;
  permlink: string;
  frontend_app: string;
  short: boolean;
  /** 🔐 Gated (paid) content. Only ever true via a signed upload token claim. */
  gated: boolean;
  /** 🔐 Named accounts that may watch without Pro. Signed-claim only, like `gated`. */
  allowlist: string[];
  /** Hold the encode until publish commissions it. Signed-claim only. */
  deferEncode: boolean;
  originalFilename: string | null;
  duration: number | null;
  size: number | null;
  /**
   * Verified stream recording from the hangouts server (true), a claim to be
   * one that did not verify (false), or not claimed at all (undefined).
   * Written onto the row as `stream_vod`; true rows never count toward the
   * daily upload limit.
   */
  streamVod: boolean | undefined;
  /**
   * Permlink of the owner's existing video this upload replaces the media of,
   * verified against the database; null when not a (verified) replacement.
   * Written onto the row as `replaces_existing` / `replaces_target`.
   */
  replacesExisting: string | null;
}

export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
  /** Full JSON body to send instead of `{ error }` (the daily-limit 429). */
  body?: Record<string, unknown>;
  /** Extra response headers (e.g. Retry-After). */
  headers?: Record<string, string>;
}

export type AuthResult = AuthSuccess | AuthFailure;

/**
 * Validate auth headers and extract upload metadata from a tusd pre-create hook payload.
 *
 * isPartial=true: validate credentials only, skip token consumption, skip user DB operations.
 * Used for individual parallel-upload chunk pieces which share the same token as the final CONCAT.
 */
export async function validateUploadAuth(
  headers: Record<string, string[]>,
  metadata: Record<string, string>,
  uploadSize: number | null,
  database: Database,
  config: Config,
  isPartial: boolean = false,
  limiter?: UploadLimiter
): Promise<AuthResult> {
  const h: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    h[k.toLowerCase()] = v;
  }

  const xApiKey = h['x-api-key']?.[0];
  const authHeader = h['authorization']?.[0];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  let tokenClaims: UploadTokenClaims | null = null;

  if (xApiKey) {
    const keyData = await database.getApiKey(xApiKey);
    if (!keyData || !keyData.active) {
      return { ok: false, status: 401, error: 'Invalid or inactive API key' };
    }
    database.updateApiKeyLastUsed(xApiKey).catch(console.error);
  } else if (bearerToken && config.uploadTokenSecret) {
    tokenClaims = verifyUploadToken(bearerToken, config.uploadTokenSecret);
    if (!tokenClaims) {
      return { ok: false, status: 401, error: 'Invalid or expired upload token' };
    }

    // A finalize token commissions an encode; it is not upload credentials.
    // Checked before the token is consumed so a misdirected one is rejected
    // outright rather than being burned.
    if (tokenClaims.scope === 'finalize') {
      return { ok: false, status: 403, error: 'This token cannot be used to upload' };
    }

    if (tokenClaims.allowedOrigins && tokenClaims.allowedOrigins.length > 0) {
      const origin = h['origin']?.[0];
      if (!origin || !tokenClaims.allowedOrigins.includes(origin)) {
        return { ok: false, status: 403, error: 'Origin not allowed for this upload token' };
      }
    }

    if (!isPartial && tokenClaims.maxFileSize && uploadSize && uploadSize > tokenClaims.maxFileSize) {
      return { ok: false, status: 413, error: 'File size exceeds token limit' };
    }

    // The token is consumed further down, once every refusal (size, ban,
    // daily limit) has had its say, so a refused upload leaves it usable.
  } else {
    return { ok: false, status: 401, error: 'API key or upload token required' };
  }

  const owner = tokenClaims?.owner || metadata?.owner || metadata?.username || 'unknown';
  // Prefer the permlink bound to the upload token so the video row matches the
  // embed URL the client was handed at token issuance. Falls back to a
  // client-supplied metadata permlink, then a freshly generated id (API-key /
  // legacy-token callers that predate token-bound permlinks).
  const permlink = tokenClaims?.permlink || metadata?.permlink || generateVideoId();
  const frontend_app = tokenClaims?.app || metadata?.frontend_app || 'unknown';
  const short = tokenClaims ? tokenClaims.short : metadata?.short === 'true';
  // 🔐 Read from the signed claim ONLY. Unlike `short`, there is no metadata
  // fallback: the embed API key ships inside browser bundles, so an API-key
  // caller is not a trusted party and must not be able to declare its own
  // upload paid. Gated uploads therefore require a token minted by
  // POST /uploads/token, which checks 3Speak Pro status first.
  const gated = tokenClaims?.gated === true;
  const allowlist = gated && Array.isArray(tokenClaims?.allowlist) ? tokenClaims.allowlist : [];
  // Signed claim only, for the same reason as `gated`: deferring decides when
  // the job is created, and an API-key caller must not be able to leave uploads
  // parked with no encode.
  const deferEncode = tokenClaims?.deferEncode === true;
  const originalFilename = metadata?.filename || null;
  const duration = metadata?.duration ? parseFloat(metadata.duration) : null;
  const size = uploadSize || null;

  if (!isPartial) {
    let user = await database.getUser(owner);
    if (!user) {
      await database.createUser({
        username: owner,
        banned: false,
        banReason: null,
        bannedAt: null,
        bannedBy: null,
        uploadRestricted: false,
        maxDailyUploads: null,
        maxFileSize: null,
        stats: {
          totalUploads: 0,
          totalStorageUsed: 0,
          successfulUploads: 0,
          failedUploads: 0,
          lastUpload: null,
        },
        premium: false,
        trustLevel: 'new',
        adminNotes: '',
        firstSeen: new Date(),
        lastActivity: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`New user created: ${owner}`);
    } else if (user.banned) {
      return { ok: false, status: 403, error: 'User is banned from uploading' };
    }
  }

  // Stream recordings (VODs) are published by the hangouts server: X-API-Key,
  // no token, frontend_app '3speak-hangouts', permlink = the room name. That
  // metadata alone proves nothing, since the hangouts server uses the same
  // public embed API key as the browser frontend (app_name '3speak'). So the
  // claim is checked against the stream records the hangouts server writes
  // into this database: this owner must have streamed in a room of exactly
  // this name. A token upload is never a VOD.
  const vodClaim = !isPartial && !tokenClaims && frontend_app === STREAM_VOD_APP && !short;
  let streamVod: boolean | undefined;
  if (vodClaim) {
    try {
      streamVod = await database.streamRecordExists(owner, permlink);
    } catch (err) {
      // Fail open: no verdict recorded (the count re-checks rows without
      // one) and no limit applied to this upload.
      console.warn(`[uploadLimits] stream record lookup failed for ${owner}/${permlink}:`, (err as Error)?.message || err);
      streamVod = undefined;
    }
    if (streamVod === false) {
      console.warn(`[uploadLimits] ${owner}/${permlink} claims to be a stream VOD but has no stream record; counted as a video`);
    }
  }

  // Replacing the media of an existing video is free (owner, 2026-11-20). The
  // claim comes from the signed token (`replaces`, verified at issuance) or,
  // for X-API-Key uploads, from the `replaces` metadata field; either way it
  // is checked against the database HERE: the target must exist and belong to
  // this owner. A claim that does not verify is an ordinary upload.
  let replacesExisting: string | null = null;
  // The target lookup failed: let the upload through without the limit (fail
  // open) but do not record it as a verified replacement.
  let replacesUnknown = false;
  const replacesClaim = tokenClaims ? tokenClaims.replaces : metadata?.replaces;
  if (!isPartial && replacesClaim) {
    const verdict = await verifyReplacementTarget(database, owner, replacesClaim, permlink);
    if (verdict === true) {
      replacesExisting = String(replacesClaim).trim();
    } else if (verdict === null) {
      replacesUnknown = true;
    } else {
      console.warn(`[uploadLimits] ${owner}/${permlink} claims to replace ${replacesClaim}, which is not theirs or does not exist; treated as an ordinary upload`);
    }
  }

  // Daily upload limit, for every auth method. The token route checks too
  // (better UX: refused before any bytes move), but an X-API-Key upload never
  // goes through it, and the key is public.
  // A VOD claim whose lookup failed (streamVod still undefined) is let through.
  if (!isPartial && !replacesExisting && !replacesUnknown && !(vodClaim && streamVod !== false)) {
    const refusal = await (limiter ?? getUploadLimiter(database, config)).check(owner, short ? 'short' : 'video');
    if (refusal) {
      return { ok: false, status: refusal.status, error: refusal.body.error, body: { ...refusal.body }, headers: refusal.headers };
    }
  }

  // Single use. Partial uploads are chunk pieces: the token is consumed only
  // on the final/regular upload. Consumed last so that a refusal above leaves
  // it usable for a retry after Retry-After; consumption is atomic, so two
  // uploads racing with one token still get exactly one through.
  if (tokenClaims && !isPartial) {
    const consumed = await database.consumeUploadToken(
      tokenClaims.jti,
      new Date(tokenClaims.exp * 1000)
    );
    if (!consumed) {
      return { ok: false, status: 403, error: 'Upload token has already been used' };
    }
  }

  return { ok: true, owner, permlink, frontend_app, short, gated, allowlist, deferEncode, originalFilename, duration, size, streamVod, replacesExisting };
}
