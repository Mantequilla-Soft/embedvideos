import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

process.env.GATE_URL = 'https://gate.test';
process.env.GATE_INTERNAL_API_KEY = 'gate-internal-key';

vi.mock('../../src/utils/ipfs', () => ({
  pinFile: vi.fn(),
  unpinFile: vi.fn(),
  announceDHT: vi.fn(),
}));

import * as ipfs from '../../src/utils/ipfs';
import { api, loadApp, makeApiKey } from '../helpers/app';
import { insertVideo, insertUser, insertJob, makeToken, uid } from './fixtures';

const unpinFile = vi.mocked(ipfs.unpinFile);

let database: any;
let config: any;
let mod: any;
let KEY: Record<string, string>;

beforeAll(async () => {
  ({ database, config, mod } = await loadApp());
  KEY = { 'X-API-Key': await makeApiKey(database) };
});

beforeEach(() => {
  vi.clearAllMocks();
  unpinFile.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in tests'); }));
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

describe('GET / and /health', () => {
  it('serves public/index.html at the root', async () => {
    // express.static('public') is mounted before the `GET /` redirect to
    // /demo.html, so the static index wins and the redirect never runs.
    const res = await (await api()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect((await (await api()).get('/demo.html')).status).toBe(200);
  });

  it('reports load signals', async () => {
    const res = await (await api()).get('/health');
    expect(res.body).toMatchObject({ status: 'ok', service: '3speak-video-upload', activeUploads: 0 });
    expect(res.body.freeDiskPct).toBeGreaterThanOrEqual(0);
    expect(res.body.freeDiskPct).toBeLessThanOrEqual(100);
  });

  it('leaves freeDiskPct null when the upload dir cannot be stat\'ed', async () => {
    const saved = config.uploadDir;
    config.uploadDir = '/definitely/not/here';
    try {
      expect((await (await api()).get('/health')).body.freeDiskPct).toBeNull();
    } finally {
      config.uploadDir = saved;
    }
  });
});

describe('POST /video/:permlink/encode', () => {
  const finalizeFor = (permlink: string, owner = 'alice') => ({ Authorization: `Bearer ${makeToken({ scope: 'finalize', permlink, owner })}` });
  const parked = (overrides: Record<string, unknown> = {}) =>
    insertVideo(database, { owner: 'alice', status: 'awaiting_encode', input_cid: 'QmParked', defer_encode: true, size: 1234, ...overrides });

  async function encode(permlink: string, headers: Record<string, string>, body: unknown = {}) {
    return (await api()).post(`/video/${permlink}/encode`).set(headers).send(body as any);
  }

  it('is unavailable without an upload token secret', async () => {
    const saved = config.uploadTokenSecret;
    config.uploadTokenSecret = '';
    try {
      expect((await encode('x', {})).status).toBe(503);
    } finally {
      config.uploadTokenSecret = saved;
    }
  });

  it('needs a valid finalize token bound to this video and owner', async () => {
    const v = await parked();
    expect((await encode(v.permlink, {})).status).toBe(401);
    expect((await encode(v.permlink, { Authorization: 'Bearer garbage' })).status).toBe(401);
    // An upload token is not a finalize token.
    expect((await encode(v.permlink, { Authorization: `Bearer ${makeToken({ permlink: v.permlink })}` })).status).toBe(401);
    expect((await encode(v.permlink, finalizeFor('another'))).status).toBe(403);
    expect((await encode('nosuchvideo', finalizeFor('nosuchvideo'))).status).toBe(404);
    expect((await encode(v.permlink, finalizeFor(v.permlink, 'mallory'))).status).toBe(403);
    expect(await database.getJob('alice', v.permlink)).toBeNull();
  });

  it('commissions a public encode', async () => {
    await insertUser(database, 'alice', { premium: true });
    const v = await parked();
    const res = await encode(v.permlink, finalizeFor(v.permlink));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, gated: false, allowlist: [] });
    expect(await database.getJob('alice', v.permlink)).toMatchObject({ status: 'pending', premium: true, gated: false, fileSize: 1234, short: false });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', gated: false, gate_video_id: null });

    // Idempotent: a retried publish does not queue twice.
    const again = await encode(v.permlink, finalizeFor(v.permlink), { gated: true });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ success: true, already_queued: true, gated: false });
  });

  it('a failed job insert puts the video back, so a retried publish succeeds (no 409)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const v = await parked({ allowlist: [] });
    const spy = vi.spyOn(database, 'createJob').mockRejectedValueOnce(new Error('mongo blip'));
    const res = await encode(v.permlink, finalizeFor(v.permlink));
    spy.mockRestore();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'awaiting_encode', gated: false });
    expect(await database.getJob('alice', v.permlink)).toBeNull();

    const retry = await encode(v.permlink, finalizeFor(v.permlink));
    expect(retry.status).toBe(201);
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing' });
    expect(await database.getJob('alice', v.permlink)).toMatchObject({ status: 'pending' });
  });

  it('a job that already exists (concurrent publish) leaves the video processing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const v = await parked();
    const spy = vi.spyOn(database, 'createJob').mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const res = await encode(v.permlink, finalizeFor(v.permlink));
    spy.mockRestore();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect((await database.getVideo(v.permlink)).status).toBe('processing');
  });

  it('commissions a gated encode for a Pro owner with a cleaned allowlist', async () => {
    await insertUser(database, 'paula', { premium: true });
    const v = await parked({ owner: 'paula', short: true });
    const res = await encode(v.permlink, finalizeFor(v.permlink, 'paula'), { gated: true, allowlist: ['@Bob.One', 'bob.one', ' carol '] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, gated: true, allowlist: ['bob.one', 'carol'] });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', gated: true, gate_video_id: v.permlink, allowlist: ['bob.one', 'carol'] });
    expect(await database.getJob('paula', v.permlink)).toMatchObject({ gated: true, gateVideoId: v.permlink, short: true, premium: true });
  });

  it('refuses videos that are not parked or not pinned', async () => {
    const live = await parked({ status: 'processing' });
    const r1 = await encode(live.permlink, finalizeFor(live.permlink));
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('not_awaiting_encode');

    const unpinned = await parked({ input_cid: null });
    const r2 = await encode(unpinned.permlink, finalizeFor(unpinned.permlink));
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('not_pinned');
  });

  it('validates gated and the allowlist', async () => {
    await insertUser(database, 'vera', { premium: true });
    const v = await parked({ owner: 'vera' });
    const auth = finalizeFor(v.permlink, 'vera');
    expect((await encode(v.permlink, auth, { gated: 'yes' })).status).toBe(422);
    expect((await encode(v.permlink, auth, { gated: true, allowlist: 'bob' })).status).toBe(422);
    expect((await encode(v.permlink, auth, { gated: true, allowlist: Array(501).fill('bobby') })).status).toBe(422);
    const bad = await encode(v.permlink, auth, { gated: true, allowlist: ['ok-name', 'X'] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/"X" is not a valid Hive account name/);
    expect((await encode(v.permlink, auth, { gated: true, allowlist: [42] })).status).toBe(422);
    expect(await database.getJob('vera', v.permlink)).toBeNull();
  });

  it('refuses gating for non-Pro owners and on instances without a gate', async () => {
    const v = await parked({ owner: 'nopro' });
    const res = await encode(v.permlink, finalizeFor(v.permlink, 'nopro'), { gated: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pro_required');

    const saved = config.gateInternalApiKey;
    config.gateInternalApiKey = '';
    try {
      const r2 = await encode(v.permlink, finalizeFor(v.permlink, 'nopro'), { gated: true });
      expect(r2.status).toBe(503);
      expect(r2.body.code).toBe('gate_not_configured');
    } finally {
      config.gateInternalApiKey = saved;
    }
    expect(await database.getJob('nopro', v.permlink)).toBeNull();
    expect((await database.getVideo(v.permlink)).status).toBe('awaiting_encode');
  });

  it('reports internal errors as 500', async () => {
    const v = await parked();
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await encode(v.permlink, finalizeFor(v.permlink))).status).toBe(500);
    spy.mockRestore();
  });
});

describe('GET /video/:permlink', () => {
  it('returns the row or 404', async () => {
    const v = await insertVideo(database, { status: 'published', manifest_cid: 'QmM' });
    const res = await (await api()).get(`/video/${v.permlink}`);
    expect(res.body).toMatchObject({ permlink: v.permlink, owner: 'alice', manifest_cid: 'QmM' });
    expect((await (await api()).get('/video/none')).status).toBe(404);
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await (await api()).get('/video/x')).status).toBe(500);
    spy.mockRestore();
  });
});

describe('GET /users/:username/premium', () => {
  it('needs an API key and reports the flag', async () => {
    const r = await api();
    expect((await r.get('/users/alice/premium')).status).toBe(401);
    await insertUser(database, 'prem', { premium: true });
    await insertUser(database, 'plain', { premium: undefined });
    expect((await r.get('/users/prem/premium').set(KEY)).body).toEqual({ username: 'prem', premium: true });
    expect((await r.get('/users/plain/premium').set(KEY)).body).toEqual({ username: 'plain', premium: false });
    expect((await r.get('/users/ghost/premium').set(KEY)).status).toBe(404);
    const spy = vi.spyOn(database, 'getUser').mockRejectedValueOnce(new Error('db'));
    expect((await r.get('/users/prem/premium').set(KEY)).status).toBe(500);
    spy.mockRestore();
  });
});

describe('POST /video/:permlink/thumbnail', () => {
  it('sets the thumbnail without touching the status', async () => {
    const r = await api();
    const v = await insertVideo(database, { status: 'published' });
    expect((await r.post(`/video/${v.permlink}/thumbnail`).send({ thumbnail_url: 'x' })).status).toBe(401);
    expect((await r.post(`/video/${v.permlink}/thumbnail`).set(KEY).send({})).status).toBe(400);
    expect((await r.post('/video/none/thumbnail').set(KEY).send({ thumbnail_url: 'x' })).status).toBe(404);
    const ok = await r.post(`/video/${v.permlink}/thumbnail`).set(KEY).send({ thumbnail_url: 'https://img/t.jpg' });
    expect(ok.body).toEqual({ success: true, thumbnail_url: 'https://img/t.jpg' });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'published', thumbnail_url: 'https://img/t.jpg' });
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await r.post(`/video/${v.permlink}/thumbnail`).set(KEY).send({ thumbnail_url: 'x' })).status).toBe(500);
    spy.mockRestore();
  });
});

describe('GET /video/:permlink/replace-target', () => {
  it('finds embed and legacy targets', async () => {
    const r = await api();
    const v = await insertVideo(database, { owner: 'olga', status: 'published' });
    expect((await r.get(`/video/${v.permlink}/replace-target`).set(KEY)).body).toEqual({ found: true, kind: 'embed', owner: 'olga', status: 'published' });
    const legacy = uid('leg');
    await database.db.collection('videos').insertOne({ permlink: legacy, owner: 'olga', status: 'deleted' });
    expect((await r.get(`/video/${legacy}/replace-target`).set(KEY)).body).toEqual({ found: true, kind: 'legacy', owner: 'olga', status: 'deleted' });
    const none = await r.get('/video/nothing/replace-target').set(KEY);
    expect(none.status).toBe(404);
    expect(none.body.found).toBe(false);
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await r.get('/video/x/replace-target').set(KEY)).status).toBe(500);
    spy.mockRestore();
  });
});

describe('POST /video/:permlink/replaces', () => {
  async function register(permlink: string, body: unknown) {
    return (await api()).post(`/video/${permlink}/replaces`).set(KEY).send(body as any);
  }

  it('validates the request', async () => {
    const mine = await insertVideo(database, { owner: 'olga' });
    const theirs = await insertVideo(database, { owner: 'pete' });
    expect((await register(mine.permlink, {})).status).toBe(400);
    expect((await register(mine.permlink, { replaces: 5 })).status).toBe(400);
    expect((await register(mine.permlink, { replaces: mine.permlink })).status).toBe(400);
    expect((await register('ghost', { replaces: mine.permlink })).status).toBe(404);
    const noOrig = await register(mine.permlink, { replaces: 'ghost' });
    expect(noOrig.status).toBe(404);
    expect(noOrig.body.error).toMatch(/Original/);
    expect((await register(mine.permlink, { replaces: theirs.permlink })).status).toBe(403);
    expect((await database.getVideo(mine.permlink)).replacesPermlink).toBeUndefined();
  });

  it('registers a pending replacement and delists the carrier', async () => {
    const original = await insertVideo(database, { owner: 'olga', status: 'published', manifest_cid: 'QmOrig' });
    const carrier = await insertVideo(database, { owner: 'olga', status: 'processing', listed_on_3speak: true });
    const res = await register(carrier.permlink, { replaces: original.permlink });
    expect(res.body).toEqual({ success: true, permlink: carrier.permlink, replaces: original.permlink, applied: false, legacy: false });
    expect(await database.getVideo(carrier.permlink)).toMatchObject({
      status: 'processing', replacesPermlink: original.permlink, replacesLegacy: false, replacementApplied: false, listed_on_3speak: false,
    });
    expect((await database.getVideo(original.permlink)).manifest_cid).toBe('QmOrig');
  });

  it('registers against a legacy original', async () => {
    const legacy = uid('leg');
    await database.db.collection('videos').insertOne({ permlink: legacy, owner: 'olga', status: 'published' });
    const carrier = await insertVideo(database, { owner: 'olga', status: 'processing' });
    const res = await register(carrier.permlink, { replaces: legacy });
    expect(res.body).toMatchObject({ applied: false, legacy: true });
    expect((await database.getVideo(carrier.permlink)).replacesLegacy).toBe(true);
  });

  it('swaps immediately when the carrier is already encoded', async () => {
    const original = await insertVideo(database, { owner: 'olga', status: 'failed', manifest_cid: null });
    const carrier = await insertVideo(database, { owner: 'olga', status: 'published', manifest_cid: 'QmDone', originalFilename: 'new.mp4' });
    const res = await register(carrier.permlink, { replaces: original.permlink });
    expect(res.body).toMatchObject({ applied: true, legacy: false });
    expect(await database.getVideo(original.permlink)).toMatchObject({ status: 'published', manifest_cid: 'QmDone', previousManifestCid: null, originalFilename: 'new.mp4' });
    expect(await database.getVideo(carrier.permlink)).toMatchObject({ replacementApplied: true, replacedBy: original.permlink });
  });

  it('reports internal errors as 500', async () => {
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await register('a', { replaces: 'b' })).status).toBe(500);
    spy.mockRestore();
  });
});

describe('POST /video/:permlink/hive', () => {
  async function link(permlink: string, body: unknown) {
    return (await api()).post(`/video/${permlink}/hive`).set(KEY).send(body as any);
  }

  it('validates and 404s', async () => {
    expect((await link('x', { hive_author: 'a' })).status).toBe(400);
    expect((await link('ghost', { hive_author: 'a', hive_permlink: 'p' })).status).toBe(404);
  });

  it('links the post once and refuses a rebind to another post', async () => {
    const v = await insertVideo(database, { owner: 'olga', status: 'published' });
    const res = await link(v.permlink, { hive_author: 'olga', hive_permlink: 'my-post', hive_title: 'T', hive_body: 'B', hive_tags: ['a'] });
    expect(res.body).toEqual({ success: true, permlink: v.permlink, hive_author: 'olga', hive_permlink: 'my-post' });
    expect(await database.getVideo(v.permlink)).toMatchObject({
      status: 'published', hive_author: 'olga', hive_permlink: 'my-post', embed_url: '@olga/my-post', processed: true, hive_title: 'T', hive_body: 'B', hive_tags: ['a'],
    });

    const rebind = await link(v.permlink, { hive_author: 'someone', hive_permlink: 'wave' });
    expect(rebind.body).toEqual({ success: true, permlink: v.permlink, relinked: false, hive_author: 'olga', hive_permlink: 'my-post' });
    expect((await database.getVideo(v.permlink)).hive_permlink).toBe('my-post');

    // Same post again is idempotent and keeps fields that are not resent.
    const retry = await link(v.permlink, { hive_author: 'olga', hive_permlink: 'my-post' });
    expect(retry.body.hive_permlink).toBe('my-post');
    expect((await database.getVideo(v.permlink)).hive_title).toBe('T');
  });

  it('reports internal errors as 500', async () => {
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('db'));
    expect((await link('x', { hive_author: 'a', hive_permlink: 'p' })).status).toBe(500);
    spy.mockRestore();
  });
});

describe('sweepReplacements', () => {
  it('applies finished replacements the webhook never applied, and skips the rest', async () => {
    const original = await insertVideo(database, { owner: 'sam', status: 'published', manifest_cid: 'QmA', duration: 5 });
    const done = await insertVideo(database, { owner: 'sam', status: 'published', manifest_cid: 'QmB', replacesPermlink: original.permlink, replacesLegacy: false, replacementApplied: false });
    const orphan = await insertVideo(database, { owner: 'sam', status: 'published', manifest_cid: 'QmC', replacesPermlink: 'gone-original', replacementApplied: false });
    const encoding = await insertVideo(database, { owner: 'sam', status: 'processing', replacesPermlink: original.permlink, replacementApplied: false });

    await mod.sweepReplacements();

    expect(await database.getVideo(original.permlink)).toMatchObject({ manifest_cid: 'QmB', previousManifestCid: 'QmA', duration: 5 });
    expect((await database.getVideo(done.permlink)).replacementApplied).toBe(true);
    expect((await database.getVideo(orphan.permlink)).replacementApplied).toBe(false);
    expect((await database.getVideo(encoding.permlink)).replacementApplied).toBe(false);

    // Applied once only: a second sweep leaves the original alone.
    await database.updateVideoStatus(original.permlink, 'published', { manifest_cid: 'QmManual' });
    await mod.sweepReplacements();
    expect((await database.getVideo(original.permlink)).manifest_cid).toBe('QmManual');
  });

  it('keeps sweeping past a failing row and never throws', async () => {
    const a = await insertVideo(database, { owner: 'sam', status: 'published', manifest_cid: 'QmD', replacesPermlink: 'leg-x', replacesLegacy: true });
    const spy = vi.spyOn(database, 'getLegacyVideo').mockRejectedValue(new Error('legacy down'));
    await expect(mod.sweepReplacements()).resolves.toBeUndefined();
    spy.mockRestore();
    expect((await database.getVideo(a.permlink)).replacementApplied).toBeUndefined();

    // Missing legacy original: skipped, not applied.
    await mod.sweepReplacements();
    expect((await database.getVideo(a.permlink)).replacementApplied).toBeUndefined();
    await database.updateVideoStatus(a.permlink, 'failed');

    const spy2 = vi.spyOn(database, 'getPendingReplacements').mockRejectedValueOnce(new Error('db'));
    await expect(mod.sweepReplacements()).resolves.toBeUndefined();
    spy2.mockRestore();
  });
});

describe('sweepAbandonedDeferred', () => {
  it('unpins and fails deferred uploads older than 12h, leaving fresh ones', async () => {
    const old = await insertVideo(database, { status: 'awaiting_encode', input_cid: 'QmOld', ipfs_pin_endpoint: 'http://ipfs', updatedAt: hoursAgo(13) });
    const oldUnpinned = await insertVideo(database, { status: 'awaiting_encode', input_cid: null, updatedAt: hoursAgo(13) });
    const fresh = await insertVideo(database, { status: 'awaiting_encode', input_cid: 'QmNew', ipfs_pin_endpoint: 'http://ipfs', updatedAt: hoursAgo(1) });

    await mod.sweepAbandonedDeferred();

    expect(unpinFile).toHaveBeenCalledTimes(1);
    expect(unpinFile).toHaveBeenCalledWith('QmOld', 'http://ipfs');
    expect((await database.getVideo(old.permlink)).status).toBe('failed');
    expect((await database.getVideo(oldUnpinned.permlink)).status).toBe('failed');
    expect((await database.getVideo(fresh.permlink)).status).toBe('awaiting_encode');
  });

  it('marks the video failed even when the unpin fails', async () => {
    unpinFile.mockRejectedValueOnce(new Error('not pinned or pinned indirectly'));
    const v = await insertVideo(database, { status: 'awaiting_encode', input_cid: 'QmGone', ipfs_pin_endpoint: 'http://ipfs', updatedAt: hoursAgo(20) });
    await mod.sweepAbandonedDeferred();
    expect((await database.getVideo(v.permlink)).status).toBe('failed');
  });

  it('never throws', async () => {
    const v = await insertVideo(database, { status: 'awaiting_encode', updatedAt: hoursAgo(20) });
    const spy = vi.spyOn(database, 'updateVideoStatus').mockRejectedValueOnce(new Error('db'));
    await expect(mod.sweepAbandonedDeferred()).resolves.toBeUndefined();
    spy.mockRestore();
    expect((await database.getVideo(v.permlink)).status).toBe('awaiting_encode');
    await database.updateVideoStatus(v.permlink, 'failed');

    const spy2 = vi.spyOn(database, 'getAbandonedDeferred').mockRejectedValueOnce(new Error('db'));
    await expect(mod.sweepAbandonedDeferred()).resolves.toBeUndefined();
    spy2.mockRestore();
  });
});

describe('sweepHealableDeferred', () => {
  const stalled = (overrides: Record<string, unknown> = {}) =>
    insertVideo(database, { status: 'awaiting_encode', input_cid: 'QmIn', hive_permlink: 'post', hive_author: 'x', updatedAt: hoursAgo(1), ...overrides });

  it('commissions the encode for deferred uploads that already have a Hive post', async () => {
    const v = await stalled({ owner: 'hal', size: 77 });
    const noPost = await stalled({ owner: 'hal', hive_permlink: null });
    const recent = await stalled({ owner: 'hal', updatedAt: new Date() });
    const unpinned = await stalled({ owner: 'hal', input_cid: null });

    await mod.sweepHealableDeferred();

    expect(await database.getJob('hal', v.permlink)).toMatchObject({ status: 'pending', gated: false, fileSize: 77 });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', gated: false, gate_video_id: null, allowlist: [] });
    for (const p of [noPost, recent, unpinned]) {
      expect(await database.getJob('hal', p.permlink)).toBeNull();
      expect((await database.getVideo(p.permlink)).status).toBe('awaiting_encode');
    }
    await database.updateVideoStatus(unpinned.permlink, 'failed');
  });

  it('carries gating forward for Pro owners and skips gated videos whose Pro lapsed', async () => {
    await insertUser(database, 'gpro', { premium: true });
    const gated = await stalled({ owner: 'gpro', gated: true, allowlist: ['amy'] });
    const lapsed = await stalled({ owner: 'glapsed', gated: true, allowlist: 'not-an-array' });
    await mod.sweepHealableDeferred();
    expect(await database.getJob('gpro', gated.permlink)).toMatchObject({ gated: true, gateVideoId: gated.permlink, premium: true });
    expect(await database.getVideo(gated.permlink)).toMatchObject({ gated: true, gate_video_id: gated.permlink, allowlist: ['amy'] });
    expect(await database.getJob('glapsed', lapsed.permlink)).toBeNull();
    expect((await database.getVideo(lapsed.permlink)).status).toBe('awaiting_encode');
    await database.updateVideoStatus(lapsed.permlink, 'failed');
  });

  it('defers to a finalize call that already queued the job', async () => {
    const v = await stalled({ owner: 'ida' });
    await insertJob(database, 'ida', v.permlink, { status: 'pending' });
    await mod.sweepHealableDeferred();
    expect((await database.getVideo(v.permlink)).status).toBe('awaiting_encode');
    await database.updateVideoStatus(v.permlink, 'failed');
  });

  it('carries a non-array allowlist as empty and never throws', async () => {
    await insertUser(database, 'jpro', { premium: true });
    const v = await stalled({ owner: 'jpro', gated: true, allowlist: null });
    const spy = vi.spyOn(database, 'createJob').mockRejectedValueOnce(new Error('db blip'));
    await expect(mod.sweepHealableDeferred()).resolves.toBeUndefined();
    spy.mockRestore();
    // The job insert failed, so the video is put back as it was (not stranded
    // at 'processing' with no job), and the next sweep heals it.
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'awaiting_encode', allowlist: null });
    expect(await database.getJob('jpro', v.permlink)).toBeNull();
    await mod.sweepHealableDeferred();
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', allowlist: [] });

    const spy2 = vi.spyOn(database, 'getHealableDeferred').mockRejectedValueOnce(new Error('db'));
    await expect(mod.sweepHealableDeferred()).resolves.toBeUndefined();
    spy2.mockRestore();
  });
});
