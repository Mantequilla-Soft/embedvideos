import type { Database } from '../../src/database/mongodb';

/** Minimal embed-video row; tests override what they care about. */
export async function makeVideo(database: Database, fields: Record<string, unknown> = {}) {
  const now = new Date();
  const row = {
    owner: 'alice',
    permlink: `v${Math.random().toString(36).slice(2, 10)}`,
    frontend_app: 'test-app',
    status: 'processing',
    input_cid: 'QmInputCid',
    manifest_cid: null,
    thumbnail_url: null,
    short: false,
    duration: null,
    size: 1000,
    encodingProgress: 0,
    originalFilename: 'clip.mp4',
    hive_author: null,
    hive_permlink: null,
    hive_title: null,
    hive_body: null,
    hive_tags: null,
    embed_url: null,
    embed_title: null,
    listed_on_3speak: false,
    processed: false,
    processedAt: null,
    views: 0,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  await database.createVideoEntry(row as any);
  return row as any;
}

export async function makeJob(database: Database, fields: Record<string, unknown> = {}) {
  const now = new Date();
  const job = {
    owner: 'alice',
    permlink: `j${Math.random().toString(36).slice(2, 10)}`,
    status: 'pending',
    assignedWorker: null,
    encoderJobId: null,
    assignedAt: null,
    attemptCount: 0,
    lastError: null,
    encodingProgress: null,
    encodingStage: null,
    webhookReceivedAt: null,
    premium: false,
    short: false,
    fileSize: 1000,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  await database.createJob(job as any);
  return job as any;
}

export async function makeUser(database: Database, username: string, fields: Record<string, unknown> = {}) {
  const now = new Date();
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
    trustLevel: 'new',
    adminNotes: '',
    firstSeen: now,
    lastActivity: now,
    createdAt: now,
    updatedAt: now,
    ...fields,
  } as any);
}
