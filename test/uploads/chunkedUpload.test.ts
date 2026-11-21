import { describe, it, expect, vi, beforeAll } from 'vitest';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { installFetchStub, mintToken, owner, rawDb, seedVideo } from './helpers';
import { api, loadApp, makeApiKey } from '../helpers/app';
import type { Database } from '../../src/database/mongodb';

// The chunked (resumable, no-PATCH) upload: probe, create, chunk, status, finish,
// and the idle-session reaper.

const ipfs = vi.hoisted(() => ({ pinned: [] as { path: string; bytes: Buffer }[] }));
vi.mock('../../src/utils/ipfs', async () => {
  const fs = await import('fs');
  return {
    pinFile: vi.fn(async (p: string) => {
      ipfs.pinned.push({ path: p, bytes: fs.readFileSync(p) });
      return { cid: `bafychunk${ipfs.pinned.length}`, endpoint: 'http://ipfs.test' };
    }),
    announceDHT: vi.fn(async () => undefined),
    unpinFile: vi.fn(async () => undefined),
  };
});

const GB = 1024 * 1024 * 1024;
process.env.MAX_UPLOAD_SIZE = String(30 * GB);
installFetchStub();

let database: Database;
let config: any;
let mod: any;
let key: string;

beforeAll(async () => {
  ({ database, config, mod } = await loadApp());
  key = await makeApiKey(database);
});

const MIN = 256 * 1024;
const SIZE = 600_000; // 3 chunks of 256 KiB: 262144 + 262144 + 75712
const DATA = randomBytes(SIZE);
const piece = (i: number, chunkSize = MIN) => DATA.subarray(i * chunkSize, Math.min(SIZE, (i + 1) * chunkSize));

async function create(fields: Record<string, string>, headers: Record<string, string> = { 'X-API-Key': key }) {
  const r = (await api()).post('/upload/chunk/create');
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  for (const [k, v] of Object.entries(fields)) r.field(k, v);
  return r;
}
async function sendChunk(sessionId: string, index: number | string, buf: Buffer | null) {
  const r = (await api()).post('/upload/chunk').field('sessionId', sessionId).field('index', String(index));
  return buf ? r.attach('chunk', buf, 'blob') : r;
}
const status = async (sessionId: string) => (await api()).post('/upload/chunk/status').field('sessionId', sessionId);
const finish = async (sessionId: string) => (await api()).post('/upload/chunk/finish').field('sessionId', sessionId);
const newSession = async (extra: Record<string, string> = {}) => {
  const res = await create({ owner: owner(), size: String(SIZE), chunkSize: String(MIN), filename: 'c.mp4', ...extra });
  expect(res.status).toBe(201);
  return res.body;
};

describe('POST /upload/probe', () => {
  it('drains the blob and reports its size', async () => {
    const res = await (await api()).post('/upload/probe').attach('chunk', Buffer.alloc(1000), 'p');
    expect(res.body).toEqual({ ok: true, bytes: 1000 });
    const empty = await (await api()).post('/upload/probe').field('x', '1');
    expect(empty.body).toEqual({ ok: true, bytes: 0 });
  });

  it('refuses a probe over 512 KiB and non-multipart bodies', async () => {
    const big = await (await api()).post('/upload/probe').attach('chunk', Buffer.alloc(600 * 1024), 'p');
    expect(big.status).toBe(413);
    expect(big.body.error).toBe(`Chunk exceeds ${512 * 1024} bytes`);
    expect((await (await api()).post('/upload/probe').send({})).status).toBe(400);
  });
});

describe('POST /upload/chunk/create', () => {
  it('validates size and chunkSize', async () => {
    expect((await (await api()).post('/upload/chunk/create').send({ size: 1 })).body).toEqual({ error: 'Expected multipart/form-data' });
    expect((await create({ owner: 'a' })).body.error).toBe('size (total bytes) is required');
    expect((await create({ owner: 'a', size: '-3' })).status).toBe(400);
    const tooBig = await create({ owner: 'a', size: String(31 * GB), chunkSize: String(MIN) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toBe('Video exceeds the maximum allowed size of 30GB');
    expect((await create({ owner: 'a', size: '1000' })).body.error).toMatch(/^chunkSize must be between/);
    expect((await create({ owner: 'a', size: '1000', chunkSize: String(MIN - 1) })).status).toBe(400);
    expect((await create({ owner: 'a', size: '1000', chunkSize: String(64 * 1024 * 1024 + 1) })).status).toBe(400);
    const many = await create({ owner: 'a', size: String(27 * GB), chunkSize: String(MIN), probed: '1' });
    expect(many.status).toBe(400);
    expect(many.body.error).toBe('chunkSize too small for this file (too many chunks)');
  });

  it('refuses without valid credentials', async () => {
    const res = await create({ owner: 'a', size: String(SIZE), chunkSize: String(MIN) }, {});
    expect(res.status).toBe(401);
    const badTok = await create({ token: 'nope', size: String(SIZE), chunkSize: String(MIN) }, {});
    expect(badTok.body).toEqual({ error: 'Invalid or expired upload token' });
  });

  it('refuses past the daily limit with 429 and Retry-After', async () => {
    const who = owner();
    await seedVideo(database, who);
    const res = await create({ owner: who, size: String(SIZE), chunkSize: String(MIN) });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'daily_upload_limit', kind: 'video', used: 1 });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('clamps an unprobed chunk size and pre-sizes the temp file', async () => {
    const who = owner();
    const res = await create({ owner: who, size: String(SIZE), chunkSize: String(1024 * 1024), filename: 'x.mp4', duration: '9', frontend_app: '3speak-tv' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, chunkSize: MIN, totalChunks: 3, received: [], owner: who });
    expect(res.body.sessionId).toMatch(/^[0-9a-f]{48}$/);
    expect(res.body.embed_url).toBe(`${config.baseUrl}?v=${who}/${res.body.permlink}`);
    const s = mod.chunkSessions.get(res.body.sessionId);
    expect(statSync(s.tempPath).size).toBe(SIZE);
    expect(await database.getVideo(res.body.permlink)).toMatchObject({
      owner: who, status: 'uploading', size: SIZE, duration: 9, originalFilename: 'x.mp4', listed_on_3speak: true,
    });
  });

  it('trusts a probed chunk size', async () => {
    const res = await create({ owner: owner(), size: String(SIZE), chunkSize: String(1024 * 1024), probed: '1' });
    expect(res.body).toMatchObject({ chunkSize: 1024 * 1024, totalChunks: 1 });
  });

  it('takes owner and permlink from an upload token, and records a verified replacement', async () => {
    const who = owner();
    const target = await seedVideo(database, who);
    const { token, claims } = mintToken(config.uploadTokenSecret, { owner: who, replaces: target, app: '3speak-tv' });
    const res = await create({ token, owner: 'spoof', size: String(SIZE), chunkSize: String(MIN) }, { Origin: 'https://app.test' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ owner: who, permlink: claims.permlink });
    expect(await database.getVideo(claims.permlink!)).toMatchObject({ replaces_existing: true, replaces_target: target, listed_on_3speak: false });
    // The token was consumed at create.
    expect((await create({ token, size: String(SIZE), chunkSize: String(MIN) }, {})).status).toBe(403);
  });

  it('records a stream VOD verdict', async () => {
    const who = owner();
    await rawDb(database).collection('stream-stats').insertOne({ host: who, roomName: 'chunkroom' });
    const res = await create({ owner: who, permlink: 'chunkroom', frontend_app: '3speak-hangouts', size: String(SIZE), chunkSize: String(MIN) });
    expect(res.status).toBe(201);
    expect(await database.getVideo('chunkroom')).toMatchObject({ stream_vod: true });
  });

  it('answers 500 when the temp file cannot be allocated', async () => {
    const saved = config.uploadDir;
    config.uploadDir = '/nonexistent-embed-test-dir/x';
    try {
      const res = await create({ owner: owner(), size: String(SIZE), chunkSize: String(MIN) });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to allocate upload storage');
    } finally {
      config.uploadDir = saved;
    }
  });
});

describe('chunks, status and finish', () => {
  it('accepts out-of-order chunks, is idempotent on retries, and finishes into the pipeline', async () => {
    const s = await newSession();
    const st0 = await status(s.sessionId);
    expect(st0.body).toEqual({ chunkSize: MIN, totalChunks: 3, receivedBytes: 0, size: SIZE, received: [], finished: false });

    const last = await sendChunk(s.sessionId, 2, piece(2));
    expect(last.body).toEqual({ index: 2, receivedBytes: SIZE - 2 * MIN, size: SIZE, complete: false });
    const early = await finish(s.sessionId);
    expect(early.status).toBe(400);
    expect(early.body).toMatchObject({ received: [2] });
    expect(early.body.error).toMatch(/^Upload incomplete: 1\/3 chunks/);

    expect((await sendChunk(s.sessionId, 0, piece(0))).body.complete).toBe(false);
    // Retried chunk whose ack was lost: same answer, not counted twice.
    const again = await sendChunk(s.sessionId, 0, piece(0));
    expect(again.status).toBe(200);
    expect(again.body.receivedBytes).toBe(SIZE - MIN);
    const mid = await sendChunk(s.sessionId, 1, piece(1));
    expect(mid.body).toEqual({ index: 1, receivedBytes: SIZE, size: SIZE, complete: true });

    const st = await status(s.sessionId);
    expect(st.body.received.sort()).toEqual([0, 1, 2]);
    expect(st.body.receivedBytes).toBe(SIZE);

    const done = await finish(s.sessionId);
    expect(done.status).toBe(201);
    expect(done.body).toEqual({ success: true, embed_url: s.embed_url, permlink: s.permlink, owner: s.owner });
    expect(mod.chunkSessions.has(s.sessionId)).toBe(false);

    await vi.waitFor(async () => expect((await database.getVideo(s.permlink))?.status).toBe('processing'), { timeout: 3000, interval: 20 });
    const pinned = ipfs.pinned.at(-1)!;
    expect(pinned.bytes.equals(DATA)).toBe(true);
    await vi.waitFor(() => expect(existsSync(pinned.path)).toBe(false));
    expect(await rawDb(database).collection('embed-jobs').findOne({ permlink: s.permlink })).toMatchObject({ status: 'pending', fileSize: SIZE });

    // The session is gone after finish.
    expect((await status(s.sessionId)).status).toBe(404);
    expect((await finish(s.sessionId)).status).toBe(404);
  });

  it('validates chunk requests', async () => {
    const s = await newSession();
    expect((await sendChunk('nope', 0, piece(0))).status).toBe(404);
    expect((await sendChunk(s.sessionId, 0, null)).body).toEqual({ error: 'No chunk data' });
    expect((await sendChunk(s.sessionId, 3, piece(0))).body).toEqual({ error: 'index out of range (0..2)' });
    expect((await sendChunk(s.sessionId, -1, piece(0))).status).toBe(400);
    expect((await sendChunk(s.sessionId, 'x', piece(0))).status).toBe(400);
    const short = await sendChunk(s.sessionId, 0, piece(0).subarray(0, 100));
    expect(short.body).toEqual({ error: `chunk 0 must be ${MIN} bytes, got 100` });
    expect((await sendChunk(s.sessionId, 2, piece(1))).body.error).toBe(`chunk 2 must be ${SIZE - 2 * MIN} bytes, got ${MIN}`);
    expect((await (await api()).post('/upload/chunk').send({})).status).toBe(400);
  });

  it('refuses chunks for a finished session and re-answers finish', async () => {
    const s = await newSession();
    const sess = mod.chunkSessions.get(s.sessionId);
    sess.finished = true;
    const res = await sendChunk(s.sessionId, 0, piece(0));
    expect(res.status).toBe(409);
    const fin = await finish(s.sessionId);
    expect(fin.status).toBe(200);
    expect(fin.body).toEqual({ success: true, embed_url: s.embed_url, permlink: s.permlink, owner: s.owner });
    mod.chunkSessions.delete(s.sessionId);
    unlinkSync(sess.tempPath);
  });

  it('answers 500 when the chunk cannot be written', async () => {
    const s = await newSession();
    unlinkSync(mod.chunkSessions.get(s.sessionId).tempPath);
    const res = await sendChunk(s.sessionId, 0, piece(0));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Chunk write failed');
    mod.chunkSessions.delete(s.sessionId);
  });

  it('status, chunk and finish need multipart bodies and a known session', async () => {
    expect((await (await api()).post('/upload/chunk/status').send({})).status).toBe(400);
    expect((await (await api()).post('/upload/chunk/finish').send({})).status).toBe(400);
    expect((await status('missing')).body).toEqual({ error: 'Unknown or expired session' });
  });
});

describe('reapChunkSessions', () => {
  it('drops idle sessions, removes their files and fails unfinished uploads', async () => {
    const idle = await newSession();
    const finishedIdle = await newSession();
    const fresh = await newSession();
    const idleS = mod.chunkSessions.get(idle.sessionId);
    const finS = mod.chunkSessions.get(finishedIdle.sessionId);
    const now = Date.now();
    idleS.updatedAt = now - 3 * 60 * 60 * 1000;
    finS.updatedAt = now - 3 * 60 * 60 * 1000;
    finS.finished = true;
    // An idle session whose file is already gone is still reaped.
    unlinkSync(finS.tempPath);

    mod.reapChunkSessions(now);

    expect(mod.chunkSessions.has(idle.sessionId)).toBe(false);
    expect(mod.chunkSessions.has(finishedIdle.sessionId)).toBe(false);
    expect(mod.chunkSessions.has(fresh.sessionId)).toBe(true);
    expect(existsSync(idleS.tempPath)).toBe(false);
    await vi.waitFor(async () => expect((await database.getVideo(idle.permlink))?.status).toBe('failed'));
    expect((await database.getVideo(finishedIdle.permlink))?.status).toBe('uploading');
    expect((await database.getVideo(fresh.permlink))?.status).toBe('uploading');

    // Default clock: nothing is idle yet.
    mod.reapChunkSessions();
    expect(mod.chunkSessions.has(fresh.sessionId)).toBe(true);
    // Only the fresh session's file is left from this test.
    const tempFiles = readdirSync(config.uploadDir).filter((f) => f.startsWith('chunked-'));
    expect(tempFiles).toContain(mod.chunkSessions.get(fresh.sessionId).tempPath.split('/').pop());
  });
});
