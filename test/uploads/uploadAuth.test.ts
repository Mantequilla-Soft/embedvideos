import { describe, it, expect, vi, beforeAll } from 'vitest';
import { installFetchStub, mintToken, owner, rawDb, seedVideo } from './helpers';
import { loadApp, makeApiKey } from '../helpers/app';
import { validateUploadAuth } from '../../src/utils/uploadAuth';
import { UploadLimiter } from '../../src/utils/uploadLimits';
import type { Database } from '../../src/database/mongodb';

// validateUploadAuth against a real (in-memory) MongoDB: the one gate every
// upload path (TUS pre-create, /upload/simple, /upload/chunk/create) goes through.

process.env.UPLOAD_LIMIT_EXEMPT = 'listedowner';
// The limit wiring here (token reuse, VODs, replacements) is driven through the
// free plan's 1 video a day, so this file caps free uploads; the default (free
// Hive accounts uncapped) has its own test below.
process.env.UPLOAD_LIMIT_FREE_UPLOADS_CAPPED = 'true';
const fetchStub = installFetchStub({ incubating: ['warmupkid', 'graduated'], hiveAccounts: ['graduated'] });

let database: Database;
let config: any;
let key: string;
let inactiveKey: string;

beforeAll(async () => {
  ({ database, config } = await loadApp());
  key = await makeApiKey(database);
  inactiveKey = await makeApiKey(database, { active: false });
});

const SIZE = 1000;
const auth = (headers: Record<string, string[]>, metadata: Record<string, string> = {}, isPartial = false, size: number | null = SIZE, limiter?: UploadLimiter) =>
  validateUploadAuth(headers, metadata, size, database, config, isPartial, limiter);
const bearer = (t: string) => ({ Authorization: [`Bearer ${t}`] });

describe('credentials', () => {
  it('requires an API key or an upload token', async () => {
    expect(await auth({})).toEqual({ ok: false, status: 401, error: 'API key or upload token required' });
    expect(await auth({ authorization: ['Basic abc'] })).toMatchObject({ status: 401 });
  });

  it('rejects unknown and inactive API keys', async () => {
    expect(await auth({ 'x-api-key': ['sk_nope'] })).toMatchObject({ ok: false, status: 401, error: 'Invalid or inactive API key' });
    expect(await auth({ 'X-Api-Key': [inactiveKey] })).toMatchObject({ ok: false, status: 401 });
  });

  it('ignores a bearer token when no secret is configured', async () => {
    const saved = config.uploadTokenSecret;
    config.uploadTokenSecret = '';
    try {
      const { token } = mintToken(saved);
      expect(await auth(bearer(token))).toMatchObject({ status: 401, error: 'API key or upload token required' });
    } finally {
      config.uploadTokenSecret = saved;
    }
  });

  it('rejects bad, expired and finalize tokens', async () => {
    expect(await auth(bearer('garbage'))).toMatchObject({ status: 401, error: 'Invalid or expired upload token' });
    const now = Math.floor(Date.now() / 1000);
    expect(await auth(bearer(mintToken(config.uploadTokenSecret, { exp: now - 5 }).token))).toMatchObject({ status: 401 });
    const fin = mintToken(config.uploadTokenSecret, { scope: 'finalize' });
    expect(await auth(bearer(fin.token))).toEqual({ ok: false, status: 403, error: 'This token cannot be used to upload' });
    // Rejected before consumption: the finalize token's jti was never burned.
    expect(await database.consumeUploadToken(fin.claims.jti, new Date(fin.claims.exp * 1000))).toBe(true);
  });

  it('enforces the token\'s allowed origins', async () => {
    const t = mintToken(config.uploadTokenSecret, { owner: owner(), allowedOrigins: ['https://ok.test'] });
    expect(await auth(bearer(t.token))).toMatchObject({ status: 403, error: 'Origin not allowed for this upload token' });
    expect(await auth({ ...bearer(t.token), Origin: ['https://evil.test'] })).toMatchObject({ status: 403 });
    expect(await auth({ ...bearer(t.token), Origin: ['https://ok.test'] })).toMatchObject({ ok: true });
  });

  it('enforces the token\'s size limit, except on partial uploads', async () => {
    const t = mintToken(config.uploadTokenSecret, { owner: owner(), maxFileSize: 100 });
    expect(await auth(bearer(t.token), {}, false, 101)).toEqual({ ok: false, status: 413, error: 'File size exceeds token limit' });
    expect(await auth(bearer(t.token), {}, true, 101)).toMatchObject({ ok: true });
    expect(await auth(bearer(t.token), {}, false, 100)).toMatchObject({ ok: true });
  });
});

describe('token claims and metadata', () => {
  it('takes owner, permlink, app, short, gated and deferral from the signed claims', async () => {
    const who = owner();
    const t = mintToken(config.uploadTokenSecret, {
      owner: who, app: 'signed-app', short: true, gated: true, allowlist: ['guest1'], deferEncode: true, permlink: 'tokperm1',
    });
    const r = await auth(bearer(t.token), { owner: 'spoof', permlink: 'spoofed', frontend_app: 'x', short: 'false', filename: 'a.mp4', duration: '12.5' });
    expect(r).toEqual({
      ok: true, owner: who, permlink: 'tokperm1', frontend_app: 'signed-app', short: true, gated: true,
      allowlist: ['guest1'], deferEncode: true, originalFilename: 'a.mp4', duration: 12.5, size: SIZE,
      streamVod: undefined, replacesExisting: null,
    });
    // The user row is created on first upload.
    expect(await rawDb(database).collection('embed-users').findOne({ username: who })).toMatchObject({ banned: false, premium: false });
  });

  it('never lets an API-key caller declare gating, allowlists or deferral', async () => {
    const who = owner();
    const r = await auth({ 'x-api-key': [key] }, { owner: who, gated: 'true', allowlist: 'x', defer_encode: 'true', short: 'true', permlink: 'akperm1', frontend_app: 'app1' }, false, null);
    expect(r).toMatchObject({ ok: true, owner: who, permlink: 'akperm1', frontend_app: 'app1', short: true, gated: false, allowlist: [], deferEncode: false, size: null, duration: null, originalFilename: null });
  });

  it('drops an allowlist on a token that is not gated', async () => {
    const t = mintToken(config.uploadTokenSecret, { owner: owner(), allowlist: ['guest1'] });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true, gated: false, allowlist: [] });
  });

  it('falls back to metadata username, then "unknown", and generates a permlink', async () => {
    const who = owner();
    const r1 = await auth({ 'x-api-key': [key] }, { username: who });
    expect(r1).toMatchObject({ ok: true, owner: who, frontend_app: 'unknown', short: false });
    expect((r1 as any).permlink).toMatch(/^[a-z0-9]+$/);
    await rawDb(database).collection('embed-users').deleteOne({ username: 'unknown' });
    const r2 = await auth({ 'x-api-key': [key] }, {}, true);
    expect(r2).toMatchObject({ ok: true, owner: 'unknown' });
    // Partial uploads touch no user rows.
    expect(await rawDb(database).collection('embed-users').findOne({ username: 'unknown' })).toBeNull();
  });

  it('refuses banned users', async () => {
    const who = owner();
    expect(await auth({ 'x-api-key': [key] }, { owner: who })).toMatchObject({ ok: true });
    await database.banUser(who, true);
    expect(await auth({ 'x-api-key': [key] }, { owner: who })).toEqual({ ok: false, status: 403, error: 'User is banned from uploading' });
  });
});

describe('single-use tokens', () => {
  it('consumes the token once; a second upload with it is refused', async () => {
    const t = mintToken(config.uploadTokenSecret, { owner: owner() });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true });
    expect(await auth(bearer(t.token))).toEqual({ ok: false, status: 403, error: 'Upload token has already been used' });
  });

  it('a client-chosen permlink that is taken is a 409; a token-bound one is left to the token check', async () => {
    const who = owner();
    const taken = await seedVideo(database, who, { agoMs: 25 * 60 * 60 * 1000 }); // outside the daily window
    expect(await auth({ 'x-api-key': [key] }, { owner: who, permlink: taken })).toEqual({
      ok: false, status: 409, error: 'A video with this permlink already exists',
    });
    // Partial pieces never create a row, so they are not checked.
    expect(await auth({ 'x-api-key': [key] }, { owner: who, permlink: taken }, true)).toMatchObject({ ok: true });
    // A legacy token without a bound permlink uses the metadata one: checked
    // before the token is consumed, so it stays usable.
    const t = mintToken(config.uploadTokenSecret, { owner: who, permlink: undefined });
    expect(await auth(bearer(t.token), { permlink: taken })).toMatchObject({ ok: false, status: 409 });
    expect(await auth(bearer(t.token), { permlink: `${taken}2` })).toMatchObject({ ok: true, permlink: `${taken}2` });
  });

  it('partial uploads do not consume it', async () => {
    const t = mintToken(config.uploadTokenSecret, { owner: owner() });
    expect(await auth(bearer(t.token), {}, true)).toMatchObject({ ok: true });
    expect(await auth(bearer(t.token), {}, true)).toMatchObject({ ok: true });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true });
    expect(await auth(bearer(t.token))).toMatchObject({ status: 403 });
  });

  it('a refusal by the daily limit leaves the token usable', async () => {
    const who = owner();
    const seeded = await seedVideo(database, who);
    const t = mintToken(config.uploadTokenSecret, { owner: who });
    const refused = await auth(bearer(t.token));
    expect(refused).toMatchObject({ ok: false, status: 429, error: 'Daily video upload limit reached' });
    await rawDb(database).collection('embed-video').deleteOne({ permlink: seeded });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true, owner: who });
  });
});

describe('daily upload limit', () => {
  it('refuses a non-Pro owner at the limit with body and Retry-After', async () => {
    const who = owner();
    await seedVideo(database, who, { agoMs: 60 * 60 * 1000 });
    const r = await auth({ 'x-api-key': [key] }, { owner: who });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'daily_upload_limit', kind: 'video', limit: 1, used: 1 });
    expect(Number(r.headers!['Retry-After'])).toBeGreaterThan(22 * 3600);
    // Shorts have their own allowance.
    expect(await auth({ 'x-api-key': [key] }, { owner: who, short: 'true' })).toMatchObject({ ok: true, short: true });
  });

  it('counts Alice, @alice and alice as one owner', async () => {
    const who = owner();
    const first = await auth({ 'x-api-key': [key] }, { owner: who.toUpperCase() });
    expect(first).toMatchObject({ ok: true, owner: who });
    if (!first.ok) return;
    await seedVideo(database, who, { permlink: `${first.permlink}x` });
    expect(await auth({ 'x-api-key': [key] }, { owner: `@${who}` })).toMatchObject({ ok: false, status: 429 });
    expect(await auth({ 'x-api-key': [key] }, { owner: ` ${who.toUpperCase()} ` })).toMatchObject({ ok: false, status: 429 });
  });

  it('does not count failed or in-flight uploads, or uploads older than 24h', async () => {
    const who = owner();
    await seedVideo(database, who, { status: 'failed' });
    await seedVideo(database, who, { status: 'uploading' });
    await seedVideo(database, who, { agoMs: 25 * 60 * 60 * 1000 });
    expect(await auth({ 'x-api-key': [key] }, { owner: who })).toMatchObject({ ok: true });
  });

  it('exempts Pro and listed owners, gives warm-up owners their own limit, not graduated ones', async () => {
    const pro = owner();
    await seedVideo(database, pro);
    // Refused while free (the user row is created on the way)...
    expect(await auth({ 'x-api-key': [key] }, { owner: pro })).toMatchObject({ status: 429 });
    // ...and let through once Pro, even past the limit.
    await seedVideo(database, pro);
    await database.setUserPremium(pro, true);
    expect(await auth({ 'x-api-key': [key] }, { owner: pro })).toMatchObject({ ok: true });

    await seedVideo(database, 'listedowner');
    expect(await auth({ 'x-api-key': [key] }, { owner: 'listedowner' })).toMatchObject({ ok: true });

    await seedVideo(database, 'warmupkid');
    expect(await auth({ 'x-api-key': [key] }, { owner: 'warmupkid' })).toMatchObject({ ok: true });

    await seedVideo(database, 'graduated');
    expect(await auth({ 'x-api-key': [key] }, { owner: 'graduated' })).toMatchObject({ status: 429 });
    expect(fetchStub).toHaveBeenCalled();
  });

  it('by default never caps a free Hive account, and still caps a warm-up one', async () => {
    config.uploadLimits.freeUploadsCapped = false;
    try {
      const who = owner();
      for (let i = 0; i < 4; i++) await seedVideo(database, who);
      expect(await auth({ 'x-api-key': [key] }, { owner: who })).toMatchObject({ ok: true });
      const t = mintToken(config.uploadTokenSecret, { owner: who, short: true });
      for (let i = 0; i < 4; i++) await seedVideo(database, who, { short: true });
      expect(await auth(bearer(t.token))).toMatchObject({ ok: true });
      // `graduated` is a Hive account now: a free one, so uncapped too.
      expect(await auth({ 'x-api-key': [key] }, { owner: 'graduated' })).toMatchObject({ ok: true });
      for (let i = 0; i < 3; i++) await seedVideo(database, 'warmupkid');
      expect(await auth({ 'x-api-key': [key] }, { owner: 'warmupkid' })).toMatchObject({ ok: false, status: 429, body: { plan: 'warmup', limit: 3 } });
    } finally {
      config.uploadLimits.freeUploadsCapped = true;
    }
  });

  it('uses an injected limiter when given one', async () => {
    const check = vi.fn(async () => null);
    const r = await auth({ 'x-api-key': [key] }, { owner: owner() }, false, SIZE, { check } as any);
    expect(r.ok).toBe(true);
    expect(check).toHaveBeenCalledWith(expect.any(String), 'video');
  });
});

describe('stream VODs', () => {
  const vod = (who: string, permlink: string, extra: Record<string, string> = {}) =>
    auth({ 'x-api-key': [key] }, { owner: who, permlink, frontend_app: '3speak-hangouts', ...extra });

  it('a verified recording is marked and never limited', async () => {
    const who = owner();
    await seedVideo(database, who);
    await rawDb(database).collection('stream-stats').insertOne({ host: who, roomName: 'room-a' });
    await rawDb(database).collection('stream-golive').insertOne({ owner: who, roomName: 'room-b' });
    expect(await vod(who, 'room-a')).toMatchObject({ ok: true, streamVod: true });
    expect(await vod(who, 'room-b')).toMatchObject({ ok: true, streamVod: true });
  });

  it('an unverified claim is recorded as false and limited like a video', async () => {
    const who = owner();
    expect(await vod(who, 'no-such-room')).toMatchObject({ ok: true, streamVod: false });
    await seedVideo(database, who);
    expect(await vod(who, 'no-such-room-2')).toMatchObject({ ok: false, status: 429 });
  });

  it('a failed lookup lets the upload through with no verdict', async () => {
    const who = owner();
    await seedVideo(database, who);
    const spy = vi.spyOn(database, 'streamRecordExists').mockRejectedValueOnce(new Error('mongo blip'));
    expect(await vod(who, 'room-x')).toMatchObject({ ok: true, streamVod: undefined });
    spy.mockRestore();
  });

  it('shorts and token uploads are never VOD claims', async () => {
    const who = owner();
    expect(await vod(who, 'r1', { short: 'true' })).toMatchObject({ ok: true, streamVod: undefined });
    const t = mintToken(config.uploadTokenSecret, { owner: who, app: '3speak-hangouts' });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true, streamVod: undefined });
  });
});

describe('media replacements', () => {
  it('a verified replacement (token or metadata) is free and recorded', async () => {
    const who = owner();
    const target = await seedVideo(database, who);
    const t = mintToken(config.uploadTokenSecret, { owner: who, replaces: target });
    expect(await auth(bearer(t.token))).toMatchObject({ ok: true, replacesExisting: target });
    expect(await auth({ 'x-api-key': [key] }, { owner: who, replaces: ` ${target} ` })).toMatchObject({ ok: true, replacesExisting: target });
  });

  it('accepts a legacy video of the same owner', async () => {
    const who = owner();
    await seedVideo(database, who);
    await rawDb(database).collection('videos').insertOne({ owner: who, permlink: 'legacy-perm' });
    expect(await auth({ 'x-api-key': [key] }, { owner: who, replaces: 'legacy-perm' })).toMatchObject({ ok: true, replacesExisting: 'legacy-perm' });
  });

  it('someone else\'s video, a missing one or itself is an ordinary (limited) upload', async () => {
    const who = owner();
    const other = await seedVideo(database, owner('other'));
    await seedVideo(database, who);
    expect(await auth({ 'x-api-key': [key] }, { owner: who, replaces: other })).toMatchObject({ status: 429 });
    expect(await auth({ 'x-api-key': [key] }, { owner: who, replaces: 'missing' })).toMatchObject({ status: 429 });
    expect(await auth({ 'x-api-key': [key] }, { owner: who, permlink: 'same', replaces: 'same' })).toMatchObject({ status: 429 });
  });

  it('a failed target lookup lets the upload through unrecorded', async () => {
    const who = owner();
    await seedVideo(database, who);
    const spy = vi.spyOn(database, 'getVideo').mockRejectedValueOnce(new Error('mongo blip'));
    expect(await auth({ 'x-api-key': [key] }, { owner: who, replaces: 'whatever' })).toMatchObject({ ok: true, replacesExisting: null });
    spy.mockRestore();
  });

  it('partial uploads skip the replacement check', async () => {
    const spy = vi.spyOn(database, 'getVideo');
    expect(await auth({ 'x-api-key': [key] }, { owner: owner(), replaces: 'x' }, true)).toMatchObject({ ok: true, replacesExisting: null });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
