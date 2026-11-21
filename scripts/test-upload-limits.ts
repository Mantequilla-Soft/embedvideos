/**
 * Tests for the daily upload limits (src/utils/uploadLimits.ts).
 *
 * Rule: owners without 3Speak Pro get 1 regular video and 3 shorts per rolling
 * 24 hours. Only uploads whose bytes landed count. Stream VODs never count and
 * are never refused. Pro, warm-up and listed owners are exempt. Everything
 * fails open.
 *
 * Runs with no MongoDB and no network: the limiter gets stub dependencies, the
 * Mongo count query runs against a small in-memory collection, and the warm-up
 * lookup gets a fake fetch.
 *
 * Usage: npx ts-node --transpile-only scripts/test-upload-limits.ts
 */

import { readFileSync } from 'fs';
import path from 'path';
import {
  UploadLimiter, LimiterDeps, createWarmupLookup, DAY_MS, STREAM_VOD_APP, isoSeconds,
  verifyReplacementTarget, REPLACEMENT_REGISTER_GRACE_MS,
} from '../src/utils/uploadLimits';
import { loadUploadLimitsConfig, UploadLimitsConfig, Config } from '../src/config/config';
import { Database, CountedUploadRow, COUNTED_UPLOAD_STATUSES, VideoStatus } from '../src/database/mongodb';
import { validateUploadAuth } from '../src/utils/uploadAuth';
import { signUploadToken, UploadTokenClaims } from '../src/utils/uploadToken';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function cfg(over: Partial<UploadLimitsConfig> = {}): UploadLimitsConfig {
  return {
    ...loadUploadLimitsConfig({}),
    ...over,
  };
}

function row(over: Partial<CountedUploadRow> & { hoursAgo?: number } = {}): CountedUploadRow {
  const { hoursAgo = 1, ...rest } = over;
  return {
    permlink: `p${Math.random().toString(36).slice(2, 9)}`,
    short: false,
    frontend_app: '3speak-tv',
    createdAt: new Date(NOW - hoursAgo * HOUR),
    ...rest,
  };
}

function limiter(rows: CountedUploadRow[], over: Partial<LimiterDeps> = {}, c: UploadLimitsConfig = cfg()): UploadLimiter {
  return new UploadLimiter(c, {
    getRecentCountedUploads: async () => rows,
    isUserPremium: async () => false,
    streamRecordExists: async () => false,
    isWarmup: async () => false,
    now: () => NOW,
    ...over,
  });
}

// ---- in-memory embed-video for the real Database.getRecentCountedUploads ----

interface MemRow extends CountedUploadRow { owner: string; status: VideoStatus }

function memDatabase(rows: MemRow[]): { db: Database; lastFilter: () => any } {
  let captured: any = null;
  const fakeCollection = {
    find(filter: any) {
      captured = filter;
      const matched = rows.filter((r) =>
        r.owner === filter.owner &&
        r.createdAt.getTime() >= filter.createdAt.$gte.getTime() &&
        filter.status.$in.includes(r.status));
      // Honours limit() like a real cursor, so a cap in the query shows up here.
      let cap = Infinity;
      const cursor = {
        sort: () => cursor,
        limit: (n: number) => { cap = n; return cursor; },
        toArray: async () => [...matched].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, cap),
      };
      return cursor;
    },
  };
  const db = new Database('mongodb://127.0.0.1:1', 'test', 'embed-video');
  (db as any).collection = fakeCollection;
  return { db, lastFilter: () => captured };
}

// ---- validateUploadAuth stubs ----

const SECRET = 'test-secret-not-a-real-key';

function authConfig(limits: UploadLimitsConfig): Config {
  return { uploadTokenSecret: SECRET, uploadLimits: limits } as unknown as Config;
}

function stubDb(over: Partial<Record<string, unknown>> = {}): Database {
  return {
    consumeUploadToken: async () => true,
    getUser: async () => ({ username: 'alice', banned: false }),
    createUser: async () => undefined,
    getApiKey: async () => ({ active: true, app_name: '3speak' }),
    updateApiKeyLastUsed: async () => undefined,
    isUserPremium: async () => false,
    streamRecordExists: async () => false,
    getRecentCountedUploads: async () => [],
    getVideo: async () => null,
    getLegacyVideo: async () => null,
    ...over,
  } as unknown as Database;
}

function bearer(over: Partial<UploadTokenClaims> = {}): Record<string, string[]> {
  const now = Math.floor(Date.now() / 1000);
  const c: UploadTokenClaims = {
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    owner: 'alice', app: '3speak-tv', issuedByKey: '3speak', short: false, gated: false,
    maxFileSize: 1_000_000, allowedOrigins: [], permlink: 'vid12345', iat: now, exp: now + 600,
    ...over,
  };
  return { Authorization: [`Bearer ${signUploadToken(c, SECRET)}`] };
}

/** Limiter whose window is "now" in real time, for validateUploadAuth (which has no clock hook). */
function realTimeRows(n: number, short = false): CountedUploadRow[] {
  return Array.from({ length: n }, (_, i) => ({
    permlink: `real${i}`, short, frontend_app: '3speak-tv', createdAt: new Date(Date.now() - (i + 1) * HOUR),
  }));
}

async function main(): Promise<void> {
  section('Config');
  {
    const d = loadUploadLimitsConfig({});
    ok('enabled by default', d.enabled === true);
    ok('1 video and 3 shorts by default', d.videosPerDay === 1 && d.shortsPerDay === 3);
    ok('kill switch: UPLOAD_DAILY_LIMITS_ENABLED=false disables', loadUploadLimitsConfig({ UPLOAD_DAILY_LIMITS_ENABLED: 'false' }).enabled === false);
    ok('any other value keeps it on', loadUploadLimitsConfig({ UPLOAD_DAILY_LIMITS_ENABLED: 'true' }).enabled === true);
    const e = loadUploadLimitsConfig({ UPLOAD_LIMIT_EXEMPT: ' Alice, @bob ,,', UPLOAD_LIMIT_VIDEOS_PER_DAY: '2', UPLOAD_LIMIT_SHORTS_PER_DAY: 'x' });
    ok('exempt list is trimmed, lowercased, @-stripped', JSON.stringify(e.exempt) === '["alice","bob"]', JSON.stringify(e.exempt));
    ok('counts parse, garbage falls back to the default', e.videosPerDay === 2 && e.shortsPerDay === 3);
  }

  section('Under and over the limit');
  {
    ok('first video of the day is allowed', (await limiter([]).check('alice', 'video')) === null);
    const oldest = row({ hoursAgo: 5 });
    const r = await limiter([oldest]).check('alice', 'video');
    ok('second video is refused', r !== null);
    if (r) {
      ok('with 429', r.status === 429);
      ok('code daily_upload_limit, kind video', r.body.code === 'daily_upload_limit' && r.body.kind === 'video');
      ok('limit 1, used 1', r.body.limit === 1 && r.body.used === 1);
      const expectNext = isoSeconds(oldest.createdAt.getTime() + DAY_MS);
      ok('next_at = oldest counted upload + 24h', r.body.next_at === expectNext, `${r.body.next_at} vs ${expectNext}`);
      ok('next_at has no milliseconds', /T\d\d:\d\d:\d\dZ$/.test(r.body.next_at || ''));
      ok('retry_after_seconds = 19 hours', r.body.retry_after_seconds === 19 * 3600, String(r.body.retry_after_seconds));
      ok('Retry-After header matches', r.headers['Retry-After'] === String(19 * 3600));
      ok('error stays short', r.body.error === 'Daily video upload limit reached');
      ok('message is a full sentence with the time and Pro',
        r.body.message === `Free accounts can upload 1 video per 24 hours. Your next video upload is possible at ${expectNext}. 3Speak Pro removes this limit.`,
        r.body.message);
      ok('upgrade_url points at the owner\'s Pro plans', r.body.upgrade_url === 'https://3speak.tv/wallet/alice#pro', r.body.upgrade_url);
    }
  }
  {
    const viaEnv = loadUploadLimitsConfig({ UPLOAD_UPGRADE_URL: 'https://example.test/pro?u={user}' });
    const r = await limiter([row()], {}, viaEnv).check('alice', 'video');
    ok('UPLOAD_UPGRADE_URL overrides upgrade_url ({user} placeholder too)', r?.body.upgrade_url === 'https://example.test/pro?u=alice', r?.body.upgrade_url);
  }
  {
    const r = await limiter([row({ hoursAgo: 30 })]).check('alice', 'video');
    ok('an upload older than 24h no longer counts', r === null);
  }
  {
    // Over the limit (limit lowered after the fact): the slot frees when enough age out.
    const rows = [row({ hoursAgo: 20 }), row({ hoursAgo: 10 }), row({ hoursAgo: 2 })];
    const r = await limiter(rows, {}, cfg({ videosPerDay: 2 })).check('alice', 'video');
    ok('used 3 of 2: next_at is when the 2nd oldest ages out',
      r?.body.next_at === isoSeconds(rows[1].createdAt.getTime() + DAY_MS), r?.body.next_at || 'null');
  }

  section('Shorts and videos are counted separately');
  {
    const oneVideo = [row()];
    ok('1 video used: a short is still allowed', (await limiter(oneVideo).check('alice', 'short')) === null);
    const threeShorts = [row({ short: true }), row({ short: true }), row({ short: true })];
    ok('3 shorts used: a video is still allowed', (await limiter(threeShorts).check('alice', 'video')) === null);
    ok('2 shorts used: a 3rd short is allowed', (await limiter(threeShorts.slice(0, 2)).check('alice', 'short')) === null);
    const r = await limiter(threeShorts).check('alice', 'short');
    ok('3 shorts used: a 4th short is refused', r?.body.kind === 'short' && r.body.limit === 3 && r.body.used === 3);
    ok('short message pluralises', !!r?.body.message.startsWith('Free accounts can upload 3 shorts per 24 hours. Your next short upload'), r?.body.message);
  }

  section('Stream VODs never count');
  {
    ok('a verified VOD row (stream_vod true) is not counted',
      (await limiter([row({ frontend_app: STREAM_VOD_APP, stream_vod: true })]).check('alice', 'video')) === null);
    ok('an unverified VOD claim (stream_vod false) is counted',
      (await limiter([row({ frontend_app: STREAM_VOD_APP, stream_vod: false })]).check('alice', 'video')) !== null);
    let asked = '';
    const legacy = row({ frontend_app: STREAM_VOD_APP, permlink: 'alice-room123' });
    ok('a pre-limit hangouts row with a stream record is not counted',
      (await limiter([legacy], { streamRecordExists: async (h, r) => { asked = `${h}/${r}`; return true; } }).check('alice', 'video')) === null);
    ok('  (looked up by owner + permlink as room name)', asked === 'alice/alice-room123', asked);
    ok('a pre-limit hangouts row without one is counted',
      (await limiter([legacy], { streamRecordExists: async () => false }).check('alice', 'video')) !== null);
    ok('a pre-limit hangouts row whose lookup errors is not counted (fail open)',
      (await limiter([legacy], { streamRecordExists: async () => { throw new Error('down'); } }).check('alice', 'video')) === null);
  }

  section('Exemptions');
  {
    const full = [row()];
    ok('Pro is exempt', (await limiter(full, { isUserPremium: async () => true }).check('alice', 'video')) === null);
    ok('warm-up is exempt', (await limiter(full, { isWarmup: async () => true }).check('alice', 'video')) === null);
    ok('warm-up lookup that cannot answer fails open', (await limiter(full, { isWarmup: async () => null }).check('alice', 'video')) === null);
    ok('listed owner is exempt (case-insensitive)', (await limiter(full, {}, cfg({ exempt: ['alice'] })).check('Alice', 'video')) === null);
    let lookups = 0;
    await limiter([], { isUserPremium: async () => { lookups++; return false; }, isWarmup: async () => { lookups++; return false; } }).check('alice', 'video');
    ok('an owner under the limit costs no Pro or warm-up lookup', lookups === 0);
  }

  section('Disabled flag');
  {
    let counted = false;
    const off = limiter([row(), row()], { getRecentCountedUploads: async () => { counted = true; return [row()]; } }, cfg({ enabled: false }));
    ok('UPLOAD_DAILY_LIMITS_ENABLED=false allows everything', (await off.check('alice', 'video')) === null);
    ok('and does not even count', counted === false);
    const q = await off.quota('alice');
    ok('quota says enabled:false, exempt:true', q.enabled === false && q.exempt === true && q.reason === null);
    ok('quota limits are null', q.video.limit === null && q.short.limit === null);
  }

  section('Fail open');
  {
    ok('count query that throws allows the upload',
      (await limiter([], { getRecentCountedUploads: async () => { throw new Error('mongo down'); } }).check('alice', 'video')) === null);
    ok('Pro lookup that throws allows the upload',
      (await limiter([row()], { isUserPremium: async () => { throw new Error('mongo down'); } }).check('alice', 'video')) === null);
  }

  section('Only landed uploads count (real count query, in-memory collection)');
  {
    ok('counted statuses are processing, awaiting_encode, published',
      JSON.stringify([...COUNTED_UPLOAD_STATUSES].sort()) === JSON.stringify(['awaiting_encode', 'processing', 'published']));
    const base = { short: false, frontend_app: '3speak-tv', createdAt: new Date(Date.now() - HOUR) };
    const rows: MemRow[] = [
      { ...base, owner: 'alice', permlink: 'a1', status: 'failed' },
      { ...base, owner: 'alice', permlink: 'a2', status: 'uploading' },
      { ...base, owner: 'alice', permlink: 'a3', status: 'deleted' },
      { ...base, owner: 'bob', permlink: 'b1', status: 'published' },
    ];
    const { db, lastFilter } = memDatabase(rows);
    const got = await db.getRecentCountedUploads('alice', new Date(Date.now() - DAY_MS));
    ok('failed, uploading and deleted rows are not returned', got.length === 0, JSON.stringify(got));
    ok('query is scoped to the owner and the 24h window',
      lastFilter()?.owner === 'alice' && lastFilter()?.createdAt?.$gte instanceof Date);
    rows.push({ ...base, owner: 'alice', permlink: 'a4', status: 'processing' });
    rows.push({ ...base, owner: 'alice', permlink: 'a5', status: 'awaiting_encode' });
    rows.push({ ...base, owner: 'alice', permlink: 'a6', status: 'published' });
    const got2 = await db.getRecentCountedUploads('alice', new Date(Date.now() - DAY_MS));
    ok('processing, awaiting_encode and published rows are', got2.map((r) => r.permlink).join(',') === 'a4,a5,a6', got2.map((r) => r.permlink).join(','));
    const l = new UploadLimiter(cfg(), {
      getRecentCountedUploads: (o, s) => db.getRecentCountedUploads(o, s),
      isUserPremium: async () => false, streamRecordExists: async () => false, isWarmup: async () => false,
    });
    const r = await l.check('alice', 'video');
    ok('3 failed/unfinished + 3 landed rows: used is 3', r?.body.used === 3, String(r?.body.used));
    rows.length = 3;
    ok('with only failed/uploading/deleted rows the owner may upload', (await l.check('alice', 'video')) === null);
  }
  {
    // Regression: no cap before the limiter drops exempt rows.
    const t0 = Date.now() - 20 * HOUR;
    const rows: MemRow[] = Array.from({ length: 250 }, (_, i) => ({
      owner: 'alice', permlink: `r${i}`, status: 'published' as VideoStatus, short: false, frontend_app: '3speak-tv',
      createdAt: new Date(t0 + i * 1000), replaces_existing: true, replacesPermlink: 'orig1',
    }));
    rows.push({ owner: 'alice', permlink: 'ordinary', status: 'published', short: false, frontend_app: '3speak-tv', createdAt: new Date(Date.now() - HOUR) });
    const { db } = memDatabase(rows);
    const deps = {
      getRecentCountedUploads: (o: string, s: Date) => db.getRecentCountedUploads(o, s),
      isUserPremium: async () => false, streamRecordExists: async () => false, isWarmup: async () => false,
    };
    const r = await new UploadLimiter(cfg(), deps).check('alice', 'video');
    ok('250 older free replacements do not hide a newer ordinary upload', r?.body.used === 1, String(r?.body.used));
    const many: MemRow[] = Array.from({ length: 300 }, (_, i) => ({
      owner: 'alice', permlink: `v${i}`, status: 'published' as VideoStatus, short: false, frontend_app: '3speak-tv',
      createdAt: new Date(t0 + i * 1000),
    }));
    const { db: db2 } = memDatabase(many);
    const r2 = await new UploadLimiter(cfg({ videosPerDay: 300 }), { ...deps, getRecentCountedUploads: (o, s) => db2.getRecentCountedUploads(o, s) }).check('alice', 'video');
    ok('a limit above 200 is enforced (300 of 300 used: refused)', r2?.body.used === 300 && r2.body.limit === 300, String(r2?.body.used));
  }

  section('Quota');
  {
    const oldest = row({ hoursAgo: 6 });
    const q = await limiter([oldest, row({ short: true })]).quota('alice');
    ok('enabled, not exempt', q.enabled === true && q.exempt === false && q.reason === null);
    ok('video: limit 1, used 1, remaining 0, next_at set',
      q.video.limit === 1 && q.video.used === 1 && q.video.remaining === 0 && q.video.next_at === isoSeconds(oldest.createdAt.getTime() + DAY_MS),
      JSON.stringify(q.video));
    ok('short: limit 3, used 1, remaining 2, next_at null',
      q.short.limit === 3 && q.short.used === 1 && q.short.remaining === 2 && q.short.next_at === null, JSON.stringify(q.short));
    const pro = await limiter([oldest], { isUserPremium: async () => true }).quota('alice');
    ok('Pro: exempt, reason pro, limit null', pro.exempt && pro.reason === 'pro' && pro.video.limit === null && pro.video.used === 1);
    const wu = await limiter([], { isWarmup: async () => true }).quota('alice');
    ok('warm-up: reason warmup', wu.exempt && wu.reason === 'warmup');
    const listed = await limiter([], {}, cfg({ exempt: ['alice'] })).quota('alice');
    ok('listed: reason listed', listed.exempt && listed.reason === 'listed');
    const vod = await limiter([row({ stream_vod: true })]).quota('alice');
    ok('a VOD does not show as used', vod.video.used === 0 && vod.video.remaining === 1);
  }
  {
    const src = readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const quotaAt = src.indexOf("app.get('/uploads/quota'");
    const wildcardAt = src.indexOf("app.all('/uploads/*', countUpload");
    ok('GET /uploads/quota is registered before the /uploads/* tusd proxy', quotaAt > 0 && quotaAt < wildcardAt);
    ok('and requires the API key', /app\.get\('\/uploads\/quota', requireApiKey/.test(src));
  }

  section('Upload creation enforces it for every auth method (validateUploadAuth)');
  {
    const limits = cfg();
    const full = stubDb({ getRecentCountedUploads: async () => realTimeRows(1) });
    const viaKey = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { owner: 'alice', frontend_app: 'someapp', short: 'false' }, 100, full, authConfig(limits));
    ok('X-API-Key upload over the limit is refused with 429', viaKey.ok === false && viaKey.status === 429, JSON.stringify(viaKey));
    if (!viaKey.ok) {
      ok('  with the full contract body', viaKey.body?.code === 'daily_upload_limit' && viaKey.body?.kind === 'video' &&
        typeof viaKey.body?.message === 'string' && typeof viaKey.body?.next_at === 'string' &&
        typeof viaKey.body?.retry_after_seconds === 'number' && typeof viaKey.body?.upgrade_url === 'string');
      ok('  and a Retry-After header', !!viaKey.headers?.['Retry-After']);
    }
    const viaToken = await validateUploadAuth(bearer(), {}, 100, full, authConfig(limits));
    ok('token upload over the limit is refused with 429 too', viaToken.ok === false && viaToken.status === 429);
    const shortOk = await validateUploadAuth(bearer({ short: true }), {}, 100, full, authConfig(limits));
    ok('a short is still allowed with 1 video used', shortOk.ok === true);
    const fresh = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { owner: 'alice' }, 100, stubDb(), authConfig(limits));
    ok('X-API-Key upload under the limit is accepted', fresh.ok === true);
    const off = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { owner: 'alice' }, 100, full, authConfig(cfg({ enabled: false })));
    ok('kill switch off: accepted', off.ok === true);
    const pro = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { owner: 'alice' }, 100, stubDb({ getRecentCountedUploads: async () => realTimeRows(1), isUserPremium: async () => true }), authConfig(limits));
    ok('Pro over the count: accepted', pro.ok === true);
    const partial = await validateUploadAuth({ 'X-Api-Key': ['k'] }, {}, 100, full, authConfig(limits), true);
    ok('parallel-upload pieces (partial) are not limited (no owner yet)', partial.ok === true);
  }
  {
    const limits = cfg();
    const vodMeta = { owner: 'alice', frontend_app: STREAM_VOD_APP, short: 'false', permlink: 'alice-room123' };
    let asked = '';
    const withRecord = stubDb({
      getRecentCountedUploads: async () => realTimeRows(5),
      streamRecordExists: async (h: string, r: string) => { asked = `${h}/${r}`; return true; },
    });
    const vod = await validateUploadAuth({ 'X-Api-Key': ['k'] }, vodMeta, 100, withRecord, authConfig(limits));
    ok('verified VOD is accepted even far over the video limit', vod.ok === true);
    ok('  and marked streamVod true', vod.ok === true && vod.streamVod === true);
    ok('  verified by owner + room name', asked === 'alice/alice-room123', asked);
    const fake = await validateUploadAuth({ 'X-Api-Key': ['k'] }, vodMeta, 100,
      stubDb({ getRecentCountedUploads: async () => realTimeRows(1), streamRecordExists: async () => false }), authConfig(limits));
    ok('a VOD claim with no stream record is limited like a video', fake.ok === false && fake.status === 429);
    const freshFake = await validateUploadAuth({ 'X-Api-Key': ['k'] }, vodMeta, 100, stubDb(), authConfig(limits));
    ok('  and marked streamVod false when it is let through', freshFake.ok === true && freshFake.streamVod === false);
    const lookupDown = await validateUploadAuth({ 'X-Api-Key': ['k'] }, vodMeta, 100,
      stubDb({ getRecentCountedUploads: async () => realTimeRows(3), streamRecordExists: async () => { throw new Error('down'); } }), authConfig(limits));
    ok('a VOD claim whose lookup errors is let through, with no verdict', lookupDown.ok === true && lookupDown.streamVod === undefined);
    const viaToken = await validateUploadAuth(bearer({ app: STREAM_VOD_APP, permlink: 'alice-room123' }), {}, 100,
      stubDb({ getRecentCountedUploads: async () => realTimeRows(1), streamRecordExists: async () => true }), authConfig(limits));
    ok('a token upload is never a VOD', viaToken.ok === false && viaToken.status === 429);
    const shortVod = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { ...vodMeta, short: 'true' }, 100,
      stubDb({ getRecentCountedUploads: async () => realTimeRows(3, true), streamRecordExists: async () => true }), authConfig(limits));
    ok('a "VOD" flagged short is a short, not a VOD', shortVod.ok === false && shortVod.status === 429);
    const plain = await validateUploadAuth({ 'X-Api-Key': ['k'] }, { owner: 'alice' }, 100, stubDb(), authConfig(limits));
    ok('an ordinary upload has streamVod undefined', plain.ok === true && plain.streamVod === undefined);
  }

  section('Replacing the media of an existing video is free');
  {
    ok('a registered replacement row is not counted',
      (await limiter([row({ replaces_existing: true, replacesPermlink: 'orig1' })]).check('alice', 'video')) === null);
    ok('a registered replacement without the upload-time marker is not counted',
      (await limiter([row({ replacesPermlink: 'orig1' })]).check('alice', 'video')) === null);
    ok('a fresh, not yet registered replacement row is not counted',
      (await limiter([row({ replaces_existing: true, hoursAgo: 1 })]).check('alice', 'video')) === null);
    const stale = row({ replaces_existing: true, hoursAgo: REPLACEMENT_REGISTER_GRACE_MS / HOUR + 1 });
    ok('a "replacement" never registered within the grace period counts like a video',
      (await limiter([stale]).check('alice', 'video')) !== null);
    const q = await limiter([row({ replaces_existing: true, replacesPermlink: 'orig1' }), row()]).quota('alice');
    ok('quota shows only the ordinary upload as used', q.video.used === 1);
  }
  {
    const videos: Record<string, { owner: string }> = { aliceold: { owner: 'alice' }, bobvid: { owner: 'bob' } };
    const legacy: Record<string, { owner: string }> = { alicelegacy: { owner: 'alice' } };
    const lookups = {
      getVideo: async (p: string) => videos[p] ?? null,
      getLegacyVideo: async (p: string) => legacy[p] ?? null,
    };
    ok('target: own embed video verifies', (await verifyReplacementTarget(lookups, 'alice', 'aliceold')) === true);
    ok('target: own legacy video verifies', (await verifyReplacementTarget(lookups, 'alice', 'alicelegacy')) === true);
    ok('target: someone else\'s video does not', (await verifyReplacementTarget(lookups, 'alice', 'bobvid')) === false);
    ok('target: a non-existent video does not', (await verifyReplacementTarget(lookups, 'alice', 'nope')) === false);
    ok('target: the upload itself does not', (await verifyReplacementTarget({ ...lookups, getVideo: async () => ({ owner: 'alice' }) }, 'alice', 'self1', 'self1')) === false);
    ok('target: a non-string does not', (await verifyReplacementTarget(lookups, 'alice', { $ne: null })) === false);
    const downLookups = { getVideo: async () => { throw new Error('down'); }, getLegacyVideo: async () => null };
    ok('target: a lookup error is unknown (null), not a confirmed mismatch',
      (await verifyReplacementTarget(downLookups, 'alice', 'aliceold')) === null);

    const limits = cfg();
    const atLimit = stubDb({ getRecentCountedUploads: async () => realTimeRows(1), ...lookups });
    const key = { 'X-Api-Key': ['k'] };
    const real = await validateUploadAuth(key, { owner: 'alice', replaces: 'aliceold' }, 100, atLimit, authConfig(limits));
    ok('X-API-Key replacement of an own video is allowed at the limit', real.ok === true, JSON.stringify(real));
    ok('  and marked replacesExisting = the target', real.ok === true && real.replacesExisting === 'aliceold');
    const legacyReal = await validateUploadAuth(key, { owner: 'alice', replaces: 'alicelegacy' }, 100, atLimit, authConfig(limits));
    ok('replacement of an own LEGACY video is allowed at the limit', legacyReal.ok === true);
    const shortAtLimit = stubDb({ getRecentCountedUploads: async () => realTimeRows(3, true), ...lookups });
    ok('a short replacement is allowed with all 3 shorts used',
      (await validateUploadAuth(key, { owner: 'alice', short: 'true', replaces: 'aliceold' }, 100, shortAtLimit, authConfig(limits))).ok === true);
    const others = await validateUploadAuth(key, { owner: 'alice', replaces: 'bobvid' }, 100, atLimit, authConfig(limits));
    ok('fake replacement claim on someone else\'s video is still limited', others.ok === false && others.status === 429);
    const missing = await validateUploadAuth(key, { owner: 'alice', replaces: 'nope' }, 100, atLimit, authConfig(limits));
    ok('fake replacement claim on a non-existent video is still limited', missing.ok === false && missing.status === 429);
    const fresh = await validateUploadAuth(key, { owner: 'alice', replaces: 'nope' }, 100, stubDb(lookups), authConfig(limits));
    ok('  and, under the limit, is an ordinary upload (replacesExisting null)', fresh.ok === true && fresh.replacesExisting === null);
    const viaToken = await validateUploadAuth(bearer({ replaces: 'aliceold' }), {}, 100, atLimit, authConfig(limits));
    ok('token carrying a verified replaces claim is allowed at the limit', viaToken.ok === true && viaToken.replacesExisting === 'aliceold');
    const tokenStale = await validateUploadAuth(bearer({ replaces: 'bobvid' }), {}, 100, atLimit, authConfig(limits));
    ok('a token replaces claim is re-verified at upload (target not the owner\'s: limited)', tokenStale.ok === false && tokenStale.status === 429);
    const tokenIgnoresMeta = await validateUploadAuth(bearer(), { replaces: 'aliceold' }, 100, atLimit, authConfig(limits));
    ok('with a token, a replaces field in metadata is ignored (signed claim only)', tokenIgnoresMeta.ok === false && tokenIgnoresMeta.status === 429);
    const lookupDown = await validateUploadAuth(key, { owner: 'alice', replaces: 'aliceold' }, 100,
      stubDb({ getRecentCountedUploads: async () => realTimeRows(1), ...downLookups }), authConfig(limits));
    ok('replacement whose target lookup fails is let through at the limit (fail open)', lookupDown.ok === true, JSON.stringify(lookupDown));
    ok('  but not recorded as a verified replacement', lookupDown.ok === true && lookupDown.replacesExisting === null);
  }
  {
    const src = readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const route = src.slice(src.indexOf("app.post('/uploads/token'"), src.indexOf("app.get('/uploads/quota'"));
    ok('token route verifies the target before skipping the limit',
      /verifyReplacementTarget\(database, owner, replaces\)/.test(route) && /replacesVerdict !== false \? null : await getUploadLimiter/.test(route));
    ok('token route signs only a verified target into the token', /replacesTarget = replacesVerdict === true \?/.test(route));
    ok('every upload path keeps replacements out of listings',
      (src.match(/listed_on_3speak: !replacesExisting && frontend_app === '3speak-tv'/g) || []).length === 3);
  }

  section('A refused upload does not burn its token');
  {
    const limits = cfg();
    const used = new Set<string>();
    const consume = async (jti: string) => { if (used.has(jti)) return false; used.add(jti); return true; };
    const headers = bearer({ jti: 'retry-me' });
    const full = stubDb({ consumeUploadToken: consume, getRecentCountedUploads: async () => realTimeRows(1) });
    const refused = await validateUploadAuth(headers, {}, 100, full, authConfig(limits));
    ok('over the limit: 429', refused.ok === false && refused.status === 429);
    ok('  and the token is not consumed', !used.has('retry-me'));
    const tooBig = await validateUploadAuth(headers, {}, 5_000_000, stubDb({ consumeUploadToken: consume }), authConfig(limits));
    ok('over the token size limit: 413, token not consumed', tooBig.ok === false && tooBig.status === 413 && !used.has('retry-me'));
    const banned = await validateUploadAuth(headers, {}, 100, stubDb({ consumeUploadToken: consume, getUser: async () => ({ username: 'alice', banned: true }) }), authConfig(limits));
    ok('banned owner: 403, token not consumed', banned.ok === false && banned.status === 403 && !used.has('retry-me'));
    const retry = await validateUploadAuth(headers, {}, 100, stubDb({ consumeUploadToken: consume }), authConfig(limits));
    ok('a retry with the same token, once a slot is free, is accepted', retry.ok === true, JSON.stringify(retry));
    ok('  and consumes it', used.has('retry-me'));
    const replay = await validateUploadAuth(headers, {}, 100, stubDb({ consumeUploadToken: consume }), authConfig(limits));
    ok('a replay of the accepted token is refused with 403', replay.ok === false && replay.status === 403 && /already been used/.test(replay.error));
    let partialConsumed = false;
    const partial = await validateUploadAuth(bearer(), {}, 100, stubDb({ consumeUploadToken: async () => { partialConsumed = true; return true; } }), authConfig(limits), true);
    ok('a partial (chunk) upload does not consume the token', partial.ok === true && !partialConsumed);
  }

  section('Warm-up lookup');
  {
    type Call = { url: string; body: any };
    const mkFetch = (handler: (c: Call) => any) => {
      const calls: Call[] = [];
      const f = async (url: string, init: any) => {
        const c = { url, body: JSON.parse(init.body) };
        calls.push(c);
        const out = handler(c);
        if (out instanceof Error) throw out;
        return { ok: true, status: 200, json: async () => out };
      };
      return { f, calls };
    };
    const lookupCfg = { warmupLookupUrl: 'https://checker.test/incubation/authors', hiveApiNodes: ['https://hive-a.test', 'https://hive-b.test'] };
    const hive = (names: string[]) => ({ result: names.map((name) => ({ name })) });

    {
      const { f, calls } = mkFetch((c) => c.url.includes('checker')
        ? { authors: { newbie: { handle: 'newbie', status: 'incubating', hiveUsername: null } } }
        : hive([]));
      const isWarmup = createWarmupLookup(lookupCfg, f as any);
      ok('incubating + no Hive account = warm-up', (await isWarmup('Newbie')) === true);
      ok('  asked the checker with the lowercased handle', calls[0]?.body?.handles?.[0] === 'newbie');
      ok('  and Hive get_accounts', calls[1]?.body?.method === 'condenser_api.get_accounts');
      const before = calls.length;
      await isWarmup('newbie');
      ok('  second ask is served from cache', calls.length === before);
    }
    {
      const { f } = mkFetch((c) => c.url.includes('checker')
        ? { authors: { taken: { status: 'incubating' } } }
        : hive(['taken']));
      ok('incubating handle that IS a Hive account = not warm-up', (await createWarmupLookup(lookupCfg, f as any)('taken')) === false);
    }
    {
      const { f, calls } = mkFetch(() => ({ authors: {} }));
      ok('a name the registry does not know = not warm-up (a made-up owner cannot claim it)', (await createWarmupLookup(lookupCfg, f as any)('madeup')) === false);
      ok('  and Hive is not asked', calls.length === 1);
    }
    {
      const { f } = mkFetch(() => ({ authors: { grad: { status: 'graduated', hiveUsername: 'grad' } } }));
      ok('graduated = not warm-up', (await createWarmupLookup(lookupCfg, f as any)('grad')) === false);
    }
    {
      const { f, calls } = mkFetch(() => new Error('checker down'));
      const isWarmup = createWarmupLookup(lookupCfg, f as any);
      ok('checker error = unknown (null), so check() fails open', (await isWarmup('newbie')) === null);
      await isWarmup('newbie');
      ok('  and the error is not cached', calls.length === 2);
    }
    {
      const { f, calls } = mkFetch((c) => c.url.includes('checker')
        ? { authors: { newbie: { status: 'incubating' } } }
        : c.url.includes('hive-a') ? new Error('429') : hive([]));
      ok('first Hive node failing falls over to the next', (await createWarmupLookup(lookupCfg, f as any)('newbie')) === true);
      ok('  (both nodes were tried)', calls.filter((c) => c.url.includes('hive')).length === 2);
    }
    {
      const { f } = mkFetch((c) => c.url.includes('checker') ? { authors: { newbie: { status: 'incubating' } } } : new Error('all down'));
      ok('every Hive node failing = unknown (null)', (await createWarmupLookup(lookupCfg, f as any)('newbie')) === null);
    }
    {
      const { f, calls } = mkFetch(() => ({ authors: {} }));
      ok('a malformed owner is not looked up and is not warm-up', (await createWarmupLookup(lookupCfg, f as any)('not a handle!')) === false && calls.length === 0);
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
