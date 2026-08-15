import { Database } from '../database/mongodb';
import { Config } from '../config/config';
import { verifyUploadToken, UploadTokenClaims } from './uploadToken';
import { generateVideoId } from './videoId';

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
  originalFilename: string | null;
  duration: number | null;
  size: number | null;
}

export interface AuthFailure {
  ok: false;
  status: number;
  error: string;
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
  isPartial: boolean = false
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

    if (tokenClaims.allowedOrigins && tokenClaims.allowedOrigins.length > 0) {
      const origin = h['origin']?.[0];
      if (!origin || !tokenClaims.allowedOrigins.includes(origin)) {
        return { ok: false, status: 403, error: 'Origin not allowed for this upload token' };
      }
    }

    // Partial uploads are chunk pieces — the token is consumed only on the final/regular upload.
    if (!isPartial) {
      const consumed = await database.consumeUploadToken(
        tokenClaims.jti,
        new Date(tokenClaims.exp * 1000)
      );
      if (!consumed) {
        return { ok: false, status: 403, error: 'Upload token has already been used' };
      }

      if (tokenClaims.maxFileSize && uploadSize && uploadSize > tokenClaims.maxFileSize) {
        return { ok: false, status: 413, error: 'File size exceeds token limit' };
      }
    }
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

  return { ok: true, owner, permlink, frontend_app, short, gated, allowlist, originalFilename, duration, size };
}
