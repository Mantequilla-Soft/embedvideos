import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Db } from 'mongodb';
import { Database } from '../../src/database/mongodb';
import { connectDb, clearAll, user, minutesAgo, VIDEOS } from './helpers';

let database: Database;
let raw: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ database, raw, close } = await connectDb());
});
afterAll(async () => close());
beforeEach(async () => clearAll(raw));

describe('API keys', () => {
  const key = (k: string, createdAt: Date) => ({ key: k, app_name: 'app', owner: 'o', active: true, createdAt, lastUsed: null });

  it('create, get, list newest first, toggle active, record last use', async () => {
    await database.createApiKey(key('k-old', minutesAgo(10)));
    await database.createApiKey(key('k-new', minutesAgo(1)));
    expect((await database.getApiKey('k-old'))?.app_name).toBe('app');
    expect(await database.getApiKey('nope')).toBeNull();
    expect((await database.getAllApiKeys()).map((k) => k.key)).toEqual(['k-new', 'k-old']);

    await database.updateApiKeyStatus('k-old', false);
    expect((await database.getApiKey('k-old'))?.active).toBe(false);
    await database.updateApiKeyStatus('k-old', true);
    expect((await database.getApiKey('k-old'))?.active).toBe(true);

    await database.updateApiKeyLastUsed('k-new');
    const used = await database.getApiKey('k-new');
    expect(used?.lastUsed).toBeInstanceOf(Date);
    expect(used!.lastUsed!.getTime()).toBeGreaterThan(minutesAgo(1).getTime());
    expect((await database.getApiKey('k-old'))?.lastUsed).toBeNull();
  });
});

describe('users', () => {
  it('createUser / getUser', async () => {
    await database.createUser(user({ username: 'ann', trustLevel: 'trusted' }));
    expect((await database.getUser('ann'))?.trustLevel).toBe('trusted');
    expect(await database.getUser('nobody')).toBeNull();
  });

  it('getAllUsers sorts by lastActivity desc, paginates and searches case-insensitively', async () => {
    await database.createUser(user({ username: 'Alpha', lastActivity: minutesAgo(30) }));
    await database.createUser(user({ username: 'beta', lastActivity: minutesAgo(1) }));
    await database.createUser(user({ username: 'alphabet', lastActivity: minutesAgo(10) }));
    expect((await database.getAllUsers()).map((u) => u.username)).toEqual(['beta', 'alphabet', 'Alpha']);
    expect((await database.getAllUsers(1, 1)).map((u) => u.username)).toEqual(['alphabet']);
    expect((await database.getAllUsers(50, 0, 'ALPHA')).map((u) => u.username)).toEqual(['alphabet', 'Alpha']);
    expect(await database.getAllUsers(50, 0, 'zzz')).toEqual([]);
  });

  it('upload stats counters', async () => {
    await database.createUser(user({ username: 'up', lastActivity: minutesAgo(60) }));
    await database.incrementUserUpload('up', 1000);
    await database.incrementUserUpload('up', 500);
    await database.incrementUserSuccess('up');
    await database.incrementUserFailure('up');
    await database.incrementUserFailure('up');
    const u = await database.getUser('up');
    expect(u?.stats).toMatchObject({ totalUploads: 2, totalStorageUsed: 1500, successfulUploads: 1, failedUploads: 2 });
    expect(u?.stats.lastUpload).toBeInstanceOf(Date);
    expect(u!.lastActivity.getTime()).toBeGreaterThan(minutesAgo(1).getTime());
    // Counters on an unknown user do not create one.
    await database.incrementUserUpload('ghost', 1);
    await database.incrementUserSuccess('ghost');
    await database.incrementUserFailure('ghost');
    expect(await database.getUser('ghost')).toBeNull();
  });

  it('banUser sets and clears the flag', async () => {
    await database.createUser(user({ username: 'bad' }));
    await database.banUser('bad', true);
    expect((await database.getUser('bad'))?.banned).toBe(true);
    await database.banUser('bad', false);
    expect((await database.getUser('bad'))?.banned).toBe(false);
  });

  it('isUserPremium: false for unknown users and users without the field', async () => {
    await database.createUser(user({ username: 'plain' }));
    expect(await database.isUserPremium('plain')).toBe(false);
    expect(await database.isUserPremium('unknown')).toBe(false);
  });

  it('setUserPremium toggles premium and throws for unknown users', async () => {
    await database.createUser(user({ username: 'pro' }));
    await database.setUserPremium('pro', true);
    expect(await database.isUserPremium('pro')).toBe(true);
    await database.setUserPremium('pro', false);
    expect(await database.isUserPremium('pro')).toBe(false);
    await expect(database.setUserPremium('ghost', true)).rejects.toThrow('User not found: ghost');
  });
});

describe('upload tokens', () => {
  it('initUploadTokenCollection creates the TTL and unique indexes (idempotently)', async () => {
    await database.initUploadTokenCollection();
    await database.initUploadTokenCollection();
    const idx = await raw.collection('embed-upload-tokens').indexes();
    const byKey = (k: string) => idx.find((i) => JSON.stringify(i.key) === k);
    expect(byKey('{"consumedAt":1}')?.expireAfterSeconds).toBe(86400);
    expect(byKey('{"expiresAt":1}')?.expireAfterSeconds).toBe(0);
    expect(byKey('{"jti":1}')?.unique).toBe(true);
  });

  it('consumeUploadToken: first use wins, reuse is refused', async () => {
    await database.initUploadTokenCollection();
    const exp = new Date(Date.now() + 3600_000);
    expect(await database.consumeUploadToken('jti-1', exp)).toBe(true);
    expect(await database.consumeUploadToken('jti-1', exp)).toBe(false);
    expect(await database.consumeUploadToken('jti-2', exp)).toBe(true);
    const row: any = await raw.collection('embed-upload-tokens').findOne({ jti: 'jti-1' });
    expect(row.expiresAt.getTime()).toBe(exp.getTime());
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  it('concurrent consumption of the same token succeeds exactly once', async () => {
    await database.initUploadTokenCollection();
    const exp = new Date(Date.now() + 3600_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => database.consumeUploadToken('race', exp)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rethrows errors that are not duplicate keys', async () => {
    await database.initUploadTokenCollection();
    // A validator that rejects every insert makes insertOne fail with a non-11000 code.
    await raw.command({ collMod: 'embed-upload-tokens', validator: { jti: { $type: 'int' } }, validationLevel: 'strict', validationAction: 'error' });
    try {
      await expect(database.consumeUploadToken('str-jti', new Date())).rejects.toMatchObject({ code: 121 });
    } finally {
      await raw.command({ collMod: 'embed-upload-tokens', validator: {}, validationLevel: 'off' });
    }
  });
});

describe('before connect', () => {
  it('every data method refuses with "Database not connected"', async () => {
    const db = new Database(process.env.MONGODB_URI!, 'unused', VIDEOS);
    const d = new Date();
    const calls: Array<() => Promise<unknown>> = [
      () => db.createVideoEntry({} as any),
      () => db.updateVideoStatus('p', 'failed'),
      () => db.getPendingReplacements(),
      () => db.getVideo('p'),
      () => db.getLegacyVideo('p'),
      () => db.updateLegacyVideoMedia('p', {}),
      () => db.getStaleUploads(1),
      () => db.getStaleProcessing(1),
      () => db.getAbandonedDeferred(1),
      () => db.getHealableDeferred(1),
      () => db.createApiKey({} as any),
      () => db.getApiKey('k'),
      () => db.getAllApiKeys(),
      () => db.updateApiKeyStatus('k', true),
      () => db.updateApiKeyLastUsed('k'),
      () => db.incrementUserUpload('u', 1),
      () => db.incrementUserSuccess('u'),
      () => db.incrementUserFailure('u'),
      () => db.createJob({} as any),
      () => db.getJob('o', 'p'),
      () => db.getPendingJobs(),
      () => db.claimNextManagedJob({}),
      () => db.updateJobStatus('o', 'p', 'pending'),
      () => db.incrementJobAttempt('o', 'p'),
      () => db.resetJob('o', 'p'),
      () => db.resetStalledJob('o', 'p', null),
      () => db.failStalledJob('o', 'p', 'e'),
      () => db.getStalledJobs(1),
      () => db.getCompletedJobStats(d),
      () => db.getJobsForVideofixer('failed'),
      () => db.getUser('u'),
      () => db.createUser({} as any),
      () => db.getAllUsers(),
      () => db.banUser('u', true),
      () => db.getRecentCountedUploads('u', d),
      () => db.streamRecordExists('h', 'r'),
      () => db.isUserPremium('u'),
      () => db.setUserPremium('u', true),
      () => db.getAllEncoders(),
      () => db.getEncoder('e'),
      () => db.createEncoder({} as any),
      () => db.updateEncoder('e', {}),
      () => db.deleteEncoder('e'),
      () => db.getEncoderByDid('d'),
      () => db.upsertCommunityEncoder('d', {}, { $set: {}, $unset: {} }),
      () => db.updateEncoderLastSeen('d'),
      () => db.claimNextCommunityJob('e', null),
      () => db.initUploadTokenCollection(),
      () => db.consumeUploadToken('j', d),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow('Database not connected');
    }
    await db.close();
  });
});
