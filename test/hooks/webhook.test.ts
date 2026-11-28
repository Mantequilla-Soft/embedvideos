import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

process.env.GATE_URL = 'https://gate.test/';
process.env.GATE_INTERNAL_API_KEY = 'gate-internal-key';
process.env.GATE_CDN_BASE = 'https://cdn.test/ipfs/';

vi.mock('../../src/utils/ipfs', () => ({
  pinFile: vi.fn(),
  unpinFile: vi.fn(),
  announceDHT: vi.fn(),
}));

import * as ipfs from '../../src/utils/ipfs';
import { api, loadApp } from '../helpers/app';
import { insertVideo, insertUser, insertJob, uid } from './fixtures';

const unpinFile = vi.mocked(ipfs.unpinFile);
const KEY = { 'X-API-Key': process.env.WEBHOOK_API_KEY! };

let database: any;
let config: any;
const fetchMock = vi.fn();

const ENCRYPTED_MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n480p/index.m3u8\n';
const ENCRYPTED_MEDIA = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\nseg0.ts\n';
const PLAIN_MEDIA = '#EXTM3U\n#EXTINF:4,\nseg0.ts\n';

/** Answers the CDN manifest fetches and the gate registration. */
function gateWorld(opts: { media?: string; gateStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://gate.test/internal/videos')) {
      return new Response(opts.gateStatus && opts.gateStatus >= 400 ? 'nope' : '{}', { status: opts.gateStatus ?? 201 });
    }
    if (url.endsWith('/manifest.m3u8')) return new Response(ENCRYPTED_MASTER, { status: 200 });
    return new Response(opts.media ?? ENCRYPTED_MEDIA, { status: 200 });
  });
}

beforeAll(async () => {
  ({ database, config } = await loadApp());
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('no network in tests'));
  vi.stubGlobal('fetch', fetchMock);
  unpinFile.mockResolvedValue(undefined);
});

async function hook(body: Record<string, unknown>, headers: Record<string, string> = KEY) {
  return (await api()).post('/webhook').set(headers).send(body);
}

describe('POST /webhook auth', () => {
  it('rejects a missing or wrong key', async () => {
    expect((await hook({ status: 'complete' }, {})).status).toBe(401);
    // A wrong key needs a job whose callback token matches.
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink);
    const noToken = await hook({ owner: v.owner, permlink: v.permlink, status: 'complete' }, { 'X-API-Key': 'wrong' });
    expect(noToken.status).toBe(401);
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing' });

    expect((await hook({ owner: v.owner, permlink: 'nojob', status: 'complete' }, { 'X-API-Key': 'wrong' })).status).toBe(401);
  });

  it('accepts a community encoder\'s per-job callback token, and only that one', async () => {
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink, { callbackToken: 'cb-secret' });
    expect((await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmM' }, { 'X-API-Key': 'cb-other' })).status).toBe(401);
    const ok = await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmM' }, { 'X-API-Key': 'cb-secret' });
    expect(ok.status).toBe(200);
    expect((await database.getVideo(v.permlink)).status).toBe('published');
  });
});

describe('POST /webhook complete', () => {
  it('publishes the video, completes the job, unpins the input and counts the success', async () => {
    await insertUser(database, 'wendy');
    const v = await insertVideo(database, { owner: 'wendy', status: 'processing', input_cid: 'QmIn', ipfs_pin_endpoint: 'http://127.0.0.1:5001' });
    await insertJob(database, 'wendy', v.permlink);
    const res = await hook({ owner: 'wendy', permlink: v.permlink, status: 'complete', manifest_cid: 'QmManifest' });
    expect(res.body).toEqual({ success: true, message: 'Webhook processed successfully' });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'published', manifest_cid: 'QmManifest', encodingProgress: 100 });
    const job = await database.getJob('wendy', v.permlink);
    expect(job.status).toBe('completed');
    expect(job.webhookReceivedAt).toBeInstanceOf(Date);
    expect(unpinFile).toHaveBeenCalledWith('QmIn', 'http://127.0.0.1:5001');
    expect((await database.getUser('wendy')).stats.successfulUploads).toBe(1);
    // Not gated: the gate is never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps going when unpinning or the success stats fail', async () => {
    unpinFile.mockRejectedValueOnce(new Error('not pinned'));
    const spy = vi.spyOn(database, 'incrementUserSuccess').mockRejectedValueOnce(new Error('stats'));
    const v = await insertVideo(database, { status: 'processing', input_cid: 'QmIn', ipfs_pin_endpoint: 'http://x' });
    const res = await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmM2' });
    expect(res.status).toBe(200);
    expect((await database.getVideo(v.permlink)).status).toBe('published');
    spy.mockRestore();
  });

  it('verifies a gated video\'s encryption and registers it with the gate', async () => {
    gateWorld();
    const v = await insertVideo(database, { owner: 'alice', status: 'processing', gated: true, gate_video_id: 'gate-vid', allowlist: ['bob'], public_at: new Date('2027-01-01T00:00:00Z') });
    const res = await hook({ owner: 'alice', permlink: v.permlink, status: 'complete', manifest_cid: 'QmGated' });
    expect(res.status).toBe(200);
    expect((await database.getVideo(v.permlink)).status).toBe('published');

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://cdn.test/ipfs/QmGated/manifest.m3u8');
    expect(urls).toContain('https://cdn.test/ipfs/QmGated/720p/index.m3u8');
    expect(urls).toContain('https://cdn.test/ipfs/QmGated/480p/index.m3u8');
    const reg = fetchMock.mock.calls.find((c) => c[0] === 'https://gate.test/internal/videos')!;
    expect(reg[1].method).toBe('POST');
    expect(reg[1].headers['X-API-Key']).toBe('gate-internal-key');
    expect(JSON.parse(reg[1].body)).toEqual({
      videoId: 'gate-vid',
      creator: 'alice',
      gated: true,
      upstreamBaseUrl: 'https://cdn.test/ipfs/QmGated/',
      manifestPath: 'manifest.m3u8',
      previewUrl: 'https://cdn.test/ipfs/QmGated/preview/index.m3u8',
      allowlist: ['bob'],
      publicAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('fails a gated video whose renditions came back unencrypted, without registering it', async () => {
    gateWorld({ media: PLAIN_MEDIA });
    const v = await insertVideo(database, { status: 'processing', gated: true, gate_video_id: null });
    const res = await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmPlain' });
    expect(res.status).toBe(200);
    expect((await database.getVideo(v.permlink)).status).toBe('failed');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/internal/videos'))).toBe(false);
  });

  it('fails a gated video the gate refuses', async () => {
    gateWorld({ gateStatus: 500 });
    const v = await insertVideo(database, { status: 'processing', gated: true });
    await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmRefused' });
    expect((await database.getVideo(v.permlink)).status).toBe('failed');
  });

  it('fails a gated video when this instance has no gate configured', async () => {
    const saved = config.gateUrl;
    config.gateUrl = '';
    try {
      const v = await insertVideo(database, { status: 'processing', gated: true });
      await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmNoGate' });
      expect((await database.getVideo(v.permlink)).status).toBe('failed');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.gateUrl = saved;
    }
  });

  it('keeps a gated replacement whose output came back unencrypted off the original', async () => {
    gateWorld({ media: PLAIN_MEDIA });
    const original = await insertVideo(database, { owner: 'gina', status: 'published', manifest_cid: 'QmPaidOld', gated: true });
    const carrier = await insertVideo(database, {
      owner: 'gina', status: 'processing', gated: true, replacesPermlink: original.permlink, replacesLegacy: false, replacementApplied: false,
    });
    const res = await hook({ owner: 'gina', permlink: carrier.permlink, status: 'complete', manifest_cid: 'QmPlainNew' });
    expect(res.status).toBe(200);
    expect(await database.getVideo(carrier.permlink)).toMatchObject({ status: 'failed', replacementApplied: false });
    const o = await database.getVideo(original.permlink);
    expect(o).toMatchObject({ status: 'published', manifest_cid: 'QmPaidOld' });
    expect(o.previousManifestCid).toBeUndefined();

    // The sweep does not pick it up later either.
    const { mod } = await loadApp();
    await mod.sweepReplacements();
    expect((await database.getVideo(original.permlink)).manifest_cid).toBe('QmPaidOld');
  });

  it('hands a finished replacement\'s manifest to the original embed video', async () => {
    const original = await insertVideo(database, { owner: 'rita', status: 'published', manifest_cid: 'QmOld', views: 42, hive_permlink: 'post', duration: 10 });
    const carrier = await insertVideo(database, {
      owner: 'rita', status: 'processing', replacesPermlink: original.permlink, replacesLegacy: false, replacementApplied: false, duration: 20, size: 999,
    });
    await hook({ owner: 'rita', permlink: carrier.permlink, status: 'complete', manifest_cid: 'QmNew' });

    const o = await database.getVideo(original.permlink);
    expect(o).toMatchObject({ status: 'published', manifest_cid: 'QmNew', previousManifestCid: 'QmOld', views: 42, hive_permlink: 'post', duration: 20, size: 999 });
    expect(o.mediaUpdatedAt).toBeInstanceOf(Date);
    expect(await database.getVideo(carrier.permlink)).toMatchObject({ replacementApplied: true, replaced: true, replacedBy: original.permlink });
  });

  it('revives a deleted legacy original when its replacement finishes', async () => {
    const legacyPermlink = uid('legacy');
    await database.db.collection('videos').insertOne({ permlink: legacyPermlink, owner: 'rita', status: 'deleted', video_v2: 'ipfs://QmDead/manifest.m3u8', title: 'Old talk' });
    const carrier = await insertVideo(database, { owner: 'rita', status: 'processing', replacesPermlink: legacyPermlink, replacesLegacy: true, replacementApplied: false });
    await hook({ owner: 'rita', permlink: carrier.permlink, status: 'complete', manifest_cid: 'QmFresh' });

    const legacy = await database.getLegacyVideo(legacyPermlink);
    expect(legacy).toMatchObject({
      status: 'published',
      video_v2: 'ipfs://QmFresh/manifest.m3u8',
      ipfs: 'QmFresh',
      previousVideoV2: 'ipfs://QmDead/manifest.m3u8',
      previousStatus: 'deleted',
      replacedByPermlink: carrier.permlink,
      title: 'Old talk',
    });
    expect((await database.getVideo(carrier.permlink)).replacementApplied).toBe(true);
  });

  it('does not change the status of a scheduled legacy original', async () => {
    const legacyPermlink = uid('legacy');
    await database.db.collection('videos').insertOne({ permlink: legacyPermlink, owner: 'rita', status: 'scheduled' });
    const carrier = await insertVideo(database, { owner: 'rita', status: 'processing', replacesPermlink: legacyPermlink, replacesLegacy: true });
    await hook({ owner: 'rita', permlink: carrier.permlink, status: 'complete', manifest_cid: 'QmSched' });
    expect(await database.getLegacyVideo(legacyPermlink)).toMatchObject({ status: 'scheduled', video_v2: 'ipfs://QmSched/manifest.m3u8', previousVideoV2: null });
  });

  it('answers 200 even when applying the replacement throws', async () => {
    const carrier = await insertVideo(database, { status: 'processing', replacesPermlink: 'whatever', replacesLegacy: true });
    const spy = vi.spyOn(database, 'getLegacyVideo').mockRejectedValueOnce(new Error('legacy db down'));
    const res = await hook({ owner: carrier.owner, permlink: carrier.permlink, status: 'complete', manifest_cid: 'QmX' });
    expect(res.status).toBe(200);
    spy.mockRestore();
  });
});

describe('POST /webhook failed', () => {
  it('requeues within the retry budget and remembers the failing encoder', async () => {
    const v = await insertVideo(database, { status: 'processing', encodingProgress: 55 });
    await insertJob(database, v.owner, v.permlink, { attemptCount: 0, assignedWorker: 'enc-a', encoderJobId: 'J1' });
    const res = await hook({ owner: v.owner, permlink: v.permlink, status: 'failed', error: 'ffmpeg died', job_id: 'J1' });
    expect(res.body.message).toMatch(/requeued/);
    const job = await database.getJob(v.owner, v.permlink);
    expect(job).toMatchObject({ status: 'pending', attemptCount: 1, failedWorkers: ['enc-a'], assignedWorker: null, encoderJobId: null });
    expect(job.lastError).toBe('ffmpeg died (attempt 1/3, requeueing)');
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', encodingProgress: 0 });
  });

  it('ignores a stale report from an encoder that already lost the job', async () => {
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink, { encoderJobId: 'J-current', assignedWorker: 'enc-b' });
    const res = await hook({ owner: v.owner, permlink: v.permlink, status: 'failed', job_id: 'J-old' });
    expect(res.body.message).toBe('Stale failure ignored');
    expect(await database.getJob(v.owner, v.permlink)).toMatchObject({ status: 'encoding', attemptCount: 0, assignedWorker: 'enc-b' });
  });

  it('fails permanently once the budget is spent and keeps the input pinned', async () => {
    await insertUser(database, 'fred');
    const v = await insertVideo(database, { owner: 'fred', status: 'processing', input_cid: 'QmKeep', ipfs_pin_endpoint: 'http://x' });
    await insertJob(database, 'fred', v.permlink, { attemptCount: 2 });
    const res = await hook({ owner: 'fred', permlink: v.permlink, status: 'failed' });
    expect(res.body.message).toBe('Webhook processed (failure recorded)');
    expect((await database.getVideo(v.permlink)).status).toBe('failed');
    expect(await database.getJob('fred', v.permlink)).toMatchObject({ status: 'failed', lastError: 'Encoding failed' });
    expect((await database.getUser('fred')).stats.failedUploads).toBe(1);
    expect(unpinFile).not.toHaveBeenCalled();
  });

  it('fails a video that has no job at all, tolerating a stats error', async () => {
    const spy = vi.spyOn(database, 'incrementUserFailure').mockRejectedValueOnce(new Error('stats'));
    const v = await insertVideo(database, { status: 'processing' });
    const res = await hook({ owner: v.owner, permlink: v.permlink, status: 'failed', error: 'x' });
    expect(res.status).toBe(200);
    expect((await database.getVideo(v.permlink)).status).toBe('failed');
    spy.mockRestore();
  });

  it('rejects an unknown status and reports internal errors as 500', async () => {
    expect((await hook({ owner: 'a', permlink: 'b', status: 'exploded' })).status).toBe(400);
    const spy = vi.spyOn(database, 'updateVideoStatus').mockRejectedValueOnce(new Error('db down'));
    expect((await hook({ owner: 'a', permlink: 'b', status: 'complete' })).status).toBe(500);
    spy.mockRestore();
  });
});

describe('POST /webhook/progress', () => {
  async function progress(body: Record<string, unknown>, headers: Record<string, string> = KEY) {
    return (await api()).post('/webhook/progress').set(headers).send(body);
  }

  it('validates the body and needs a job', async () => {
    expect((await progress({ owner: 'a', permlink: 'b', progress: '50' })).status).toBe(400);
    expect((await progress({ owner: 'a', permlink: 'b' })).status).toBe(400);
    expect((await progress({ owner: 'a', permlink: 'nojob', progress: 5 })).status).toBe(404);
  });

  it('records progress and stage on the job and the video', async () => {
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink, { status: 'encoding' });
    const res = await progress({ owner: v.owner, permlink: v.permlink, progress: 40, stage: '720p' });
    expect(res.body).toEqual({ success: true });
    expect(await database.getJob(v.owner, v.permlink)).toMatchObject({ encodingProgress: 40, encodingStage: '720p', status: 'encoding' });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', encodingProgress: 40 });

    await progress({ owner: v.owner, permlink: v.permlink, progress: 60 });
    expect((await database.getJob(v.owner, v.permlink)).encodingStage).toBeNull();
  });

  it('ignores a ping that arrives after the job finished: the published video stays published', async () => {
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink, { status: 'encoding' });
    await hook({ owner: v.owner, permlink: v.permlink, status: 'complete', manifest_cid: 'QmDone' });
    const late = await progress({ owner: v.owner, permlink: v.permlink, progress: 95, stage: 'upload' });
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ success: true, ignored: true });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'published', encodingProgress: 100, manifest_cid: 'QmDone' });
    expect(await database.getJob(v.owner, v.permlink)).toMatchObject({ status: 'completed' });
  });

  it('ignores pings for a requeued or failed job', async () => {
    for (const status of ['pending', 'failed']) {
      const v = await insertVideo(database, { status: status === 'failed' ? 'failed' : 'processing', encodingProgress: 0 });
      await insertJob(database, v.owner, v.permlink, { status });
      expect((await progress({ owner: v.owner, permlink: v.permlink, progress: 50 })).body).toEqual({ success: true, ignored: true });
      expect((await database.getVideo(v.permlink)).encodingProgress).toBe(0);
      expect((await database.getJob(v.owner, v.permlink)).status).toBe(status);
    }
  });

  it('accepts the per-job callback token and refuses anything else', async () => {
    const v = await insertVideo(database, { status: 'processing' });
    await insertJob(database, v.owner, v.permlink, { callbackToken: 'cb-1' });
    expect((await progress({ owner: v.owner, permlink: v.permlink, progress: 1 }, {})).status).toBe(401);
    expect((await progress({ owner: v.owner, permlink: v.permlink, progress: 1 }, { 'X-API-Key': 'cb-2' })).status).toBe(401);
    expect((await progress({ owner: v.owner, permlink: v.permlink, progress: 9 }, { 'X-API-Key': 'cb-1' })).status).toBe(200);
    expect((await database.getJob(v.owner, v.permlink)).encodingProgress).toBe(9);
  });

  it('reports internal errors as 500', async () => {
    const spy = vi.spyOn(database, 'getJob').mockRejectedValueOnce(new Error('db down'));
    expect((await progress({ owner: 'a', permlink: 'b', progress: 1 })).status).toBe(500);
    spy.mockRestore();
  });
});
