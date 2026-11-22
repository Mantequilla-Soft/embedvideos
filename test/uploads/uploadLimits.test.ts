import { describe, it, expect, vi } from 'vitest';
import {
  UploadLimiter, LimiterDeps, DAY_MS, REPLACEMENT_REGISTER_GRACE_MS, LIMIT_ERROR_CODE, STREAM_VOD_APP,
  isoSeconds, verifyReplacementTarget, createWarmupLookup, createHiveAccountLookup, getUploadLimiter,
} from '../../src/utils/uploadLimits';
import type { UploadLimitsConfig } from '../../src/config/config';
import type { CountedUploadRow } from '../../src/database/mongodb';

// Pure unit tests: no MongoDB, no network. The limiter takes its lookups as
// dependencies, so every branch can be driven with plain functions.

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function cfg(over: Partial<UploadLimitsConfig> = {}): UploadLimitsConfig {
  return {
    enabled: true, videosPerDay: 1, shortsPerDay: 3, warmupVideosPerDay: 3, warmupShortsPerDay: 3, exempt: [],
    warmupLookupUrl: 'http://checker.test/incubation/authors',
    hiveApiNodes: ['http://hive-a.test', 'http://hive-b.test'],
    upgradeUrl: '', ...over,
  };
}

function row(over: Partial<CountedUploadRow> & { ago: number }): CountedUploadRow {
  const { ago, ...rest } = over;
  return { permlink: `p${Math.random().toString(36).slice(2, 8)}`, short: false, frontend_app: '3speak-tv', createdAt: new Date(NOW - ago), ...rest };
}

function limiter(rows: CountedUploadRow[], depsOver: Partial<LimiterDeps> = {}, c: UploadLimitsConfig | null = cfg()) {
  const deps: LimiterDeps = {
    getRecentCountedUploads: vi.fn(async () => rows),
    isUserPremium: vi.fn(async () => false),
    streamRecordExists: vi.fn(async () => false),
    isWarmup: vi.fn(async () => false),
    now: () => NOW,
    ...depsOver,
  };
  return { l: new UploadLimiter(c ?? undefined, deps), deps };
}

describe('UploadLimiter.check', () => {
  it('allows everything when disabled or unconfigured', async () => {
    const rows = [row({ ago: HOUR })];
    expect(await limiter(rows, {}, cfg({ enabled: false })).l.check('alice', 'video')).toBeNull();
    const { l, deps } = limiter(rows, {}, null);
    expect(l.enabled).toBe(false);
    expect(await l.check('alice', 'video')).toBeNull();
    expect(deps.getRecentCountedUploads).not.toHaveBeenCalled();
  });

  it('allows an owner under the limit without the Pro or warm-up lookups', async () => {
    const { l, deps } = limiter([row({ ago: HOUR, short: true })]);
    expect(await l.check('alice', 'video')).toBeNull();
    expect(await l.check('alice', 'short')).toBeNull();
    expect(deps.isUserPremium).not.toHaveBeenCalled();
    expect(deps.isWarmup).not.toHaveBeenCalled();
    expect(deps.getRecentCountedUploads).toHaveBeenCalledWith('alice', new Date(NOW - DAY_MS));
  });

  it('refuses an owner at the limit with the documented 429 body', async () => {
    const first = row({ ago: 3 * HOUR });
    const { l } = limiter([first]);
    const r = await l.check('alice', 'video');
    expect(r).not.toBeNull();
    expect(r!.status).toBe(429);
    const next = NOW - 3 * HOUR + DAY_MS;
    expect(r!.body).toMatchObject({
      error: 'Daily video upload limit reached', code: LIMIT_ERROR_CODE, kind: 'video', plan: 'free', limit: 1, used: 1,
      next_at: isoSeconds(next), retry_after_seconds: 21 * 3600,
      upgrade_url: 'https://3speak.tv/wallet/alice#pro',
    });
    expect(r!.body.message).toContain('1 video per 24 hours');
    expect(r!.headers).toEqual({ 'Retry-After': String(21 * 3600) });
  });

  it('computes the next slot from the oldest upload still holding a slot', async () => {
    const times = [20, 10, 2].map((h) => row({ ago: h * HOUR, short: true }));
    const { l } = limiter(times, {}, cfg({ shortsPerDay: 2 }));
    const r = await l.check('bob', 'short');
    expect(r!.body.used).toBe(3);
    // Sorted [t-20h, t-10h, t-2h], limit 2: the slot frees when t-10h leaves the window.
    expect(r!.body.next_at).toBe(isoSeconds(NOW - 10 * HOUR + DAY_MS));
    expect(r!.body.message).toContain('2 shorts per 24 hours');
  });

  it('with a limit of 0 refuses without a next slot time', async () => {
    const { l } = limiter([], {}, cfg({ videosPerDay: 0 }));
    const r = await l.check('carol', 'video');
    expect(r!.body.next_at).toBeNull();
    expect(r!.body.retry_after_seconds).toBeNull();
    expect(r!.headers).toEqual({});
    expect(r!.body.message).toBe('Free accounts cannot upload videos at the moment. 3Speak Pro removes this limit.');
  });

  it('exempts listed owners (case and @ insensitive) and Pro owners', async () => {
    const rows = [row({ ago: HOUR })];
    expect(await limiter(rows, {}, cfg({ exempt: ['dave'] })).l.check('@Dave ', 'video')).toBeNull();
    expect(await limiter(rows, { isUserPremium: async () => true }).l.check('erin', 'video')).toBeNull();
    // Warm-up lookup that cannot answer: fail open.
    expect(await limiter(rows, { isWarmup: async () => null }).l.check('gina', 'video')).toBeNull();
  });

  it('holds a warm-up account to its own limit (3 videos, 3 shorts) without Pro in the message', async () => {
    const isWarmup = async () => true;
    const two = [row({ ago: 5 * HOUR }), row({ ago: 2 * HOUR })];
    expect(await limiter(two, { isWarmup }).l.check('frank', 'video')).toBeNull();
    const three = [row({ ago: 20 * HOUR }), ...two];
    const r = await limiter(three, { isWarmup }).l.check('frank', 'video');
    expect(r!.body).toMatchObject({ plan: 'warmup', kind: 'video', limit: 3, used: 3, next_at: isoSeconds(NOW - 20 * HOUR + DAY_MS) });
    expect(r!.body.message).toBe(`Warm-up accounts can upload 3 videos per 24 hours. Your next video upload is possible at ${isoSeconds(NOW - 20 * HOUR + DAY_MS)}.`);
    const shorts = [1, 2, 3].map((h) => row({ ago: h * HOUR, short: true }));
    expect((await limiter(shorts, { isWarmup }).l.check('frank', 'short'))!.body).toMatchObject({ plan: 'warmup', limit: 3 });
    expect(await limiter(shorts, { isWarmup }).l.check('frank', 'video')).toBeNull();
    const zero = await limiter([], { isWarmup }, cfg({ warmupVideosPerDay: 0 })).l.check('frank', 'video');
    expect(zero!.body.message).toBe('Warm-up accounts cannot upload videos at the moment.');
  });

  it('never counts the warm-up backlog against the graduated Hive account', async () => {
    const created = NOW - 3 * HOUR;
    // Same name: uploads from before the Hive account existed were the warm-up's.
    const sameName = [row({ ago: 10 * HOUR }), row({ ago: 5 * HOUR }), row({ ago: 4 * HOUR })];
    const { l, deps } = limiter(sameName, { hiveAccountCreatedAt: vi.fn(async () => created) });
    expect(await l.check('grad', 'video')).toBeNull();
    expect(deps.hiveAccountCreatedAt).toHaveBeenCalledWith('grad');
    // Its first own upload after that uses the one free slot as usual.
    const after = [...sameName, row({ ago: HOUR })];
    const r = await limiter(after, { hiveAccountCreatedAt: async () => created }).l.check('grad', 'video');
    expect(r!.body).toMatchObject({ plan: 'free', limit: 1, used: 1, next_at: isoSeconds(NOW - HOUR + DAY_MS) });
    // Claimed from another handle: skipped whatever its age.
    const claimed = [row({ ago: HOUR, owner_claimed_from: 'old-handle' }), row({ ago: HOUR, owner_claimed_from: 'old-handle' })];
    expect(await limiter(claimed, { hiveAccountCreatedAt: async () => NOW - DAY_MS * 30 }).l.check('grad', 'video')).toBeNull();
    // No such Hive account (and not a warm-up) or no age lookup: every row counts.
    expect(await limiter(sameName, { hiveAccountCreatedAt: async () => null }).l.check('grad', 'video')).not.toBeNull();
    expect(await limiter(sameName).l.check('grad', 'video')).not.toBeNull();
    // The age lookup failing: fail open.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await limiter(sameName, { hiveAccountCreatedAt: async () => { throw new Error('hive down'); } }).l.check('grad', 'video')).toBeNull();
    warn.mockRestore();
  });

  it('fails open when a lookup throws', async () => {
    const { l } = limiter([], { getRecentCountedUploads: async () => { throw new Error('mongo down'); } });
    expect(await l.check('hank', 'video')).toBeNull();
    const { l: l2 } = limiter([row({ ago: HOUR })], { isUserPremium: async () => { throw new Error('boom'); } });
    expect(await l2.check('hank', 'video')).toBeNull();
  });
});

describe('UploadLimiter.usage', () => {
  it('drops rows outside the window, bad dates, free replacements and stream VODs', async () => {
    const streamRecordExists = vi.fn(async (_h: string, room: string) => {
      if (room === 'vod-throws') throw new Error('lookup failed');
      return room === 'vod-real';
    });
    const rows: CountedUploadRow[] = [
      row({ ago: DAY_MS + HOUR }),                                            // outside window
      { ...row({ ago: HOUR }), createdAt: 'garbage' as any },                 // unreadable date
      row({ ago: HOUR, replacesPermlink: 'old' }),                            // registered replacement
      row({ ago: HOUR, replaces_existing: true }),                            // claim within grace
      row({ ago: REPLACEMENT_REGISTER_GRACE_MS + HOUR, replaces_existing: true }), // grace over: counts
      row({ ago: HOUR, stream_vod: true }),                                   // verified VOD
      row({ ago: 2 * HOUR, stream_vod: false, frontend_app: STREAM_VOD_APP }),  // failed VOD claim: counts
      row({ ago: HOUR, permlink: 'vod-real', frontend_app: STREAM_VOD_APP }),   // old row, verified now
      row({ ago: HOUR, permlink: 'vod-fake', frontend_app: STREAM_VOD_APP }),   // old row, no record: counts
      row({ ago: HOUR, permlink: 'vod-throws', frontend_app: STREAM_VOD_APP }), // lookup fails: VOD
      row({ ago: 5 * HOUR, short: true, frontend_app: STREAM_VOD_APP }),       // shorts are never VODs
      row({ ago: 3 * HOUR, short: true }),
    ];
    const { l } = limiter(rows, { streamRecordExists });
    const u = await l.usage('ivy');
    expect(u.video).toEqual([
      NOW - REPLACEMENT_REGISTER_GRACE_MS - HOUR, NOW - 2 * HOUR, NOW - HOUR,
    ]);
    expect(u.short).toEqual([NOW - 5 * HOUR, NOW - 3 * HOUR]);
    expect(streamRecordExists).toHaveBeenCalledTimes(3);
  });

  it('uses Date.now when no clock is injected', async () => {
    const l = new UploadLimiter(cfg(), {
      getRecentCountedUploads: async () => [{ permlink: 'x', short: false, frontend_app: 'a', createdAt: new Date(Date.now() - 1000) }],
      isUserPremium: async () => false, streamRecordExists: async () => false, isWarmup: async () => false,
    });
    expect((await l.usage('x')).video).toHaveLength(1);
  });
});

describe('UploadLimiter.quota and exemptReason', () => {
  it('reports unlimited when disabled', async () => {
    const q = await limiter([], {}, cfg({ enabled: false })).l.quota('a');
    expect(q).toEqual({
      enabled: false, exempt: true, reason: null, plan: null,
      video: { limit: null, used: 0, remaining: null, next_at: null },
      short: { limit: null, used: 0, remaining: null, next_at: null },
    });
  });

  it('reports remaining slots and the next slot time', async () => {
    const { l } = limiter([row({ ago: 4 * HOUR }), row({ ago: HOUR, short: true })]);
    const q = await l.quota('jo');
    expect(q.enabled).toBe(true);
    expect(q.exempt).toBe(false);
    expect(q.reason).toBeNull();
    expect(q.plan).toBe('free');
    expect(q.video).toEqual({ limit: 1, used: 1, remaining: 0, next_at: isoSeconds(NOW - 4 * HOUR + DAY_MS) });
    expect(q.short).toEqual({ limit: 3, used: 1, remaining: 2, next_at: null });
  });

  it('reports the exemption reason with unlimited kinds', async () => {
    const rows = [row({ ago: HOUR })];
    expect((await limiter(rows, {}, cfg({ exempt: ['kim'] })).l.quota('kim')).reason).toBe('listed');
    const pro = await limiter(rows, { isUserPremium: async () => true }).l.quota('kim');
    expect(pro).toMatchObject({ exempt: true, reason: 'pro', plan: null, video: { limit: null, used: 1, remaining: null, next_at: null } });
    expect(await limiter(rows, { isWarmup: async () => true }).l.exemptReason('kim')).toBeNull();
    expect(await limiter(rows, { isWarmup: async () => null }).l.exemptReason('kim')).toBeNull();
  });

  it('reports the warm-up plan with its own limits', async () => {
    const q = await limiter([row({ ago: 2 * HOUR }), row({ ago: HOUR, short: true })], { isWarmup: async () => true }).l.quota('kid');
    expect(q).toEqual({
      enabled: true, exempt: false, reason: null, plan: 'warmup',
      video: { limit: 3, used: 1, remaining: 2, next_at: null },
      short: { limit: 3, used: 1, remaining: 2, next_at: null },
    });
  });

  it('leaves the warm-up backlog out of a graduate\'s counters', async () => {
    const rows = [row({ ago: 6 * HOUR }), row({ ago: 5 * HOUR, owner_claimed_from: 'kid' }), row({ ago: HOUR, short: true })];
    const q = await limiter(rows, { hiveAccountCreatedAt: async () => NOW - 2 * HOUR }).l.quota('grad');
    expect(q.plan).toBe('free');
    expect(q.video).toEqual({ limit: 1, used: 0, remaining: 1, next_at: null });
    expect(q.short).toEqual({ limit: 3, used: 1, remaining: 2, next_at: null });
    // Lookups that cannot answer: the free plan over every unclaimed row.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = await limiter(rows, { hiveAccountCreatedAt: async () => { throw new Error('x'); } }).l.quota('grad');
    expect(unknown).toMatchObject({ plan: 'free', video: { used: 1 } });
    expect((await limiter(rows, { isWarmup: async () => null }).l.quota('grad')).video.used).toBe(1);
    warn.mockRestore();
  });

  it('throws when the count cannot be read', async () => {
    const { l } = limiter([], { getRecentCountedUploads: async () => { throw new Error('down'); } });
    await expect(l.quota('lee')).rejects.toThrow('down');
  });
});

describe('UploadLimiter.upgradeUrl', () => {
  it('fills {owner} and {user} and encodes the name', () => {
    expect(limiter([]).l.upgradeUrl('a b')).toBe('https://3speak.tv/wallet/a%20b#pro');
    expect(limiter([], {}, cfg({ upgradeUrl: 'https://x.test/pro?u={user}&o={owner}' })).l.upgradeUrl('mo'))
      .toBe('https://x.test/pro?u=mo&o=mo');
    expect(limiter([], {}, null).l.upgradeUrl('mo')).toBe('https://3speak.tv/wallet/mo#pro');
  });

  it('isoSeconds drops milliseconds', () => {
    expect(isoSeconds(Date.parse('2026-11-21T14:32:00.987Z'))).toBe('2026-11-21T14:32:00Z');
  });
});

describe('verifyReplacementTarget', () => {
  const db = (embed: Record<string, string>, legacy: Record<string, string> = {}) => ({
    getVideo: vi.fn(async (p: string) => (p in embed ? { owner: embed[p] } : null)),
    getLegacyVideo: vi.fn(async (p: string) => (p in legacy ? { owner: legacy[p] } : null)),
  });

  it('rejects non-string, blank and self targets without a lookup', async () => {
    const d = db({ self: 'nia' });
    expect(await verifyReplacementTarget(d, 'nia', 42)).toBe(false);
    expect(await verifyReplacementTarget(d, 'nia', '   ')).toBe(false);
    expect(await verifyReplacementTarget(d, 'nia', ' self ', 'self')).toBe(false);
    expect(d.getVideo).not.toHaveBeenCalled();
  });

  it('accepts the owner\'s own embed or legacy video, trimmed', async () => {
    const d = db({ emb: 'nia', theirs: 'oz' }, { leg: 'nia' });
    expect(await verifyReplacementTarget(d, 'nia', ' emb ')).toBe(true);
    expect(d.getVideo).toHaveBeenCalledWith('emb');
    expect(await verifyReplacementTarget(d, 'nia', 'leg', 'newone')).toBe(true);
    expect(await verifyReplacementTarget(d, 'nia', 'theirs')).toBe(false);
    expect(await verifyReplacementTarget(d, 'nia', 'missing')).toBe(false);
  });

  it('returns null when the lookup fails', async () => {
    const d = { getVideo: async () => { throw new Error('down'); }, getLegacyVideo: async () => null };
    expect(await verifyReplacementTarget(d, 'nia', 'x')).toBeNull();
  });
});

describe('createWarmupLookup', () => {
  type Answer = { ok?: boolean; status?: number; body?: any; throws?: Error };
  function fakeFetch(route: (url: string, body: any) => Answer) {
    return vi.fn(async (url: string, init: any) => {
      const a = route(url, JSON.parse(init.body));
      if (a.throws) throw a.throws;
      return { ok: a.ok ?? true, status: a.status ?? 200, json: async () => a.body };
    });
  }
  const c = { warmupLookupUrl: 'http://checker.test/incubation/authors', hiveApiNodes: ['http://hive-a.test', 'http://hive-b.test'] };
  const incubating = (h: string) => ({ body: { authors: { [h]: { status: 'incubating' } } } });

  it('never looks up names that are not handles', async () => {
    const f = fakeFetch(() => ({ body: {} }));
    const look = createWarmupLookup(c, f as any);
    expect(await look('Not A Handle!')).toBe(false);
    expect(await look('')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('is a warm-up when incubating and Hive has no such account, and caches it', async () => {
    const f = fakeFetch((url, body) => {
      if (url === c.warmupLookupUrl) { expect(body).toEqual({ handles: ['newbie'] }); return incubating('newbie'); }
      expect(body.method).toBe('condenser_api.get_accounts');
      return { body: { result: [] } };
    });
    const look = createWarmupLookup(c, f as any);
    expect(await look(' NewBie ')).toBe(true);
    expect(await look('newbie')).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('is not a warm-up when not incubating, or the name is a Hive account', async () => {
    const f = fakeFetch((url) => {
      if (url === c.warmupLookupUrl) return { body: { authors: { taken: { status: 'incubating' }, plain: { status: 'graduated' } } } };
      return { body: { result: [{ name: 'taken' }] } };
    });
    const look = createWarmupLookup(c, f as any);
    expect(await look('plain')).toBe(false);
    expect(await look('taken')).toBe(false);
  });

  it('fails over between Hive nodes, and answers null when all fail', async () => {
    const seen: string[] = [];
    const ok = fakeFetch((url) => {
      seen.push(url);
      if (url === c.warmupLookupUrl) return incubating('fo');
      if (url === 'http://hive-a.test') return { ok: false, status: 503 };
      return { body: { result: [] } };
    });
    expect(await createWarmupLookup(c, ok as any)('fo')).toBe(true);
    expect(seen).toEqual([c.warmupLookupUrl, 'http://hive-a.test', 'http://hive-b.test']);

    const bad = fakeFetch((url) => (url === c.warmupLookupUrl ? incubating('fo') : url === 'http://hive-a.test' ? { body: { nope: 1 } } : { throws: new Error('ECONNRESET') }));
    const look = createWarmupLookup(c, bad as any);
    expect(await look('fo')).toBeNull();
    // Unknown answers are not cached.
    expect(await look('fo')).toBeNull();
    expect(bad).toHaveBeenCalledTimes(6);

    const none = fakeFetch(() => incubating('fo'));
    expect(await createWarmupLookup({ ...c, hiveApiNodes: [] }, none as any)('fo')).toBeNull();
  });

  it('answers null when the checker errors or times out', async () => {
    const http = fakeFetch(() => ({ ok: false, status: 500 }));
    expect(await createWarmupLookup(c, http as any)('pat')).toBeNull();

    const hang = vi.fn((_url: string, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    expect(await createWarmupLookup(c, hang as any, 1000, 5)('pat')).toBeNull();
  });

  it('expires cached answers after the TTL and clears a huge cache', async () => {
    const f = fakeFetch(() => ({ body: { authors: {} } }));
    const look = createWarmupLookup(c, f as any, -1);
    expect(await look('ttl')).toBe(false);
    expect(await look('ttl')).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);

    const many = createWarmupLookup(c, f as any);
    for (let i = 0; i <= 5001; i++) await many(`u${i}`);
    expect(f).toHaveBeenCalledTimes(2 + 5002);
  });
});

describe('createHiveAccountLookup', () => {
  const c = { hiveApiNodes: ['http://hive-a.test', 'http://hive-b.test'] };
  const answer = (result: any) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result }) }));

  it('answers the creation time, caches it, and reads Hive times as UTC', async () => {
    const f = answer([{ name: 'grad', created: '2026-11-20T10:00:00' }]);
    const look = createHiveAccountLookup(c, f as any);
    expect(await look(' Grad ')).toBe(Date.parse('2026-11-20T10:00:00Z'));
    expect(await look('grad')).toBe(Date.parse('2026-11-20T10:00:00Z'));
    expect(f).toHaveBeenCalledTimes(1);
    expect(await createHiveAccountLookup(c, answer([{ name: 'z', created: '2026-11-20T10:00:00Z' }]) as any)('z')).toBe(Date.parse('2026-11-20T10:00:00Z'));
  });

  it('answers null for no such account or a blank name, 0 for an unreadable time', async () => {
    expect(await createHiveAccountLookup(c, answer([]) as any)('nobody')).toBeNull();
    expect(await createHiveAccountLookup(c, answer([]) as any)('')).toBeNull();
    expect(await createHiveAccountLookup(c, answer([{ name: 'odd', created: 'soon' }]) as any)('odd')).toBe(0);
    expect(await createHiveAccountLookup(c, answer([{ name: 'odd' }]) as any)('odd')).toBe(0);
  });

  it('throws when every node fails, and caches nothing then', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const look = createHiveAccountLookup(c, f as any);
    await expect(look('x')).rejects.toThrow('ECONNRESET');
    await expect(look('x')).rejects.toThrow('ECONNRESET');
    expect(f).toHaveBeenCalledTimes(4);
    await expect(createHiveAccountLookup({ hiveApiNodes: [] }, f as any)('x')).rejects.toThrow('no Hive API nodes');
  });

  it('expires answers after the TTL and clears a huge cache', async () => {
    const f = answer([]);
    const look = createHiveAccountLookup(c, f as any, -1);
    await look('t'); await look('t');
    expect(f).toHaveBeenCalledTimes(2);
    const many = createHiveAccountLookup(c, f as any);
    for (let i = 0; i <= 5001; i++) await many(`u${i}`);
    expect(f).toHaveBeenCalledTimes(2 + 5002);
  });
});

describe('getUploadLimiter', () => {
  it('builds one limiter per database and config, wired to the database', async () => {
    const database: any = {
      getRecentCountedUploads: vi.fn(async () => [
        { permlink: 'a', short: false, frontend_app: STREAM_VOD_APP, createdAt: new Date() },
      ]),
      isUserPremium: vi.fn(async () => true),
      streamRecordExists: vi.fn(async () => false),
    };
    const config: any = { uploadLimits: cfg({ exempt: [] }) };
    const a = getUploadLimiter(database, config);
    expect(getUploadLimiter(database, config)).toBe(a);
    expect(await a.check('quinn', 'video')).toBeNull();
    expect(database.getRecentCountedUploads).toHaveBeenCalled();
    expect(database.streamRecordExists).toHaveBeenCalledWith('quinn', 'a');
    expect(database.isUserPremium).toHaveBeenCalledWith('quinn');

    const changed: any = { uploadLimits: cfg({ videosPerDay: 5 }) };
    const b = getUploadLimiter(database, changed);
    expect(b).not.toBe(a);
    expect(b.limitFor('video')).toBe(5);

    const off = getUploadLimiter(database, { uploadLimits: undefined } as any);
    expect(off.enabled).toBe(false);
    expect(await off.exemptReason('quinn')).toBe('pro');
  });

  it('falls back to "unknown" warm-up status without a config', async () => {
    const database: any = { isUserPremium: async () => false };
    const l = getUploadLimiter(database, { uploadLimits: undefined } as any);
    expect(await l.exemptReason('rae')).toBeNull();
  });
});
