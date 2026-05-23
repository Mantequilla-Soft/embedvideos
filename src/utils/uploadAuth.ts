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
  const permlink = metadata?.permlink || generateVideoId();
  const frontend_app = tokenClaims?.app || metadata?.frontend_app || 'unknown';
  const short = tokenClaims ? tokenClaims.short : metadata?.short === 'true';
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

  return { ok: true, owner, permlink, frontend_app, short, originalFilename, duration, size };
}
