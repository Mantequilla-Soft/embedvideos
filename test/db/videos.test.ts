import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Db } from 'mongodb';
import type { Database } from '../../src/database/mongodb';
import { COUNTED_UPLOAD_STATUSES } from '../../src/database/mongodb';
import { connectDb, clearAll, video, hoursAgo, minutesAgo, VIDEOS } from './helpers';

let database: Database;
let raw: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ database, raw, close } = await connectDb());
});
afterAll(async () => close());
beforeEach(async () => clearAll(raw));

describe('connect', () => {
  it('creates the video, encoder and job indexes', async () => {
    const videoIdx = await raw.collection(VIDEOS).indexes();
    const permlinkIdx = videoIdx.find((i) => JSON.stringify(i.key) === '{"permlink":1}');
    expect(permlinkIdx?.unique).toBe(true);
    expect(videoIdx.some((i) => JSON.stringify(i.key) === '{"owner":1,"createdAt":-1}')).toBe(true);

    const encIdx = await raw.collection('embed-encoders').indexes();
    expect(encIdx.find((i) => JSON.stringify(i.key) === '{"name":1}')?.unique).toBe(true);
    const didIdx = encIdx.find((i) => JSON.stringify(i.key) === '{"did":1}');
    expect(didIdx?.unique).toBe(true);
    expect(didIdx?.sparse).toBe(true);

    const jobIdx = await raw.collection('embed-jobs').indexes();
    expect(jobIdx.some((i) => JSON.stringify(i.key) === '{"status":1,"premium":1,"short":1,"createdAt":1}')).toBe(true);
  });

  it('is idempotent: connecting a second time over the same indexes works', async () => {
    const again = await connectDb();
    await again.close();
  });
});

describe('video rows', () => {
  it('createVideoEntry + getVideo round trip; unknown permlink is null', async () => {
    const v = video({ permlink: 'abc', owner: 'bob', size: 1234 });
    await database.createVideoEntry(v);
    const got = await database.getVideo('abc');
    expect(got?.owner).toBe('bob');
    expect(got?.size).toBe(1234);
    expect(await database.getVideo('nope')).toBeNull();
  });

  it('enforces unique permlinks', async () => {
    await database.createVideoEntry(video({ permlink: 'dup' }));
    await expect(database.createVideoEntry(video({ permlink: 'dup' }))).rejects.toMatchObject({ code: 11000 });
  });

  it('updateVideoStatus sets status, extra fields and bumps updatedAt', async () => {
    const old = hoursAgo(5);
    await database.createVideoEntry(video({ permlink: 'p1', updatedAt: old }));
    await database.updateVideoStatus('p1', 'processing', { input_cid: 'QmInput', encodingProgress: 42 });
    const got = await database.getVideo('p1');
    expect(got?.status).toBe('processing');
    expect(got?.input_cid).toBe('QmInput');
    expect(got?.encodingProgress).toBe(42);
    expect(got!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('updateVideoStatus without extra data only changes status', async () => {
    await database.createVideoEntry(video({ permlink: 'p2', input_cid: 'QmKeep' }));
    await database.updateVideoStatus('p2', 'published');
    const got = await database.getVideo('p2');
    expect(got?.status).toBe('published');
    expect(got?.input_cid).toBe('QmKeep');
  });

  it('updateVideoStatus on an unknown permlink is a no-op', async () => {
    await database.updateVideoStatus('ghost', 'failed');
    expect(await raw.collection(VIDEOS).countDocuments()).toBe(0);
  });
});

describe('time-window sweeps', () => {
  it('getStaleUploads: only `uploading` rows created before the cutoff', async () => {
    await database.createVideoEntry(video({ permlink: 'old-up', status: 'uploading', createdAt: hoursAgo(30) }));
    await database.createVideoEntry(video({ permlink: 'new-up', status: 'uploading', createdAt: hoursAgo(1) }));
    await database.createVideoEntry(video({ permlink: 'old-pub', status: 'published', createdAt: hoursAgo(30) }));
    const stale = await database.getStaleUploads(24);
    expect(stale.map((v) => v.permlink)).toEqual(['old-up']);
  });

  it('getStaleProcessing: `processing` rows judged by updatedAt, not createdAt', async () => {
    await database.createVideoEntry(video({ permlink: 'idle', status: 'processing', createdAt: hoursAgo(1), updatedAt: hoursAgo(10) }));
    await database.createVideoEntry(video({ permlink: 'busy', status: 'processing', createdAt: hoursAgo(10), updatedAt: minutesAgo(5) }));
    await database.createVideoEntry(video({ permlink: 'other', status: 'uploading', updatedAt: hoursAgo(10) }));
    const stale = await database.getStaleProcessing(6);
    expect(stale.map((v) => v.permlink)).toEqual(['idle']);
  });

  it('getAbandonedDeferred: `awaiting_encode` rows idle past the window, with or without a Hive post', async () => {
    await database.createVideoEntry(video({ permlink: 'gone', status: 'awaiting_encode', updatedAt: hoursAgo(13) }));
    await database.createVideoEntry(video({ permlink: 'gone-posted', status: 'awaiting_encode', hive_permlink: 'post', updatedAt: hoursAgo(13) }));
    await database.createVideoEntry(video({ permlink: 'fresh', status: 'awaiting_encode', updatedAt: hoursAgo(2) }));
    await database.createVideoEntry(video({ permlink: 'proc', status: 'processing', updatedAt: hoursAgo(13) }));
    const rows = await database.getAbandonedDeferred(12);
    expect(rows.map((v) => v.permlink).sort()).toEqual(['gone', 'gone-posted']);
  });

  it('getHealableDeferred: only idle `awaiting_encode` rows that already have a Hive post', async () => {
    await database.createVideoEntry(video({ permlink: 'heal', status: 'awaiting_encode', hive_permlink: 'my-post', updatedAt: minutesAgo(20) }));
    await database.createVideoEntry(video({ permlink: 'no-post', status: 'awaiting_encode', hive_permlink: null, updatedAt: minutesAgo(20) }));
    await database.createVideoEntry(video({ permlink: 'too-new', status: 'awaiting_encode', hive_permlink: 'p', updatedAt: minutesAgo(2) }));
    await database.createVideoEntry(video({ permlink: 'done', status: 'published', hive_permlink: 'p', updatedAt: minutesAgo(20) }));
    // A row missing the field entirely is not proof of publish either.
    const { hive_permlink, ...noField } = video({ permlink: 'no-field', status: 'awaiting_encode', updatedAt: minutesAgo(20) });
    void hive_permlink;
    await raw.collection(VIDEOS).insertOne(noField);
    const rows = await database.getHealableDeferred(10);
    expect(rows.map((v) => v.permlink)).toEqual(['heal']);
  });
});

describe('getPendingReplacements', () => {
  it('returns published, encoded replacements not yet applied', async () => {
    await database.createVideoEntry(video({ permlink: 'r-ready', status: 'published', manifest_cid: 'QmM', replacesPermlink: 'orig' }));
    await database.createVideoEntry(video({ permlink: 'r-applied', status: 'published', manifest_cid: 'QmM', replacesPermlink: 'orig', replacementApplied: true }));
    await database.createVideoEntry(video({ permlink: 'r-encoding', status: 'processing', manifest_cid: null, replacesPermlink: 'orig' }));
    await database.createVideoEntry(video({ permlink: 'r-nomanifest', status: 'published', manifest_cid: null, replacesPermlink: 'orig' }));
    await database.createVideoEntry(video({ permlink: 'r-null', status: 'published', manifest_cid: 'QmM', replacesPermlink: null }));
    await database.createVideoEntry(video({ permlink: 'plain', status: 'published', manifest_cid: 'QmM' }));
    await database.createVideoEntry(video({ permlink: 'r-false', status: 'published', manifest_cid: 'QmM', replacesPermlink: 'o2', replacementApplied: false }));
    const rows = await database.getPendingReplacements();
    expect(rows.map((v) => v.permlink).sort()).toEqual(['r-false', 'r-ready']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 4; i++) {
      await database.createVideoEntry(video({ permlink: `r${i}`, status: 'published', manifest_cid: 'QmM', replacesPermlink: 'orig' }));
    }
    expect(await database.getPendingReplacements(2)).toHaveLength(2);
    expect(await database.getPendingReplacements()).toHaveLength(4);
  });
});

describe('legacy videos collection', () => {
  it('getLegacyVideo reads the `videos` collection', async () => {
    await raw.collection('videos').insertOne({ permlink: 'leg', owner: 'carol', status: 'published', video_v2: 'ipfs://QmOld/manifest.m3u8', payout: 12 });
    const got = await database.getLegacyVideo('leg');
    expect(got?.owner).toBe('carol');
    expect(await database.getLegacyVideo('missing')).toBeNull();
  });

  it('updateLegacyVideoMedia only $sets the given fields and keeps the rest', async () => {
    await raw.collection('videos').insertOne({ permlink: 'leg2', owner: 'carol', status: 'published', video_v2: 'ipfs://QmOld/manifest.m3u8', payout: 12 });
    await database.updateLegacyVideoMedia('leg2', {
      video_v2: 'ipfs://QmNew/manifest.m3u8',
      previousVideoV2: 'ipfs://QmOld/manifest.m3u8',
      replacedByPermlink: 'newone',
    });
    const got: any = await raw.collection('videos').findOne({ permlink: 'leg2' });
    expect(got.video_v2).toBe('ipfs://QmNew/manifest.m3u8');
    expect(got.previousVideoV2).toBe('ipfs://QmOld/manifest.m3u8');
    expect(got.replacedByPermlink).toBe('newone');
    expect(got.payout).toBe(12);
    expect(got.status).toBe('published');
    expect(got.updatedAt).toBeInstanceOf(Date);
  });

  it('uses LEGACY_VIDEOS_COLLECTION when set', async () => {
    process.env.LEGACY_VIDEOS_COLLECTION = 'legacy-alt';
    try {
      const alt = await connectDb();
      await alt.raw.collection('legacy-alt').insertOne({ permlink: 'alt', owner: 'dan', status: 'published' });
      expect((await alt.database.getLegacyVideo('alt'))?.owner).toBe('dan');
      await alt.close();
    } finally {
      delete process.env.LEGACY_VIDEOS_COLLECTION;
    }
  });
});

describe('getRecentCountedUploads', () => {
  it('returns only counted statuses for that owner since the cutoff, oldest first, projected', async () => {
    const since = hoursAgo(24);
    await database.createVideoEntry(video({ permlink: 'c-proc', owner: 'eve', status: 'processing', createdAt: hoursAgo(3) }));
    await database.createVideoEntry(video({ permlink: 'c-await', owner: 'eve', status: 'awaiting_encode', createdAt: hoursAgo(5), short: true }));
    await database.createVideoEntry(video({ permlink: 'c-pub', owner: 'eve', status: 'published', createdAt: hoursAgo(1), stream_vod: true, replaces_existing: true, replacesPermlink: 'x' }));
    await database.createVideoEntry(video({ permlink: 'c-up', owner: 'eve', status: 'uploading', createdAt: hoursAgo(1) }));
    await database.createVideoEntry(video({ permlink: 'c-fail', owner: 'eve', status: 'failed', createdAt: hoursAgo(1) }));
    await database.createVideoEntry(video({ permlink: 'c-del', owner: 'eve', status: 'deleted', createdAt: hoursAgo(1) }));
    await database.createVideoEntry(video({ permlink: 'c-old', owner: 'eve', status: 'published', createdAt: hoursAgo(30) }));
    await database.createVideoEntry(video({ permlink: 'c-other', owner: 'frank', status: 'published', createdAt: hoursAgo(1) }));

    const rows = await database.getRecentCountedUploads('eve', since);
    expect(rows.map((r) => r.permlink)).toEqual(['c-await', 'c-proc', 'c-pub']);
    const pub = rows[2] as any;
    expect(pub).toMatchObject({ short: false, frontend_app: 'test-app', stream_vod: true, replaces_existing: true, replacesPermlink: 'x' });
    expect(pub._id).toBeUndefined();
    expect(pub.owner).toBeUndefined();
    expect(pub.size).toBeUndefined();
    expect(rows[0].short).toBe(true);
  });

  it('COUNTED_UPLOAD_STATUSES is processing, awaiting_encode, published', () => {
    expect(COUNTED_UPLOAD_STATUSES).toEqual(['processing', 'awaiting_encode', 'published']);
  });
});

describe('streamRecordExists', () => {
  it('true via stream-stats (host field) or stream-golive (owner field), false otherwise', async () => {
    await raw.collection('stream-stats').insertOne({ host: 'gina', roomName: 'room-a' });
    await raw.collection('stream-golive').insertOne({ owner: 'gina', roomName: 'room-b' });
    expect(await database.streamRecordExists('gina', 'room-a')).toBe(true);
    expect(await database.streamRecordExists('gina', 'room-b')).toBe(true);
    expect(await database.streamRecordExists('gina', 'room-c')).toBe(false);
    // Fields are not interchangeable: a stats row keyed by owner is not proof.
    await raw.collection('stream-stats').insertOne({ owner: 'hank', roomName: 'room-d' });
    expect(await database.streamRecordExists('hank', 'room-d')).toBe(false);
    expect(await database.streamRecordExists('other', 'room-a')).toBe(false);
  });
});
