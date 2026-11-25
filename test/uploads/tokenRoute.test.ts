import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFetchStub, owner, rawDb, seedVideo } from './helpers';
import { api, loadApp, makeApiKey } from '../helpers/app';
import { verifyUploadToken } from '../../src/utils/uploadToken';
import type { Database } from '../../src/database/mongodb';

// POST /uploads/token and GET /uploads/quota.

process.env.GATE_URL = 'http://gate.test';
process.env.GATE_INTERNAL_API_KEY = 'gate-key';
process.env.UPLOAD_LIMIT_EXEMPT = 'vipowner';
process.env.UPLOAD_TOKEN_MAX_TTL = '1800';
process.env.UPLOAD_TOKEN_MAX_FILE_SIZE = String(500 * 1024 * 1024);
// `gradkid` got its Hive account two hours ago (same name as its warm-up handle).
const hiveTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
installFetchStub({ incubating: ['warmupkid', 'warmupfull'], hiveCreated: { gradkid: hiveTime(Date.now() - 2 * 3600 * 1000) } });

let database: Database;
let config: any;
let key: string;

beforeAll(async () => {
  ({ database, config } = await loadApp());
  key = await makeApiKey(database, { app_name: 'key-app' });
});

const token = async (body: Record<string, unknown>, k: string | null = key) => {
  const r = (await api()).post('/uploads/token');
  if (k) r.set('X-API-Key', k);
  return r.send(body);
};
const claimsOf = (t: string) => verifyUploadToken(t, config.uploadTokenSecret)!;
const makePro = async (who: string) => {
  await rawDb(database).collection('embed-users').insertOne({ username: who, premium: true, banned: false });
};

describe('POST /uploads/token', () => {
  it('requires an active API key', async () => {
    expect((await token({ owner: 'a' }, null)).status).toBe(401);
    expect((await token({ owner: 'a' }, 'sk_unknown')).status).toBe(401);
    const revoked = await makeApiKey(database, { active: false });
    expect((await token({ owner: 'a' }, revoked)).status).toBe(403);
  });

  it('answers 503 when upload tokens are not configured', async () => {
    const saved = config.uploadTokenSecret;
    config.uploadTokenSecret = '';
    try {
      const res = await token({ owner: 'a' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Upload tokens are not configured');
    } finally {
      config.uploadTokenSecret = saved;
    }
  });

  it('requires a string owner', async () => {
    expect((await token({})).status).toBe(422);
    expect((await token({ owner: 42 })).body).toEqual({ error: 'owner (string) is required' });
  });

  it('lowercases the owner and refuses one that is only spaces or an @', async () => {
    const who = owner();
    const res = await (await api()).post('/uploads/token').set('X-API-Key', key).send({ owner: ` @${who.toUpperCase()}` });
    expect(res.status).toBe(201);
    expect(claimsOf(res.body.token).owner).toBe(who);
    expect(res.body.embed_url).toBe(`${config.baseUrl}?v=${who}/${res.body.permlink}`);
    expect((await token({ owner: ' @ ' })).status).toBe(422);
  });

  it('issues a signed token bound to a fresh permlink', async () => {
    const who = owner();
    const before = Math.floor(Date.now() / 1000);
    const res = await (await api()).post('/uploads/token').set('X-API-Key', key).set('Host', 'up.test').send({ owner: who });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true, upload_url: 'http://up.test/uploads', gated: false, defer_encode: false, replaces: null,
    });
    expect(res.body.finalize_token).toBeUndefined();
    expect(res.body.embed_url).toBe(`${config.baseUrl}?v=${who}/${res.body.permlink}`);
    const c = claimsOf(res.body.token);
    expect(c).toMatchObject({
      owner: who, app: 'key-app', issuedByKey: 'key-app', short: false, gated: false,
      maxFileSize: 500 * 1024 * 1024, allowedOrigins: [], permlink: res.body.permlink,
    });
    expect(c.deferEncode).toBeUndefined();
    expect(c.replaces).toBeUndefined();
    expect(c.exp - c.iat).toBe(config.uploadTokenDefaultTtl);
    expect(c.iat).toBeGreaterThanOrEqual(before);
    expect(new Date(res.body.expires_at).getTime()).toBe(c.exp * 1000);
  });

  it('honours frontend_app, short, origins, and clamps ttl and file size', async () => {
    const res = await token({
      owner: owner(), frontend_app: 'my-front', short: true, allowed_origins: ['https://a.test'],
      ttl: 99999, max_file_size: 10 * 1024 * 1024 * 1024,
    });
    expect(res.status).toBe(201);
    const c = claimsOf(res.body.token);
    expect(c).toMatchObject({ app: 'my-front', short: true, allowedOrigins: ['https://a.test'], maxFileSize: 500 * 1024 * 1024 });
    expect(c.exp - c.iat).toBe(1800);

    const small = claimsOf((await token({ owner: owner(), ttl: 60, max_file_size: 1234, allowed_origins: 'nope' })).body.token);
    expect(small.exp - small.iat).toBe(60);
    expect(small.maxFileSize).toBe(1234);
    expect(small.allowedOrigins).toEqual([]);

    const ignored = claimsOf((await token({ owner: owner(), ttl: -5, max_file_size: 'big' })).body.token);
    expect(ignored.exp - ignored.iat).toBe(config.uploadTokenDefaultTtl);
    expect(ignored.maxFileSize).toBe(500 * 1024 * 1024);
  });

  it('defer_encode adds a 12h finalize token with no upload allowance', async () => {
    const res = await token({ owner: owner(), defer_encode: true });
    expect(res.status).toBe(201);
    expect(res.body.defer_encode).toBe(true);
    expect(claimsOf(res.body.token).deferEncode).toBe(true);
    const fin = claimsOf(res.body.finalize_token);
    expect(fin).toMatchObject({ scope: 'finalize', maxFileSize: 0, gated: false, allowlist: [], permlink: res.body.permlink });
    expect(fin.exp - fin.iat).toBe(12 * 60 * 60);
    expect(fin.jti).not.toBe(claimsOf(res.body.token).jti);
  });

  describe('gated', () => {
    it('validates the flag and the guest list', async () => {
      expect((await token({ owner: 'x', gated: 'yes' })).body).toEqual({ error: 'gated must be a boolean' });
      expect((await token({ owner: 'x', gated: true, allowlist: 'bob' })).status).toBe(422);
      expect((await token({ owner: 'x', gated: true, allowlist: Array(501).fill('bob') })).status).toBe(422);
      const bad = await token({ owner: 'x', gated: true, allowlist: ['good-name', 'NO!'] });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toBe('"NO!" is not a valid Hive account name');
      expect((await token({ owner: 'x', gated: true, allowlist: [7] })).status).toBe(422);
    });

    it('refuses when the gate is not configured', async () => {
      const saved = config.gateUrl;
      config.gateUrl = '';
      try {
        const res = await token({ owner: 'x', gated: true });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('gate_not_configured');
      } finally {
        config.gateUrl = saved;
      }
    });

    it('requires 3Speak Pro', async () => {
      const res = await token({ owner: owner(), gated: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('pro_required');
    });

    it('signs gated + a normalised, de-duplicated guest list for Pro owners', async () => {
      const who = owner('pro');
      await makePro(who);
      const res = await token({ owner: who, gated: true, allowlist: ['@Bob', 'bob ', 'carol.x'] });
      expect(res.status).toBe(201);
      expect(res.body.gated).toBe(true);
      expect(claimsOf(res.body.token)).toMatchObject({ gated: true, allowlist: ['bob', 'carol.x'] });
      // An empty guest list is not signed at all.
      const none = await token({ owner: who, gated: true, allowlist: [] });
      expect(claimsOf(none.body.token).allowlist).toBeUndefined();
    });

    it('answers 500 when the Pro lookup fails', async () => {
      const spy = vi.spyOn(database, 'isUserPremium').mockRejectedValueOnce(new Error('mongo down'));
      const res = await token({ owner: owner(), gated: true });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      spy.mockRestore();
    });
  });

  describe('daily upload limit', () => {
    it('never caps a free Hive account by default', async () => {
      const who = owner();
      for (let i = 0; i < 4; i++) await seedVideo(database, who);
      for (let i = 0; i < 4; i++) await seedVideo(database, who, { short: true });
      expect((await token({ owner: who })).status).toBe(201);
      expect((await token({ owner: who, short: true })).status).toBe(201);
    });

    it('holds warm-up owners to 3 videos and 3 shorts a day', async () => {
      await seedVideo(database, 'warmupkid');
      await seedVideo(database, 'warmupkid');
      expect((await token({ owner: 'warmupkid' })).status).toBe(201);
      for (let i = 0; i < 3; i++) await seedVideo(database, 'warmupfull');
      const res = await token({ owner: 'warmupfull' });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'daily_upload_limit', plan: 'warmup', kind: 'video', limit: 3, used: 3 });
      expect(res.body.message).not.toContain('Pro');
      expect((await token({ owner: 'warmupfull', short: true })).status).toBe(201);
      for (let i = 0; i < 3; i++) await seedVideo(database, 'warmupfull', { short: true });
      expect((await token({ owner: 'warmupfull', short: true })).body).toMatchObject({ plan: 'warmup', kind: 'short', limit: 3 });
    });

    describe('with free uploads capped (UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true)', () => {
      beforeAll(() => { config.uploadLimits.freeUploadsCapped = true; });
      afterAll(() => { config.uploadLimits.freeUploadsCapped = false; });

      it('refuses a free owner at the limit with 429 and Retry-After', async () => {
        const who = owner();
        await seedVideo(database, who, { agoMs: 2 * 60 * 60 * 1000 });
        const res = await token({ owner: who });
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({ code: 'daily_upload_limit', kind: 'video', limit: 1, used: 1, error: 'Daily video upload limit reached' });
        expect(Number(res.headers['retry-after'])).toBe(res.body.retry_after_seconds);
        expect(res.body.retry_after_seconds).toBeGreaterThan(21 * 3600);
        expect(res.body.upgrade_url).toBe(`https://3speak.tv/wallet/${who}#pro`);
        // A short still has its own allowance.
        expect((await token({ owner: who, short: true })).status).toBe(201);
      });

      it('counts shorts separately (3 per day)', async () => {
        const who = owner();
        for (let i = 0; i < 3; i++) await seedVideo(database, who, { short: true });
        const res = await token({ owner: who, short: true });
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({ kind: 'short', limit: 3, used: 3 });
        expect((await token({ owner: who })).status).toBe(201);
      });

      it('exempts Pro and listed owners', async () => {
        const pro = owner('pro');
        await makePro(pro);
        await seedVideo(database, pro);
        expect((await token({ owner: pro })).status).toBe(201);
        await seedVideo(database, 'vipowner');
        expect((await token({ owner: 'vipowner' })).status).toBe(201);
      });

      it('does not count the warm-up backlog against the new Hive account', async () => {
        // Uploaded while still a warm-up: under the same name before the account existed...
        for (let i = 0; i < 3; i++) await seedVideo(database, 'gradkid', { agoMs: (5 + i) * 3600 * 1000 });
        // ...and claimed from another handle by the checker at graduation.
        const moved = owner('moved');
        for (let i = 0; i < 3; i++) await seedVideo(database, moved, { owner_claimed_from: 'oldhandle' });
        expect((await token({ owner: 'gradkid' })).status).toBe(201);
        expect((await token({ owner: moved })).status).toBe(201);
        // Their own uploads since then count as usual.
        await seedVideo(database, 'gradkid');
        expect((await token({ owner: 'gradkid' })).body).toMatchObject({ plan: 'free', limit: 1, used: 1 });
      });

      it('lets a verified replacement through and signs the target', async () => {
        const who = owner();
        const target = await seedVideo(database, who);
        const res = await token({ owner: who, replaces: ` ${target} ` });
        expect(res.status).toBe(201);
        expect(res.body.replaces).toBe(target);
        expect(claimsOf(res.body.token).replaces).toBe(target);
      });

      it('does not let someone else\'s video skip the limit', async () => {
        const who = owner();
        const theirs = await seedVideo(database, owner('other'));
        await seedVideo(database, who);
        const res = await token({ owner: who, replaces: theirs });
        expect(res.status).toBe(429);
        // Not at the limit: issued, but without a replacement claim.
        const fresh = owner();
        const ok = await token({ owner: fresh, replaces: theirs });
        expect(ok.status).toBe(201);
        expect(ok.body.replaces).toBeNull();
        expect(claimsOf(ok.body.token).replaces).toBeUndefined();
      });

      it('fails open on a target lookup error, without signing the claim', async () => {
        const who = owner();
        await seedVideo(database, who);
        const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('blip'));
        const res = await token({ owner: who, replaces: 'anything' });
        spy.mockRestore();
        expect(res.status).toBe(201);
        expect(res.body.replaces).toBeNull();
        expect(claimsOf(res.body.token).replaces).toBeUndefined();
      });
    });
  });
});

describe('GET /uploads/quota', () => {
  const quota = async (q: string, k: string | null = key) => {
    const r = (await api()).get(`/uploads/quota${q}`);
    return k ? r.set('X-API-Key', k) : r;
  };

  it('requires an API key and an owner', async () => {
    expect((await quota('?owner=a', null)).status).toBe(401);
    expect((await quota('')).status).toBe(422);
    expect((await quota('?owner=%20%20')).body).toEqual({ error: 'owner (string) is required' });
  });

  it('reports a free Hive account exempt (publish_limit) by default', async () => {
    const who = owner();
    await seedVideo(database, who, { agoMs: 60 * 60 * 1000 });
    await seedVideo(database, who, { short: true });
    const res = await quota(`?owner=${who}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      enabled: true, exempt: true, reason: 'publish_limit', plan: null,
      video: { limit: null, used: 1, remaining: null, next_at: null },
      short: { limit: null, used: 1, remaining: null, next_at: null },
    });
  });

  it('reports a free owner\'s allowance while free uploads are capped', async () => {
    const who = owner();
    await seedVideo(database, who, { agoMs: 60 * 60 * 1000 });
    await seedVideo(database, who, { short: true });
    config.uploadLimits.freeUploadsCapped = true;
    try {
      const res = await quota(`?owner=${who}`);
      expect(res.body).toMatchObject({
        enabled: true, exempt: false, reason: null, plan: 'free',
        video: { limit: 1, used: 1, remaining: 0 },
        short: { limit: 3, used: 1, remaining: 2, next_at: null },
      });
      expect(Date.parse(res.body.video.next_at)).toBeGreaterThan(Date.now() + 22 * 3600 * 1000);
    } finally {
      config.uploadLimits.freeUploadsCapped = false;
    }
  });

  it('reports exemptions', async () => {
    const pro = owner('pro');
    await makePro(pro);
    expect((await quota(`?owner=${pro}`)).body).toMatchObject({ exempt: true, reason: 'pro', video: { limit: null } });
    expect((await quota('?owner=vipowner')).body.reason).toBe('listed');
  });

  it('reports a warm-up owner\'s own allowance', async () => {
    expect((await quota('?owner=warmupkid')).body).toMatchObject({
      exempt: false, reason: null, plan: 'warmup', video: { limit: 3 }, short: { limit: 3 },
    });
  });

  it('reports unlimited when limits are switched off', async () => {
    config.uploadLimits.enabled = false;
    try {
      const res = await quota(`?owner=${owner()}`);
      expect(res.body).toMatchObject({ enabled: false, exempt: true, video: { limit: null }, short: { limit: null } });
      // ...and the token route stops refusing.
      const who = owner();
      await seedVideo(database, who);
      expect((await token({ owner: who })).status).toBe(201);
    } finally {
      config.uploadLimits.enabled = true;
    }
  });

  it('answers 503 when the count cannot be read', async () => {
    const spy = vi.spyOn(database, 'getRecentCountedUploads').mockRejectedValueOnce(new Error('down'));
    const res = await quota(`?owner=${owner()}`);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Upload quota is unavailable right now');
  });
});
