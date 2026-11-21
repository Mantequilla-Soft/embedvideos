import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { Database } from '../../src/database/mongodb';
import { buildRegistrationVersionUpdate } from '../../src/utils/encoderVersion';
import { connectDb, clearAll, encoder, minutesAgo, VIDEOS } from './helpers';

let database: Database;
let raw: Db;
let client: MongoClient;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ database, raw, client, close } = await connectDb());
});
afterAll(async () => close());
beforeEach(async () => clearAll(raw));

const noVersion = { $set: {}, $unset: {} } as const;
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

describe('managed encoders CRUD', () => {
  it('create, get, list (oldest first), update, delete', async () => {
    await database.createEncoder(encoder({ name: 'b', createdAt: minutesAgo(1) }));
    await database.createEncoder(encoder({ name: 'a', createdAt: minutesAgo(5), tier: 'performance' }));
    expect((await database.getAllEncoders()).map((e) => e.name)).toEqual(['a', 'b']);
    expect((await database.getEncoder('a'))?.tier).toBe('performance');
    expect(await database.getEncoder('zzz')).toBeNull();

    const before = (await database.getEncoder('b'))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await database.updateEncoder('b', { enabled: false, trusted: true, maxFileSize: 5000 });
    const b = await database.getEncoder('b');
    expect(b).toMatchObject({ enabled: false, trusted: true, maxFileSize: 5000, url: 'http://encoder.test' });
    expect(b!.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    await database.deleteEncoder('a');
    expect(await database.getEncoder('a')).toBeNull();
    expect(await database.getAllEncoders()).toHaveLength(1);
    await database.deleteEncoder('not-there'); // no-op, no throw
  });

  it('names are unique', async () => {
    await database.createEncoder(encoder({ name: 'same' }));
    await expect(database.createEncoder(encoder({ name: 'same' }))).rejects.toMatchObject({ code: 11000 });
  });

  it('managed encoders without a did do not collide on the sparse did index', async () => {
    await database.createEncoder(encoder({ name: 'm1' }));
    await database.createEncoder(encoder({ name: 'm2' }));
    expect(await database.getAllEncoders()).toHaveLength(2);
  });
});

describe('community encoders', () => {
  it('upsertCommunityEncoder inserts with fixed defaults and a DID-derived name', async () => {
    const now = new Date();
    const enc = await database.upsertCommunityEncoder(DID, { name: 'My Node', hiveAccount: 'nodeop', peerId: 'peer1', commitHash: 'abc' }, {
      $set: { encoderCommit: 'a'.repeat(40), behindBy: 3, versionReportedAt: now },
      $unset: {},
    });
    expect(enc).toMatchObject({
      name: `community-${DID.slice(-12)}`, did: DID, url: '', apiKey: '', enabled: true,
      access: 'community', tier: 'lite', banned: false, maxFileSize: null,
      displayName: 'My Node', hiveAccount: 'nodeop', peerId: 'peer1', commitHash: 'abc',
      encoderCommit: 'a'.repeat(40), behindBy: 3,
    });
    expect(enc.trusted).toBeUndefined();
    expect(enc.lastSeenAt).toBeInstanceOf(Date);
    expect((await database.getEncoderByDid(DID))?.name).toBe(enc.name);
    expect(await database.getEncoderByDid('did:key:other')).toBeNull();
  });

  it('re-registration updates only supplied fields, keeps createdAt/name and never touches admin fields', async () => {
    const first = await database.upsertCommunityEncoder(DID, { name: 'Old', hiveAccount: 'op' }, buildRegistrationVersionUpdate({ encoderCommit: 'b'.repeat(40), behindBy: 1 }, new Date()));
    // Admin bans it and tweaks tier in between.
    await database.updateEncoder(first.name, { banned: true, tier: 'standard' });

    const again = await database.upsertCommunityEncoder(DID, { peerId: 'peer2' }, buildRegistrationVersionUpdate({}, new Date()));
    expect(again.name).toBe(first.name);
    expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(again).toMatchObject({ displayName: 'Old', hiveAccount: 'op', peerId: 'peer2', banned: true, tier: 'standard' });
    // A registration that reports no version clears what was stored.
    expect(again.encoderCommit).toBeUndefined();
    expect(again.behindBy).toBeUndefined();
    expect(again.versionReportedAt).toBeUndefined();
    expect(await raw.collection('embed-encoders').countDocuments({ did: DID })).toBe(1);
  });

  it('updateEncoderLastSeen bumps lastSeenAt and applies a version update', async () => {
    await database.upsertCommunityEncoder(DID, {}, { $set: { encoderCommit: 'c'.repeat(40), behindBy: 9 }, $unset: {} });
    await raw.collection('embed-encoders').updateOne({ did: DID }, { $set: { lastSeenAt: minutesAgo(60) } });

    await database.updateEncoderLastSeen(DID);
    let e = await database.getEncoderByDid(DID);
    expect(e!.lastSeenAt!.getTime()).toBeGreaterThan(minutesAgo(1).getTime());
    expect(e?.behindBy).toBe(9);

    await database.updateEncoderLastSeen(DID, { $set: { behindBy: 0 }, $unset: {} });
    expect((await database.getEncoderByDid(DID))?.behindBy).toBe(0);

    await database.updateEncoderLastSeen(DID, { $set: {}, $unset: { behindBy: '' } });
    e = await database.getEncoderByDid(DID);
    expect(e?.behindBy).toBeUndefined();
    expect(e?.encoderCommit).toBe('c'.repeat(40));

    await database.updateEncoderLastSeen(DID, noVersion as any);
  });

  it('two community encoders with distinct DIDs coexist', async () => {
    await database.upsertCommunityEncoder(DID, {}, noVersion as any);
    await database.upsertCommunityEncoder(`${DID}XYZ`, {}, noVersion as any);
    expect(await raw.collection('embed-encoders').countDocuments({ access: 'community' })).toBe(2);
  });
});

describe('index tolerance on a shared database', () => {
  it('accepts the shared case-insensitive name index as it is, and connects', async () => {
    const dbName = `${process.env.MONGODB_DATABASE}_collation`;
    const pre = client.db(dbName);
    await pre.collection('embed-encoders').createIndex(
      { name: 1 },
      { unique: true, name: 'name_1', collation: { locale: 'en', strength: 2 } },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db2 = new Database(process.env.MONGODB_URI!, dbName, VIDEOS);
    try {
      await db2.connect(dbName, VIDEOS);
      // Same definition as ours: no conflict to tolerate.
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('{"name":1}'));
      const idx = (await pre.collection('embed-encoders').indexes()).find((i) => i.name === 'name_1');
      expect(idx?.collation?.strength).toBe(2);
      await db2.createEncoder(encoder({ name: 'Encoder-One' }));
      await expect(db2.createEncoder(encoder({ name: 'encoder-one' }))).rejects.toMatchObject({ code: 11000 });
    } finally {
      warn.mockRestore();
      await db2.close();
      await pre.dropDatabase();
    }
  });

  it('makes encoder names case-insensitively unique on a fresh database too', async () => {
    const dbName = `${process.env.MONGODB_DATABASE}_fresh`;
    const db2 = new Database(process.env.MONGODB_URI!, dbName, VIDEOS);
    try {
      await db2.connect(dbName, VIDEOS);
      const idx = (await client.db(dbName).collection('embed-encoders').indexes()).find((i) => i.key?.name === 1);
      expect(idx).toMatchObject({ unique: true, collation: { locale: 'en', strength: 2 } });
      await db2.createEncoder(encoder({ name: 'Encoder-One' }));
      await expect(db2.createEncoder(encoder({ name: 'ENCODER-ONE' }))).rejects.toMatchObject({ code: 11000 });
    } finally {
      await db2.close();
      await client.db(dbName).dropDatabase();
    }
  });

  it('keeps an older name index without a collation (IndexOptionsConflict) and connects', async () => {
    const dbName = `${process.env.MONGODB_DATABASE}_plain`;
    const pre = client.db(dbName);
    await pre.collection('embed-encoders').createIndex({ name: 1 }, { unique: true, name: 'name_1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db2 = new Database(process.env.MONGODB_URI!, dbName, VIDEOS);
    try {
      await db2.connect(dbName, VIDEOS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('already exists with different options'));
      const idx = (await pre.collection('embed-encoders').indexes()).find((i) => i.name === 'name_1');
      expect(idx?.collation).toBeUndefined();
    } finally {
      warn.mockRestore();
      await db2.close();
      await pre.dropDatabase();
    }
  });

  it('rethrows other index errors (e.g. duplicate permlinks blocking the unique index)', async () => {
    const dbName = `${process.env.MONGODB_DATABASE}_dupes`;
    const pre = client.db(dbName);
    await pre.collection(VIDEOS).insertMany([{ permlink: 'x' }, { permlink: 'x' }]);
    const db2 = new Database(process.env.MONGODB_URI!, dbName, VIDEOS);
    try {
      await expect(db2.connect(dbName, VIDEOS)).rejects.toMatchObject({ code: 11000 });
    } finally {
      await db2.close();
      await pre.dropDatabase();
    }
  });
});
