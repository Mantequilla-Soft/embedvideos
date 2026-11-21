import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { writeFileSync, utimesSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { api, loadApp, ADMIN, makeApiKey } from '../helpers/app';
import { makeVideo, makeJob, makeUser } from './fixtures';

// Nothing in these routes should reach the network; fail loudly if one does.
const fetchMock = vi.fn(async () => {
  throw new Error('unexpected network call in admin tests');
});
vi.stubGlobal('fetch', fetchMock);

let ctx: Awaited<ReturnType<typeof loadApp>>;
beforeAll(async () => {
  ctx = await loadApp();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('admin auth on every /admin route', () => {
  const routes: Array<[string, string]> = [
    ['post', '/admin/jobs/a/b/redispatch'],
    ['get', '/admin/jobs'],
    ['post', '/admin/api-keys'],
    ['get', '/admin/api-keys'],
    ['patch', '/admin/api-keys/x'],
    ['get', '/admin/users'],
    ['patch', '/admin/users/x/ban'],
    ['patch', '/admin/users/x/premium'],
    ['get', '/admin/cleanup/preview'],
    ['post', '/admin/cleanup/run'],
    ['get', '/admin/encoders'],
    ['post', '/admin/encoders'],
    ['patch', '/admin/encoders/x'],
    ['delete', '/admin/encoders/x'],
    ['get', '/admin/encoder-stats'],
  ];

  it.each(routes)('%s %s: 401 without, 403 with a wrong password', async (method, url) => {
    const r: any = await api();
    expect((await r[method](url)).status).toBe(401);
    expect((await r[method](url).set('X-Admin-Password', 'wrong')).status).toBe(403);
  });

  it('accepts the X-Admin-Password header too', async () => {
    const res = await (await api()).get('/admin/api-keys').set('X-Admin-Password', process.env.ADMIN_PASSWORD!);
    expect(res.status).toBe(200);
  });
});

describe('POST /admin/jobs/:owner/:permlink/redispatch', () => {
  it('404s for an unknown job', async () => {
    const res = await (await api()).post('/admin/jobs/nobody/nothing/redispatch').set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });

  it('404s when the job has no video', async () => {
    const job = await makeJob(ctx.database, { status: 'failed' });
    const res = await (await api()).post(`/admin/jobs/${job.owner}/${job.permlink}/redispatch`).set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Video not found');
  });

  it('400s when the video has no input CID', async () => {
    const video = await makeVideo(ctx.database, { input_cid: null });
    await makeJob(ctx.database, { owner: video.owner, permlink: video.permlink, status: 'failed' });
    const res = await (await api()).post(`/admin/jobs/${video.owner}/${video.permlink}/redispatch`).set(ADMIN);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no input_cid/);
  });

  it('resets a failed job to pending and the video to processing', async () => {
    const video = await makeVideo(ctx.database, { status: 'failed', encodingProgress: 55 });
    await makeJob(ctx.database, {
      owner: video.owner, permlink: video.permlink, status: 'failed',
      attemptCount: 5, assignedWorker: 'enc-a', lastError: 'boom', failedWorkers: ['enc-a', 'enc-b'],
    });

    const res = await (await api()).post(`/admin/jobs/${video.owner}/${video.permlink}/redispatch`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      job: { owner: video.owner, permlink: video.permlink, previousStatus: 'failed' },
    });

    const job = await ctx.database.getJob(video.owner, video.permlink);
    expect(job).toMatchObject({ status: 'pending', attemptCount: 0, assignedWorker: null, lastError: null });
    expect(job!.failedWorkers).toBeUndefined();
    const v = await ctx.database.getVideo(video.permlink);
    expect(v).toMatchObject({ status: 'processing', encodingProgress: 0 });
  });

  it('500s when the database fails', async () => {
    quiet();
    vi.spyOn(ctx.database, 'getJob').mockRejectedValueOnce(new Error('db down'));
    const res = await (await api()).post('/admin/jobs/a/b/redispatch').set(ADMIN);
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/jobs', () => {
  it('defaults to failed jobs, joined with their video', async () => {
    const video = await makeVideo(ctx.database, { originalFilename: 'broken.mov', status: 'failed' });
    await makeJob(ctx.database, { owner: video.owner, permlink: video.permlink, status: 'failed', lastError: 'x', failedWorkers: ['e1'] });
    const orphan = await makeJob(ctx.database, { status: 'failed' });
    await makeJob(ctx.database, { status: 'pending' });

    const res = await (await api()).get('/admin/jobs').set(ADMIN);
    expect(res.status).toBe(200);
    const byPermlink = Object.fromEntries(res.body.jobs.map((j: any) => [j.permlink, j]));
    expect(res.body.count).toBe(res.body.jobs.length);
    expect(res.body.jobs.every((j: any) => j.status === 'failed')).toBe(true);
    expect(byPermlink[video.permlink]).toMatchObject({
      input_cid: 'QmInputCid', originalFilename: 'broken.mov', videoStatus: 'failed', failedWorkers: ['e1'], lastError: 'x',
    });
    // A job without the field reads as "no failed workers".
    expect(byPermlink[orphan.permlink].failedWorkers).toEqual([]);
    expect(byPermlink[orphan.permlink].input_cid).toBeUndefined();
  });

  it('filters by status and caps the limit at 100', async () => {
    for (let i = 0; i < 3; i++) await makeJob(ctx.database, { status: 'completed' });
    const r = await api();
    const two = await r.get('/admin/jobs?status=completed&limit=2').set(ADMIN);
    expect(two.body.count).toBe(2);
    const spy = vi.spyOn(ctx.database, 'getJobsForVideofixer');
    await r.get('/admin/jobs?status=completed&limit=5000').set(ADMIN);
    expect(spy).toHaveBeenLastCalledWith('completed', 100);
    await r.get('/admin/jobs?status=completed&limit=abc').set(ADMIN);
    expect(spy).toHaveBeenLastCalledWith('completed', 20);
  });

  it('400s on an unknown status', async () => {
    const res = await (await api()).get('/admin/jobs?status=bogus').set(ADMIN);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending, encoding, completed, failed/);
  });

  it('500s when the database fails', async () => {
    quiet();
    vi.spyOn(ctx.database, 'getJobsForVideofixer').mockRejectedValueOnce(new Error('x'));
    expect((await (await api()).get('/admin/jobs').set(ADMIN)).status).toBe(500);
  });
});

describe('/admin/api-keys', () => {
  it('requires app_name and owner', async () => {
    const r = await api();
    expect((await r.post('/admin/api-keys').set(ADMIN).send({ app_name: 'x' })).status).toBe(400);
    expect((await r.post('/admin/api-keys').set(ADMIN).send({ owner: 'x' })).status).toBe(400);
  });

  it('creates a working key, lists it, then revokes and restores it', async () => {
    await makeUser(ctx.database, 'someone');
    const r = await api();
    const created = await r.post('/admin/api-keys').set(ADMIN).send({ app_name: 'Cool App', owner: 'bob' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ success: true, app_name: 'Cool App', owner: 'bob' });
    const key: string = created.body.key;
    expect(key).toMatch(/^sk_coolapp_[0-9a-f]{48}$/);

    const list = await r.get('/admin/api-keys').set(ADMIN);
    const row = list.body.keys.find((k: any) => k.key === key);
    expect(row).toMatchObject({ app_name: 'Cool App', owner: 'bob', active: true, lastUsed: null });

    // The new key is accepted by requireApiKey-protected routes.
    expect((await r.get('/users/someone/premium').set('X-API-Key', key)).status).toBe(200);

    const off = await r.patch(`/admin/api-keys/${key}`).set(ADMIN).send({ active: false });
    expect(off.body).toEqual({ success: true, key, active: false });
    expect((await ctx.database.getApiKey(key))!.active).toBe(false);
    expect((await r.get('/users/someone/premium').set('X-API-Key', key)).status).toBe(403);

    const on = await r.patch(`/admin/api-keys/${key}`).set(ADMIN).send({ active: true });
    expect(on.body.active).toBe(true);
    expect((await r.get('/users/someone/premium').set('X-API-Key', key)).status).toBe(200);
  });

  it('PATCH validates the body and 404s unknown keys', async () => {
    const r = await api();
    const key = await makeApiKey(ctx.database);
    expect((await r.patch(`/admin/api-keys/${key}`).set(ADMIN).send({ active: 'false' })).status).toBe(400);
    expect((await r.patch(`/admin/api-keys/${key}`).set(ADMIN).send({})).status).toBe(400);
    expect((await r.patch('/admin/api-keys/sk_missing').set(ADMIN).send({ active: false })).status).toBe(404);
  });

  it('500s when the database fails', async () => {
    quiet();
    const r = await api();
    vi.spyOn(ctx.database, 'createApiKey').mockRejectedValueOnce(new Error('x'));
    expect((await r.post('/admin/api-keys').set(ADMIN).send({ app_name: 'a', owner: 'b' })).status).toBe(500);
    vi.spyOn(ctx.database, 'getAllApiKeys').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/admin/api-keys').set(ADMIN)).status).toBe(500);
    vi.spyOn(ctx.database, 'getApiKey').mockRejectedValueOnce(new Error('x'));
    expect((await r.patch('/admin/api-keys/k').set(ADMIN).send({ active: true })).status).toBe(500);
  });
});

describe('/admin/users', () => {
  beforeAll(async () => {
    const t0 = Date.now();
    await makeUser(ctx.database, 'carol', { lastActivity: new Date(t0 - 3000) });
    await makeUser(ctx.database, 'caroline', { lastActivity: new Date(t0 - 2000) });
    await makeUser(ctx.database, 'dave', { lastActivity: new Date(t0 - 1000) });
  });

  it('lists users by recent activity with limit/skip', async () => {
    const r = await api();
    const all = await r.get('/admin/users').set(ADMIN);
    expect(all.status).toBe(200);
    const names = all.body.users.map((u: any) => u.username);
    expect(names.indexOf('dave')).toBeLessThan(names.indexOf('caroline'));
    expect(names.indexOf('caroline')).toBeLessThan(names.indexOf('carol'));

    const page = await r.get('/admin/users?search=caro&limit=1&skip=1').set(ADMIN);
    expect(page.body.users.map((u: any) => u.username)).toEqual(['carol']);
  });

  it('search is case-insensitive', async () => {
    const res = await (await api()).get('/admin/users?search=CAROL').set(ADMIN);
    expect(res.body.users.map((u: any) => u.username).sort()).toEqual(['carol', 'caroline']);
  });

  it('bans and unbans a user', async () => {
    const r = await api();
    const res = await r.patch('/admin/users/dave/ban').set(ADMIN).send({ banned: true });
    expect(res.body).toEqual({ success: true, username: 'dave', banned: true });
    expect((await ctx.database.getUser('dave'))!.banned).toBe(true);
    await r.patch('/admin/users/dave/ban').set(ADMIN).send({ banned: false });
    expect((await ctx.database.getUser('dave'))!.banned).toBe(false);
  });

  it('ban validates the body and 404s unknown users', async () => {
    const r = await api();
    expect((await r.patch('/admin/users/dave/ban').set(ADMIN).send({ banned: 1 })).status).toBe(400);
    expect((await r.patch('/admin/users/ghost/ban').set(ADMIN).send({ banned: true })).status).toBe(404);
  });

  it('grants and removes premium, visible through isUserPremium and the public lookup', async () => {
    const r = await api();
    const key = await makeApiKey(ctx.database);
    const res = await r.patch('/admin/users/carol/premium').set(ADMIN).send({ premium: true });
    expect(res.body).toEqual({ success: true, username: 'carol', premium: true });
    expect(await ctx.database.isUserPremium('carol')).toBe(true);
    const lookup = await r.get('/users/carol/premium').set('X-API-Key', key);
    expect(lookup.body.premium).toBe(true);

    await r.patch('/admin/users/carol/premium').set(ADMIN).send({ premium: false });
    expect(await ctx.database.isUserPremium('carol')).toBe(false);
  });

  it('premium validates the body and 404s unknown users', async () => {
    const r = await api();
    expect((await r.patch('/admin/users/carol/premium').set(ADMIN).send({ premium: 'yes' })).status).toBe(400);
    expect((await r.patch('/admin/users/ghost/premium').set(ADMIN).send({ premium: true })).status).toBe(404);
  });

  it('500s when the database fails', async () => {
    quiet();
    const r = await api();
    vi.spyOn(ctx.database, 'getAllUsers').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/admin/users').set(ADMIN)).status).toBe(500);
    vi.spyOn(ctx.database, 'banUser').mockRejectedValueOnce(new Error('x'));
    expect((await r.patch('/admin/users/carol/ban').set(ADMIN).send({ banned: true })).status).toBe(500);
    vi.spyOn(ctx.database, 'setUserPremium').mockRejectedValueOnce(new Error('x'));
    expect((await r.patch('/admin/users/carol/premium').set(ADMIN).send({ premium: true })).status).toBe(500);
  });
});

describe('/admin/cleanup', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const dir = () => ctx.config.uploadDir as string;
  const put = (name: string, size: number, ageDays: number) => {
    const p = path.join(dir(), name);
    writeFileSync(p, Buffer.alloc(size));
    const t = new Date(Date.now() - ageDays * DAY);
    utimesSync(p, t, t);
    return p;
  };

  it('previews, then deletes, only files past the retention window', async () => {
    for (const f of readdirSync(dir())) rmSync(path.join(dir(), f), { recursive: true, force: true });
    const old = put('stale-upload', 3 * 1024 * 1024, 9);
    const fresh = put('fresh-upload', 1024, 1);
    mkdirSync(path.join(dir(), 'adir'), { recursive: true });

    const r = await api();
    const preview = await r.get('/admin/cleanup/preview').set(ADMIN);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ filesCount: 1, totalSizeMB: '3.00', retentionDays: 7 });
    expect(preview.body.files).toEqual([{ name: 'stale-upload', sizeMB: '3.00', ageDays: '9.0' }]);
    expect(existsSync(old)).toBe(true);

    const run = await r.post('/admin/cleanup/run').set(ADMIN);
    expect(run.body).toEqual({
      success: true, filesScanned: 3, filesDeleted: 1, bytesFreed: 3 * 1024 * 1024, mbFreed: '3.00', errors: [],
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);

    const after = await r.get('/admin/cleanup/preview').set(ADMIN);
    expect(after.body.filesCount).toBe(0);
  });

  it('500s if the cleanup service throws', async () => {
    quiet();
    const { CleanupService } = await import('../../src/utils/cleanup');
    const r = await api();
    vi.spyOn(CleanupService.prototype, 'previewCleanup').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/admin/cleanup/preview').set(ADMIN)).status).toBe(500);
    vi.spyOn(CleanupService.prototype, 'runCleanup').mockRejectedValueOnce(new Error('x'));
    expect((await r.post('/admin/cleanup/run').set(ADMIN)).status).toBe(500);
  });
});

describe('/admin/encoders', () => {
  const base = { url: 'https://enc.example', apiKey: 'enc-secret' };

  it('creates a managed encoder with defaults and never returns its apiKey', async () => {
    const r = await api();
    const res = await r.post('/admin/encoders').set(ADMIN).send({ name: 'm1', ...base });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, name: 'm1', url: base.url, enabled: true, access: 'managed', tier: 'standard', trusted: false });

    const stored = await ctx.database.getEncoder('m1');
    expect(stored).toMatchObject({ apiKey: 'enc-secret', trusted: false });
    expect(stored).not.toHaveProperty('maxFileSize');

    const list = await r.get('/admin/encoders').set(ADMIN);
    const row = list.body.encoders.find((e: any) => e.name === 'm1');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('apiKey');
    expect(JSON.stringify(list.body)).not.toContain('enc-secret');
  });

  it('stores explicit fields including maxFileSize and trusted', async () => {
    const res = await (await api()).post('/admin/encoders').set(ADMIN).send({
      name: 'gpu1', ...base, tier: 'performance', enabled: false, maxFileSize: 1e9, trusted: true,
    });
    expect(res.body).toMatchObject({ tier: 'performance', enabled: false, trusted: true });
    expect(await ctx.database.getEncoder('gpu1')).toMatchObject({ maxFileSize: 1e9, trusted: true, enabled: false });
    const nullCap = await (await api()).post('/admin/encoders').set(ADMIN).send({ name: 'nullcap', ...base, maxFileSize: null });
    expect(nullCap.status).toBe(200);
    expect((await ctx.database.getEncoder('nullcap'))!.maxFileSize).toBeNull();
  });

  it.each([
    ['missing name', { ...base }, /required/],
    ['missing url', { name: 'x', apiKey: 'k' }, /required/],
    ['missing apiKey', { name: 'x', url: 'https://x' }, /required/],
    ['bad url', { name: 'x', url: 'not a url', apiKey: 'k' }, /Invalid URL/],
    ['bad access', { name: 'x', ...base, access: 'public' }, /access must be/],
    ['bad tier', { name: 'x', ...base, tier: 'turbo' }, /tier must be/],
    ['non-boolean enabled', { name: 'x', ...base, enabled: 'yes' }, /enabled must be/],
    ['zero maxFileSize', { name: 'x', ...base, maxFileSize: 0 }, /maxFileSize/],
    ['string maxFileSize', { name: 'x', ...base, maxFileSize: '10' }, /maxFileSize/],
    ['non-boolean trusted', { name: 'x', ...base, trusted: 'true' }, /trusted must be/],
    ['trusted community', { name: 'x', ...base, access: 'community', trusted: true }, /community encoder cannot be trusted/],
  ])('POST rejects %s', async (_l, body, msg) => {
    const res = await (await api()).post('/admin/encoders').set(ADMIN).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
    expect(await ctx.database.getEncoder('x')).toBeNull();
  });

  it('POST 409s on a duplicate name', async () => {
    const r = await api();
    await r.post('/admin/encoders').set(ADMIN).send({ name: 'dup', ...base });
    const res = await r.post('/admin/encoders').set(ADMIN).send({ name: 'dup', ...base, url: 'https://other' });
    expect(res.status).toBe(409);
    expect((await ctx.database.getEncoder('dup'))!.url).toBe(base.url);
  });

  it('PATCH updates every editable field', async () => {
    const r = await api();
    await r.post('/admin/encoders').set(ADMIN).send({ name: 'p1', ...base });
    const res = await r.patch('/admin/encoders/p1').set(ADMIN).send({
      url: 'https://new.example', apiKey: 'k2', enabled: false, access: 'managed', tier: 'lite',
      maxFileSize: 500, banned: true, trusted: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.updates).toMatchObject({ url: 'https://new.example', tier: 'lite', banned: true, trusted: true });
    expect(await ctx.database.getEncoder('p1')).toMatchObject({
      url: 'https://new.example', apiKey: 'k2', enabled: false, tier: 'lite', maxFileSize: 500, banned: true, trusted: true,
    });

    // null clears the size cap; trusted can be revoked.
    await r.patch('/admin/encoders/p1').set(ADMIN).send({ maxFileSize: null, trusted: false });
    expect(await ctx.database.getEncoder('p1')).toMatchObject({ maxFileSize: null, trusted: false });
  });

  it.each([
    ['bad url', { url: 'nope' }, /Invalid URL/],
    ['non-boolean enabled', { enabled: 1 }, /enabled must be/],
    ['bad access', { access: 'x' }, /access must be/],
    ['bad tier', { tier: 'x' }, /tier must be/],
    ['non-boolean trusted', { trusted: 'yes' }, /trusted must be/],
    ['negative maxFileSize', { maxFileSize: -5 }, /maxFileSize/],
    ['infinite maxFileSize', { maxFileSize: 'Infinity' }, /maxFileSize/],
    ['non-boolean banned', { banned: 'no' }, /banned must be/],
    ['empty body', {}, /No valid fields/],
    ['only unknown fields', { name: 'renamed', did: 'did:key:z' }, /No valid fields/],
  ])('PATCH rejects %s without writing', async (_l, body, msg) => {
    const r = await api();
    if (!(await ctx.database.getEncoder('v1'))) await r.post('/admin/encoders').set(ADMIN).send({ name: 'v1', ...base });
    const before = await ctx.database.getEncoder('v1');
    const res = await r.patch('/admin/encoders/v1').set(ADMIN).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
    expect((await ctx.database.getEncoder('v1'))!.updatedAt).toEqual(before!.updatedAt);
  });

  it('PATCH refuses to trust a community encoder (stored or requested access)', async () => {
    const r = await api();
    await r.post('/admin/encoders').set(ADMIN).send({ name: 'c1', ...base, access: 'community' });
    const a = await r.patch('/admin/encoders/c1').set(ADMIN).send({ trusted: true });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/community encoder cannot be trusted/);

    await r.post('/admin/encoders').set(ADMIN).send({ name: 'm2', ...base });
    const b = await r.patch('/admin/encoders/m2').set(ADMIN).send({ access: 'community', trusted: true });
    expect(b.status).toBe(400);
    expect((await ctx.database.getEncoder('m2'))!.trusted).toBe(false);

    // Moving a community encoder to managed while trusting it is allowed.
    const c = await r.patch('/admin/encoders/c1').set(ADMIN).send({ access: 'managed', trusted: true });
    expect(c.status).toBe(200);
    // A legacy row without `access` counts as managed.
    await ctx.database.createEncoder({ name: 'legacy', url: 'https://l', apiKey: 'k', enabled: true } as any);
    expect((await r.patch('/admin/encoders/legacy').set(ADMIN).send({ trusted: true })).status).toBe(200);
  });

  it('PATCH and DELETE 404 unknown encoders', async () => {
    const r = await api();
    expect((await r.patch('/admin/encoders/ghost').set(ADMIN).send({ enabled: true })).status).toBe(404);
    expect((await r.delete('/admin/encoders/ghost').set(ADMIN)).status).toBe(404);
  });

  it('DELETE removes the encoder', async () => {
    const r = await api();
    await r.post('/admin/encoders').set(ADMIN).send({ name: 'gone', ...base });
    const res = await r.delete('/admin/encoders/gone').set(ADMIN);
    expect(res.body).toEqual({ success: true, name: 'gone' });
    expect(await ctx.database.getEncoder('gone')).toBeNull();
  });

  it('500s when the database fails', async () => {
    quiet();
    const r = await api();
    vi.spyOn(ctx.database, 'getAllEncoders').mockRejectedValueOnce(new Error('x'));
    expect((await r.get('/admin/encoders').set(ADMIN)).status).toBe(500);
    vi.spyOn(ctx.database, 'getEncoder').mockRejectedValueOnce(new Error('x'));
    expect((await r.post('/admin/encoders').set(ADMIN).send({ name: 'z', ...base })).status).toBe(500);
    vi.spyOn(ctx.database, 'getEncoder').mockRejectedValueOnce(new Error('x'));
    expect((await r.patch('/admin/encoders/z').set(ADMIN).send({ enabled: true })).status).toBe(500);
    vi.spyOn(ctx.database, 'getEncoder').mockRejectedValueOnce(new Error('x'));
    expect((await r.delete('/admin/encoders/z').set(ADMIN)).status).toBe(500);
  });
});

describe('GET /admin/encoder-stats', () => {
  it('400s on an unknown period', async () => {
    const res = await (await api()).get('/admin/encoder-stats?period=1y').set(ADMIN);
    expect(res.status).toBe(400);
  });

  it('aggregates finished jobs per encoder within the period', async () => {
    const now = Date.now();
    const H = 60 * 60 * 1000;
    // Only the jobs created here should count.
    await (ctx.database as any).db.collection('embed-jobs').deleteMany({});
    await ctx.database.createEncoder({ name: 'stat-gpu', url: 'https://g', apiKey: 'k', enabled: true, tier: 'performance', access: 'managed', createdAt: new Date(), updatedAt: new Date() } as any);
    const mk = (fields: Record<string, unknown>) => makeJob(ctx.database, { owner: 'stats', ...fields });
    // stat-gpu: 2 completed (60s and 120s), 1 failed
    await mk({ status: 'completed', assignedWorker: 'stat-gpu', assignedAt: new Date(now - 200_000), webhookReceivedAt: new Date(now - 140_000), updatedAt: new Date(now - H) });
    await mk({ status: 'completed', assignedWorker: 'stat-gpu', assignedAt: new Date(now - 300_000), webhookReceivedAt: new Date(now - 180_000), updatedAt: new Date(now - H) });
    await mk({ status: 'failed', assignedWorker: 'stat-gpu', updatedAt: new Date(now - H) });
    // Unknown worker (not in embed-encoders) and a job with no worker.
    await mk({ status: 'completed', assignedWorker: 'retired', updatedAt: new Date(now - H) });
    await mk({ status: 'failed', assignedWorker: null, updatedAt: new Date(now - H) });
    // Outside 24h but inside 7d; and statuses that never count.
    await mk({ status: 'completed', assignedWorker: 'stat-gpu', updatedAt: new Date(now - 3 * 24 * H) });
    await mk({ status: 'pending', assignedWorker: 'stat-gpu', updatedAt: new Date(now - H) });
    await mk({ status: 'encoding', assignedWorker: 'stat-gpu', updatedAt: new Date(now - H) });

    const r = await api();
    const day = await r.get('/admin/encoder-stats').set(ADMIN);
    expect(day.status).toBe(200);
    expect(day.body.period).toBe('24h');
    expect(new Date(day.body.since).getTime()).toBeGreaterThan(now - 24 * H - 60_000);

    const statsJobs = day.body.encoders;
    const gpu = statsJobs.find((e: any) => e.encoderName === 'stat-gpu');
    expect(gpu).toEqual({
      encoderName: 'stat-gpu', tier: 'performance', access: 'managed',
      totalJobs: 3, completedJobs: 2, failedJobs: 1, successRate: 66.7, avgEncodeTimeMs: 90_000,
    });
    expect(statsJobs.find((e: any) => e.encoderName === 'retired')).toMatchObject({
      tier: 'standard', access: 'managed', totalJobs: 1, completedJobs: 1, successRate: 100, avgEncodeTimeMs: 0,
    });
    expect(statsJobs.find((e: any) => e.encoderName === 'unknown')).toMatchObject({ failedJobs: 1, successRate: 0 });

    expect(day.body.encoders).toHaveLength(3);
    expect(day.body.aggregate).toEqual({
      totalJobs: 5, completedJobs: 3, failedJobs: 2, successRate: 60, avgEncodeTimeMs: 90_000,
      jobsPerHour: Math.round((5 / 24) * 10) / 10,
    });

    const week = await r.get('/admin/encoder-stats?period=7d').set(ADMIN);
    expect(week.body.encoders.find((e: any) => e.encoderName === 'stat-gpu').totalJobs).toBe(4);
    const month = await r.get('/admin/encoder-stats?period=30d').set(ADMIN);
    expect(month.body.aggregate).toMatchObject({ totalJobs: 6, completedJobs: 4, jobsPerHour: Math.round((6 / 720) * 10) / 10 });
  });

  it('reports zeros with no finished jobs in the window', async () => {
    vi.spyOn(ctx.database, 'getCompletedJobStats').mockResolvedValueOnce([]);
    const res = await (await api()).get('/admin/encoder-stats?period=24h').set(ADMIN);
    expect(res.body.aggregate).toEqual({ totalJobs: 0, completedJobs: 0, failedJobs: 0, successRate: 0, avgEncodeTimeMs: 0, jobsPerHour: 0 });
    expect(res.body.encoders).toEqual([]);
  });

  it('500s when the database fails', async () => {
    quiet();
    vi.spyOn(ctx.database, 'getCompletedJobStats').mockRejectedValueOnce(new Error('x'));
    expect((await (await api()).get('/admin/encoder-stats').set(ADMIN)).status).toBe(500);
  });
});

it('never touched the network', () => {
  expect(fetchMock).not.toHaveBeenCalled();
});
