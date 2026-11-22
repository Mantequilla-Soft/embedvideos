import { randomBytes } from 'crypto';
import { signUploadToken, UploadTokenClaims } from '../../src/utils/uploadToken';
import type { Database } from '../../src/database/mongodb';

/** A signed upload (or finalize) token with sensible defaults. */
export function makeToken(overrides: Partial<UploadTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: UploadTokenClaims = {
    jti: randomBytes(8).toString('hex'),
    owner: 'alice',
    app: '3speak-tv',
    issuedByKey: 'sk_test_issuer',
    short: false,
    maxFileSize: 0,
    allowedOrigins: [],
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  return signUploadToken(claims, process.env.UPLOAD_TOKEN_SECRET!);
}

let seq = 0;
/** A unique permlink per call, so tests sharing one database never collide. */
export function uid(prefix = 'p'): string {
  seq += 1;
  return `${prefix}${seq}${randomBytes(3).toString('hex')}`;
}

/** Inserts a video row with defaults, returning the stored fields. */
export async function insertVideo(database: Database, overrides: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = {
    owner: 'alice',
    permlink: uid('v'),
    frontend_app: '3speak-tv',
    status: 'uploading',
    input_cid: null,
    ipfs_pin_endpoint: null,
    manifest_cid: null,
    thumbnail_url: null,
    short: false,
    gated: false,
    gate_video_id: null,
    allowlist: [],
    defer_encode: false,
    duration: null,
    size: null,
    encodingProgress: 0,
    originalFilename: null,
    hive_author: null,
    hive_permlink: null,
    hive_title: null,
    hive_body: null,
    hive_tags: null,
    embed_url: null,
    embed_title: null,
    listed_on_3speak: true,
    processed: false,
    processedAt: null,
    views: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await database.createVideoEntry(doc as any);
  return doc as any;
}

/** Inserts a user row (premium / banned flags as needed). */
export async function insertUser(database: Database, username: string, overrides: Record<string, unknown> = {}) {
  await database.createUser({
    username,
    banned: false,
    banReason: null,
    bannedAt: null,
    bannedBy: null,
    uploadRestricted: false,
    maxDailyUploads: null,
    maxFileSize: null,
    stats: { totalUploads: 0, totalStorageUsed: 0, successfulUploads: 0, failedUploads: 0, lastUpload: null },
    premium: false,
    trustLevel: 'new',
    adminNotes: '',
    firstSeen: new Date(),
    lastActivity: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any);
}

/** Inserts a pending encode job. */
export async function insertJob(database: Database, owner: string, permlink: string, overrides: Record<string, unknown> = {}) {
  await database.createJob({
    owner,
    permlink,
    status: 'encoding',
    assignedWorker: 'enc-a',
    encoderJobId: 'job-1',
    assignedAt: new Date(),
    attemptCount: 0,
    lastError: null,
    encodingProgress: null,
    encodingStage: null,
    webhookReceivedAt: null,
    premium: false,
    short: false,
    fileSize: null,
    gated: false,
    gateVideoId: permlink,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any);
}

/** Polls `fn` until it returns a truthy value (post-finish work runs in setImmediate). */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}
