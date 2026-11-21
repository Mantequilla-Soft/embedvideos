import { MongoClient, Db } from 'mongodb';
import { Database, VideoMetadata, EncodingJob, Encoder, User } from '../../src/database/mongodb';

export const VIDEOS = 'embed-video';

/**
 * A Database connected to this file's own test database, plus a raw driver
 * handle on the same database for seeding fields the class never writes
 * (back-dated timestamps, legacy rows, stream records) and for reading back
 * exactly what landed.
 */
export async function connectDb(): Promise<{ database: Database; raw: Db; client: MongoClient; close: () => Promise<void> }> {
  const uri = process.env.MONGODB_URI!;
  const dbName = process.env.MONGODB_DATABASE!;
  const database = new Database(uri, dbName, VIDEOS);
  await database.connect(dbName, VIDEOS);
  const client = new MongoClient(uri);
  await client.connect();
  const raw = client.db(dbName);
  return {
    database,
    raw,
    client,
    close: async () => {
      await database.close();
      await client.close();
    },
  };
}

/** Empties every collection in the database (indexes stay). */
export async function clearAll(raw: Db): Promise<void> {
  const cols = await raw.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(cols.map((c) => raw.collection(c.name).deleteMany({})));
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
export const hoursAgo = (h: number) => minutesAgo(h * 60);

export function video(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  const now = new Date();
  return {
    owner: 'alice',
    permlink: `v-${Math.random().toString(36).slice(2, 10)}`,
    frontend_app: 'test-app',
    status: 'uploading',
    input_cid: null,
    ipfs_pin_endpoint: null,
    manifest_cid: null,
    thumbnail_url: null,
    short: false,
    duration: null,
    size: null,
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
    ...overrides,
  };
}

export function job(overrides: Partial<EncodingJob> = {}): EncodingJob {
  const now = new Date();
  return {
    owner: 'alice',
    permlink: `j-${Math.random().toString(36).slice(2, 10)}`,
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
    fileSize: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function encoder(overrides: Partial<Encoder> = {}): Encoder {
  const now = new Date();
  return {
    name: `enc-${Math.random().toString(36).slice(2, 8)}`,
    url: 'http://encoder.test',
    apiKey: 'enc-key',
    enabled: true,
    access: 'managed',
    tier: 'standard',
    maxFileSize: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function user(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    username: 'alice',
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
    ...overrides,
  };
}
