import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { api, loadApp } from '../helpers/app';
import { makeDid, toDagJws, type TestDid } from './didKey';
import { makeVideo, makeJob } from './fixtures';

// Community encoder gateway. Every request carries a real Ed25519 did:key JWS,
// verified by the service's own dids/key-did-resolver stack.

const fetchMock = vi.fn(async () => {
  throw new Error('unexpected network call in gateway tests');
});
vi.stubGlobal('fetch', fetchMock);

let ctx: Awaited<ReturnType<typeof loadApp>>;
const col = (name: string) => (ctx.database as any).db.collection(name);
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA2 = 'f'.repeat(40);

beforeAll(async () => {
  ctx = await loadApp();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

async function register(id: TestDid, nodeInfo: Record<string, unknown> = {}) {
  const res = await (await api()).post('/api/v0/gateway/updateNode').send({ jws: id.sign({ node_info: { name: 'my node', ...nodeInfo } }) });
  expect(res.status).toBe(200);
  return res.body.encoder;
}
const poll = async (id: TestDid) => (await api()).post('/api/v0/gateway/myJob').send({ jws: id.sign({ ts: Date.now() }) });
const beat = async (id: TestDid, payload: Record<string, unknown> = {}) =>
  (await api()).post('/api/v0/gateway/heartbeat').send({ jws: id.sign({ ts: Date.now(), ...payload }) });

describe('JWS authentication on the gateway', () => {
  it.each(['updateNode', 'myJob', 'heartbeat'])('%s 401s for a missing, garbage or forged JWS', async (route) => {
    quiet();
    const r = await api();
    const url = `/api/v0/gateway/${route}`;
    expect((await r.post(url).send({})).status).toBe(401);
    expect((await r.post(url).send({ jws: 'a.b.c' })).status).toBe(401);
    const id = makeDid();
    const [h, , s] = id.sign({ node_info: { name: 'x' } }).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ node_info: { name: 'evil' } })).toString('base64url')}.${s}`;
    const res = await r.post(url).send({ jws: forged });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid JWS signature' });
  });

  it('a forged registration creates nothing', async () => {
    quiet();
    const id = makeDid();
    const other = makeDid();
    await (await api()).post('/api/v0/gateway/updateNode').send({ jws: other.sign({ name: 'x' }, { kid: id.kid }) });
    expect(await ctx.database.getEncoderByDid(id.did)).toBeNull();
  });
});

describe('POST /api/v0/gateway/updateNode', () => {
  it('registers a community encoder from a node_info payload', async () => {
    const id = makeDid();
    const enc = await register(id, { cryptoAccounts: { hive: 'operator1' }, peer_id: 'peer-1', commit_hash: '2.0.0', encoder_commit: SHA, behind_by: 4 });
    expect(enc).toEqual({ name: `community-${id.did.slice(-12)}`, did: id.did, tier: 'lite', access: 'community', enabled: true });

    const stored = await ctx.database.getEncoderByDid(id.did);
    expect(stored).toMatchObject({
      displayName: 'my node', hiveAccount: 'operator1', peerId: 'peer-1', commitHash: '2.0.0',
      encoderCommit: SHA, behindBy: 4, banned: false, maxFileSize: null, url: '', apiKey: '',
    });
    expect(stored!.versionReportedAt).toBeInstanceOf(Date);
    expect(stored!.lastSeenAt).toBeInstanceOf(Date);
  });

  it('accepts a flat payload with hive_account, and the DagJWS form', async () => {
    const id = makeDid();
    const res = await (await api()).post('/api/v0/gateway/updateNode')
      .send({ jws: toDagJws(id.sign({ name: 'flat', hive_account: 'op2' })) });
    expect(res.status).toBe(200);
    expect(await ctx.database.getEncoderByDid(id.did)).toMatchObject({ displayName: 'flat', hiveAccount: 'op2' });
  });

  it('re-registration keeps the stable name and clears version fields that are no longer reported', async () => {
    const id = makeDid();
    const first = await register(id, { encoder_commit: SHA, behind_by: 2 });
    const second = await register(id, { name: 'renamed', commit_hash: 'legacy' });
    expect(second.name).toBe(first.name);
    const stored = await ctx.database.getEncoderByDid(id.did);
    expect(stored).toMatchObject({ displayName: 'renamed', commitHash: 'legacy' });
    expect(stored).not.toHaveProperty('encoderCommit');
    expect(stored).not.toHaveProperty('behindBy');
    expect(stored).not.toHaveProperty('versionReportedAt');
    expect(await col('embed-encoders').countDocuments({ did: id.did })).toBe(1);
  });

  it('drops malformed version fields instead of rejecting the registration', async () => {
    const id = makeDid();
    await register(id, { encoder_commit: 'ABC', behind_by: -3 });
    const stored = await ctx.database.getEncoderByDid(id.did);
    expect(stored).not.toHaveProperty('encoderCommit');
    expect(stored).not.toHaveProperty('behindBy');
  });

  it('a node cannot grant itself trust, a better tier, or pick its own name', async () => {
    const id = makeDid();
    await register(id, { trusted: true, tier: 'performance', access: 'managed', enabled: true, banned: false, name: 'managed-gpu' } as any);
    const stored = await ctx.database.getEncoderByDid(id.did);
    expect(stored!.trusted).toBeUndefined();
    expect(stored).toMatchObject({ tier: 'lite', access: 'community', name: `community-${id.did.slice(-12)}`, displayName: 'managed-gpu' });
  });

  it('a re-registration does not lift an admin ban or disable', async () => {
    const id = makeDid();
    const enc = await register(id);
    await ctx.database.updateEncoder(enc.name, { banned: true, enabled: false });
    const again = await register(id, { enabled: true, banned: false } as any);
    expect(again.enabled).toBe(false);
    expect((await ctx.database.getEncoderByDid(id.did))!.banned).toBe(true);
  });

  it('500s when the database fails', async () => {
    quiet();
    vi.spyOn(ctx.database, 'upsertCommunityEncoder').mockRejectedValueOnce(new Error('x'));
    const res = await (await api()).post('/api/v0/gateway/updateNode').send({ jws: makeDid().sign({ name: 'n' }) });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/v0/gateway/myJob', () => {
  beforeEach(async () => {
    await col('embed-jobs').deleteMany({});
  });

  it('404s for an unregistered DID', async () => {
    const res = await poll(makeDid());
    expect(res.status).toBe(404);
  });

  it('403s for a disabled or banned encoder, without claiming', async () => {
    const video = await makeVideo(ctx.database);
    await makeJob(ctx.database, { owner: video.owner, permlink: video.permlink });
    for (const flag of [{ enabled: false }, { banned: true }]) {
      const id = makeDid();
      const enc = await register(id);
      await ctx.database.updateEncoder(enc.name, flag);
      const res = await poll(id);
      expect(res.status).toBe(403);
    }
    expect((await ctx.database.getJob(video.owner, video.permlink))!.status).toBe('pending');
  });

  it('returns job:null with nothing to do, and updates lastSeenAt', async () => {
    const id = makeDid();
    await register(id);
    await col('embed-encoders').updateOne({ did: id.did }, { $set: { lastSeenAt: new Date(0) } });
    const res = await poll(id);
    expect(res.body).toEqual({ success: true, job: null });
    expect((await ctx.database.getEncoderByDid(id.did))!.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('hands out the oldest free non-short job and marks it encoding', async () => {
    const id = makeDid();
    const enc = await register(id);
    const t = Date.now();
    const older = await makeVideo(ctx.database, { owner: 'erin', input_cid: 'QmOld', frontend_app: 'snapie', originalFilename: 'a.mp4' });
    const newer = await makeVideo(ctx.database, { owner: 'erin', input_cid: 'QmNew' });
    await makeJob(ctx.database, { owner: 'erin', permlink: newer.permlink, createdAt: new Date(t) });
    await makeJob(ctx.database, { owner: 'erin', permlink: older.permlink, createdAt: new Date(t - 1000) });

    const res = await poll(id);
    expect(res.status).toBe(200);
    const job = res.body.job;
    expect(job).toMatchObject({
      owner: 'erin', permlink: older.permlink, input_cid: 'https://ipfs.3speak.tv/ipfs/QmOld', short: false,
      premium: false, webhook_url: ctx.config.webhookUrl, frontend_app: 'snapie', originalFilename: 'a.mp4',
    });
    expect(job.api_key).toMatch(/^[0-9a-f]{64}$/);

    const stored = await ctx.database.getJob('erin', older.permlink);
    expect(stored).toMatchObject({ status: 'encoding', assignedWorker: enc.name, callbackToken: job.api_key });
    expect(stored!.assignedAt).toBeInstanceOf(Date);

    // Next poll gets the other job; the one after that gets nothing.
    expect((await poll(id)).body.job.permlink).toBe(newer.permlink);
    expect((await poll(id)).body.job).toBeNull();
  });

  it('never hands out premium, short, gated or legacy (unflagged) jobs', async () => {
    const id = makeDid();
    await register(id);
    const kinds = [{ premium: true }, { short: true }, { gated: true }, { premium: undefined }, { short: undefined }];
    for (const k of kinds) {
      const v = await makeVideo(ctx.database);
      await makeJob(ctx.database, { owner: v.owner, permlink: v.permlink, ...k });
    }
    expect((await poll(id)).body.job).toBeNull();
    expect(await col('embed-jobs').countDocuments({ status: 'pending' })).toBe(kinds.length);
  });

  it('skips jobs this encoder already failed, but another node can take them', async () => {
    const a = makeDid();
    const b = makeDid();
    const encA = await register(a);
    await register(b);
    const v = await makeVideo(ctx.database);
    await makeJob(ctx.database, { owner: v.owner, permlink: v.permlink, failedWorkers: [encA.name] });
    expect((await poll(a)).body.job).toBeNull();
    expect((await poll(b)).body.job.permlink).toBe(v.permlink);
  });

  it('a size-capped encoder only takes jobs of known size within its cap', async () => {
    const id = makeDid();
    const enc = await register(id);
    await ctx.database.updateEncoder(enc.name, { maxFileSize: 5000 });
    const big = await makeVideo(ctx.database);
    const unknown = await makeVideo(ctx.database);
    const fits = await makeVideo(ctx.database);
    await makeJob(ctx.database, { owner: big.owner, permlink: big.permlink, fileSize: 9000 });
    await makeJob(ctx.database, { owner: unknown.owner, permlink: unknown.permlink, fileSize: null });
    await makeJob(ctx.database, { owner: fits.owner, permlink: fits.permlink, fileSize: 4000 });
    expect((await poll(id)).body.job.permlink).toBe(fits.permlink);
    expect((await poll(id)).body.job).toBeNull();
  });

  it('resets the job when its video is missing or has no input CID', async () => {
    const id = makeDid();
    await register(id);
    await makeJob(ctx.database, { owner: 'nobody', permlink: 'no-video-row' });
    expect((await poll(id)).body).toEqual({ success: true, job: null });
    expect(await ctx.database.getJob('nobody', 'no-video-row')).toMatchObject({ status: 'pending', assignedWorker: null });

    await col('embed-jobs').deleteMany({});
    const v = await makeVideo(ctx.database, { input_cid: null });
    await makeJob(ctx.database, { owner: v.owner, permlink: v.permlink });
    expect((await poll(id)).body.job).toBeNull();
    expect((await ctx.database.getJob(v.owner, v.permlink))!.status).toBe('pending');
  });

  it('refuses a gated video even when the job record lacks gated:true', async () => {
    const err = quiet();
    const id = makeDid();
    await register(id);
    const v = await makeVideo(ctx.database, { gated: true });
    await makeJob(ctx.database, { owner: v.owner, permlink: v.permlink });
    const res = await poll(id);
    expect(res.body).toEqual({ success: true, job: null });
    expect(await ctx.database.getJob(v.owner, v.permlink)).toMatchObject({ status: 'pending', assignedWorker: null, callbackToken: expect.any(String) });
    expect(err.mock.calls.some((c) => String(c[0]).includes('BLOCKED'))).toBe(true);
  });

  it('500s when the database fails', async () => {
    quiet();
    const id = makeDid();
    await register(id);
    vi.spyOn(ctx.database, 'claimNextCommunityJob').mockRejectedValueOnce(new Error('x'));
    expect((await poll(id)).status).toBe(500);
  });
});

describe('POST /api/v0/gateway/heartbeat', () => {
  it('404s for an unregistered DID', async () => {
    expect((await beat(makeDid())).status).toBe(404);
  });

  it('updates lastSeenAt', async () => {
    const id = makeDid();
    await register(id);
    await col('embed-encoders').updateOne({ did: id.did }, { $set: { lastSeenAt: new Date(0) } });
    const res = await beat(id);
    expect(res.body).toEqual({ success: true });
    expect((await ctx.database.getEncoderByDid(id.did))!.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('works for a disabled encoder too (it is still alive)', async () => {
    const id = makeDid();
    const enc = await register(id);
    await ctx.database.updateEncoder(enc.name, { enabled: false });
    expect((await beat(id)).status).toBe(200);
  });

  it('keeps stored version fields when the heartbeat reports none', async () => {
    const id = makeDid();
    await register(id, { encoder_commit: SHA, behind_by: 3 });
    await beat(id);
    expect(await ctx.database.getEncoderByDid(id.did)).toMatchObject({ encoderCommit: SHA, behindBy: 3 });
  });

  it('stores a newer commit and behind count reported in a heartbeat', async () => {
    const id = makeDid();
    await register(id, { encoder_commit: SHA, behind_by: 3 });
    await beat(id, { encoder_commit: SHA2, behind_by: 0 });
    expect(await ctx.database.getEncoderByDid(id.did)).toMatchObject({ encoderCommit: SHA2, behindBy: 0 });
  });

  it('reads the version from a node_info wrapper too, and drops a stale behind count on a new commit', async () => {
    const id = makeDid();
    await register(id, { encoder_commit: SHA, behind_by: 3 });
    await beat(id, { node_info: { encoder_commit: SHA2 } });
    const enc = await ctx.database.getEncoderByDid(id.did);
    expect(enc).toMatchObject({ encoderCommit: SHA2 });
    expect(enc?.behindBy).toBeUndefined();
    expect(enc?.versionReportedAt).toBeInstanceOf(Date);
  });

  it('500s when the database fails', async () => {
    quiet();
    const id = makeDid();
    await register(id);
    vi.spyOn(ctx.database, 'updateEncoderLastSeen').mockRejectedValueOnce(new Error('x'));
    expect((await beat(id)).status).toBe(500);
  });
});

describe('public encoder status', () => {
  beforeAll(async () => {
    await col('embed-encoders').deleteMany({});
    const now = Date.now();
    await ctx.database.createEncoder({ name: 'm-legacy', url: 'https://m', apiKey: 'secret-m', enabled: true, createdAt: new Date(now - 5000), updatedAt: new Date() } as any);
    await ctx.database.createEncoder({ name: 'm-gpu', url: 'https://g', apiKey: 'secret-g', enabled: true, access: 'managed', tier: 'performance', hiveAccount: 'ops', lastSeenAt: new Date(now - 1000), createdAt: new Date(now - 4000), updatedAt: new Date() } as any);
    await ctx.database.createEncoder({ name: 'c-alive', did: 'did:key:alive', url: '', apiKey: '', enabled: true, access: 'community', hiveAccount: 'op1', lastSeenAt: new Date(now - 60_000), encoderCommit: SHA, behindBy: 2, createdAt: new Date(now - 3000), updatedAt: new Date() } as any);
    await ctx.database.createEncoder({ name: 'c-stale', did: 'did:key:stale', url: '', apiKey: '', enabled: false, banned: true, access: 'community', lastSeenAt: new Date(now - 10 * 60_000), behindBy: 9, createdAt: new Date(now - 2000), updatedAt: new Date() } as any);
    await ctx.database.createEncoder({ name: 'c-never', did: 'did:key:never', url: '', apiKey: '', enabled: true, access: 'community', encoderCommit: SHA2, createdAt: new Date(now - 1000), updatedAt: new Date() } as any);
  });

  it('GET /api/v0/encoders/status lists every encoder without secrets', async () => {
    const res = await (await api()).get('/api/v0/encoders/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.encoders).toEqual([
      { name: 'm-legacy', access: 'managed', operator: null, lastSeenAt: null },
      { name: 'm-gpu', access: 'managed', operator: 'ops', lastSeenAt: expect.any(String) },
      { name: 'c-alive', access: 'community', operator: 'op1', lastSeenAt: expect.any(String) },
      { name: 'c-stale', access: 'community', operator: null, lastSeenAt: expect.any(String) },
      { name: 'c-never', access: 'community', operator: null, lastSeenAt: null },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('secret-');
  });

  it('GET /api/v0/encoders/community shows community nodes with liveness and short commit', async () => {
    const res = await (await api()).get('/api/v0/encoders/community');
    expect(res.status).toBe(200);
    expect(res.body.encoders).toEqual([
      { name: 'c-alive', enabled: true, banned: false, lastSeenAt: expect.any(String), commit: SHA.slice(0, 7), behindBy: 2, alive: true },
      // behindBy without a known commit means nothing, so it is hidden.
      { name: 'c-stale', enabled: false, banned: true, lastSeenAt: expect.any(String), commit: null, behindBy: null, alive: false },
      { name: 'c-never', enabled: true, banned: false, lastSeenAt: null, commit: 'fffffff', behindBy: null, alive: false },
    ]);
  });

  it('both 500 when the database fails', async () => {
    quiet();
    const r = await api();
    vi.spyOn(ctx.database, 'getAllEncoders').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/api/v0/encoders/status')).status).toBe(500);
    vi.spyOn(ctx.database, 'getAllEncoders').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/api/v0/encoders/community')).status).toBe(500);
  });
});

it('never touched the network', () => {
  expect(fetchMock).not.toHaveBeenCalled();
});
