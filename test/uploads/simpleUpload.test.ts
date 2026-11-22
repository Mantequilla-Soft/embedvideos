import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { installFetchStub, mintToken, owner, rawDb, seedVideo } from './helpers';
import { api, loadApp, makeApiKey } from '../helpers/app';
import type { Database } from '../../src/database/mongodb';

// POST /upload/simple: one multipart request, then the async pin -> job pipeline.

const ipfs = vi.hoisted(() => ({
  pinned: [] as { path: string; bytes: Buffer }[],
  fail: false,
  /** Remove the file while "pinning", so the pipeline's temp-file cleanup finds nothing. */
  steal: false,
}));
vi.mock('../../src/utils/ipfs', async () => {
  const fs = await import('fs');
  return {
    pinFile: vi.fn(async (p: string) => {
      if (ipfs.fail) throw new Error('kubo down');
      ipfs.pinned.push({ path: p, bytes: fs.readFileSync(p) });
      if (ipfs.steal) fs.unlinkSync(p);
      return { cid: `bafy${ipfs.pinned.length}`, endpoint: 'http://ipfs.test' };
    }),
    announceDHT: vi.fn(async () => { throw new Error('dht slow'); }),
    unpinFile: vi.fn(async () => undefined),
  };
});

process.env.MAX_UPLOAD_SIZE = '4096';
installFetchStub();

let database: Database;
let config: any;
let key: string;

beforeAll(async () => {
  ({ database, config } = await loadApp());
  key = await makeApiKey(database);
});
beforeEach(() => { ipfs.fail = false; ipfs.steal = false; });

const leftovers = () => readdirSync(config.uploadDir).filter((f) => f.startsWith('simple-'));
const video = (permlink: string) => database.getVideo(permlink);
const waitStatus = (permlink: string, status: string) =>
  vi.waitFor(async () => expect((await video(permlink))?.status).toBe(status), { timeout: 3000, interval: 20 });
const FILE = Buffer.alloc(1500, 7);

describe('POST /upload/simple', () => {
  it('needs a multipart body', async () => {
    const res = await (await api()).post('/upload/simple').send({ a: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Expected multipart/form-data');
  });

  it('needs a file part', async () => {
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key).field('owner', owner());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file part in request');
  });

  it('reports a malformed body', async () => {
    const res = await (await api()).post('/upload/simple')
      .set('Content-Type', 'multipart/form-data; boundary=XYZ')
      .send('--XYZ\r\nContent-Disposition: form-data; name="a"\r\n\r\nval');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Upload parse error/);
  });

  it('refuses a file over the size limit and removes the temp file', async () => {
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', owner()).attach('file', Buffer.alloc(5000), 'big.mp4');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/maximum allowed size/);
    expect(leftovers()).toEqual([]);
  });

  it('refuses without credentials and removes the temp file', async () => {
    const res = await (await api()).post('/upload/simple').field('owner', owner()).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'API key or upload token required' });
    expect(leftovers()).toEqual([]);
  });

  it('uploads with a token, then pins, queues a job and cleans up', async () => {
    const who = owner();
    const issued = await (await api()).post('/uploads/token').set('X-API-Key', key).send({ owner: who, frontend_app: '3speak-tv' });
    expect(issued.status).toBe(201);
    const res = await (await api()).post('/upload/simple')
      .set('Origin', 'https://app.test').set('X-Forwarded-For', '203.0.113.9')
      .field('token', issued.body.token).field('owner', 'spoofed').field('duration', '42')
      .attach('file', FILE, 'clip.mp4');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, embed_url: issued.body.embed_url, permlink: issued.body.permlink, owner: who });

    const row = await video(res.body.permlink);
    expect(row).toMatchObject({
      owner: who, frontend_app: '3speak-tv', short: false, gated: false, gate_video_id: null, defer_encode: false,
      duration: 42, size: FILE.length, originalFilename: 'clip.mp4', listed_on_3speak: true,
    });
    expect((row as any).replaces_existing).toBeUndefined();

    await waitStatus(res.body.permlink, 'processing');
    const done = await video(res.body.permlink);
    expect(done?.input_cid).toMatch(/^bafy/);
    expect(ipfs.pinned.at(-1)!.bytes.equals(FILE)).toBe(true);
    await vi.waitFor(async () => {
      expect(await rawDb(database).collection('embed-jobs').findOne({ permlink: res.body.permlink })).toMatchObject({ owner: who, status: 'pending', premium: false, short: false, fileSize: FILE.length });
      expect(leftovers()).toEqual([]);
    });
    const user = await rawDb(database).collection('embed-users').findOne({ username: who });
    expect(user?.stats?.totalUploads).toBe(1);
  });

  it('refuses a reused token', async () => {
    // A short, so the owner still has allowance left and the reuse check is what answers
    // (the daily limit is checked before the token is consumed).
    const { token } = mintToken(config.uploadTokenSecret, { owner: owner(), short: true });
    const send = async () => (await api()).post('/upload/simple').field('token', token).attach('file', FILE, 'a.mp4');
    expect((await send()).status).toBe(201);
    const again = await send();
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('Upload token has already been used');
  });

  it('uploads with an API key and metadata fields', async () => {
    const who = owner();
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', who).field('short', 'true').field('permlink', 'simpleperm1').field('frontend_app', 'other-app')
      .field('filename', 'named.mp4')
      .attach('file', FILE, 'ignored.mp4');
    expect(res.status).toBe(201);
    expect(res.body.permlink).toBe('simpleperm1');
    expect(await video('simpleperm1')).toMatchObject({ owner: who, short: true, frontend_app: 'other-app', originalFilename: 'named.mp4', listed_on_3speak: false });
    await waitStatus('simpleperm1', 'processing');
  });

  it('refuses past the daily limit with the 429 body and Retry-After', async () => {
    const who = owner();
    await seedVideo(database, who);
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key).field('owner', who).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'daily_upload_limit', kind: 'video' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(leftovers()).toEqual([]);
  });

  it('a verified replacement skips the limit and stays unlisted', async () => {
    const who = owner();
    const target = await seedVideo(database, who);
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', who).field('frontend_app', '3speak-tv').field('replaces', target).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    expect(await video(res.body.permlink)).toMatchObject({ replaces_existing: true, replaces_target: target, listed_on_3speak: false });
  });

  it('records a stream VOD verdict', async () => {
    const who = owner();
    await rawDb(database).collection('stream-golive').insertOne({ owner: who, roomName: 'liveroom1' });
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', who).field('frontend_app', '3speak-hangouts').field('permlink', 'liveroom1').attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    expect(await video('liveroom1')).toMatchObject({ stream_vod: true });
  });

  it('parks a deferred upload awaiting the encode decision', async () => {
    const issued = await (await api()).post('/uploads/token').set('X-API-Key', key).send({ owner: owner(), defer_encode: true });
    const res = await (await api()).post('/upload/simple').field('token', issued.body.token).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    expect((await video(res.body.permlink))?.defer_encode).toBe(true);
    await waitStatus(res.body.permlink, 'awaiting_encode');
    expect(await rawDb(database).collection('embed-jobs').findOne({ permlink: res.body.permlink })).toBeNull();
  });

  it('answers 400 when the temp file cannot be written', async () => {
    const saved = config.uploadDir;
    config.uploadDir = '/nonexistent-embed-test-dir/x';
    try {
      const res = await (await api()).post('/upload/simple').set('X-API-Key', key).field('owner', owner())
        .attach('file', FILE, 'a.mp4').timeout(3000);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('File write failed');
    } finally {
      config.uploadDir = saved;
    }
  });

  it('queues a gated job from a signed gated claim', async () => {
    const who = owner();
    const { token, claims } = mintToken(config.uploadTokenSecret, { owner: who, gated: true, allowlist: ['guest1'] });
    const res = await (await api()).post('/upload/simple').field('token', token).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    expect(await video(claims.permlink!)).toMatchObject({ gated: true, gate_video_id: claims.permlink, allowlist: ['guest1'] });
    await vi.waitFor(async () =>
      expect(await rawDb(database).collection('embed-jobs').findOne({ permlink: claims.permlink })).toMatchObject({ gated: true, gateVideoId: claims.permlink }),
    { timeout: 3000, interval: 20 });
  });

  it('survives a failing stats update and an already-removed temp file', async () => {
    ipfs.steal = true;
    const spy = vi.spyOn(database, 'incrementUserUpload').mockRejectedValueOnce(new Error('stats down'));
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key).field('owner', owner()).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    await vi.waitFor(async () =>
      expect(await rawDb(database).collection('embed-jobs').findOne({ permlink: res.body.permlink })).not.toBeNull(),
    { timeout: 3000, interval: 20 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    // Deferred variant: parked even though its temp file is already gone.
    const issued = await (await api()).post('/uploads/token').set('X-API-Key', key).send({ owner: owner(), short: true, defer_encode: true });
    const def = await (await api()).post('/upload/simple').field('token', issued.body.token).attach('file', FILE, 'a.mp4');
    expect(def.status).toBe(201);
    await waitStatus(def.body.permlink, 'awaiting_encode');
  });

  it('marks the video failed when pinning fails', async () => {
    ipfs.fail = true;
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key).field('owner', owner()).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    await waitStatus(res.body.permlink, 'failed');
  });
});

describe('POST /upload/simple: errors are answered, never crash the process', () => {
  // Temp files from earlier tests' async pipelines may still be around.
  let before = new Set<string>();
  beforeEach(() => { before = new Set(leftovers()); });
  const newLeftovers = () => leftovers().filter((f) => !before.has(f));

  it('an API-key upload with a permlink that is taken gets a 409 and leaves the row alone', async () => {
    const who = owner();
    const taken = await seedVideo(database, who, { agoMs: 25 * 60 * 60 * 1000 }); // outside the daily window
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', who).field('permlink', taken).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A video with this permlink already exists' });
    expect(await video(taken)).toMatchObject({ status: 'published' });
    expect(newLeftovers()).toEqual([]);
    // Still serving.
    expect((await (await api()).get('/health')).status).toBe(200);
  });

  it('two uploads racing for one permlink: the loser gets a 409 from the insert', async () => {
    const who = owner();
    const taken = await seedVideo(database, who, { agoMs: 25 * 60 * 60 * 1000 }); // outside the daily window
    const spy = vi.spyOn(database, 'videoExists').mockResolvedValueOnce(false);
    try {
      const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
        .field('owner', who).field('permlink', taken).attach('file', FILE, 'a.mp4');
      expect(res.status).toBe(409);
      expect(newLeftovers()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a database error after the body is in is a 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(database, 'createVideoEntry').mockRejectedValueOnce(new Error('mongo down'));
    try {
      const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
        .field('owner', owner()).attach('file', FILE, 'a.mp4');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(newLeftovers()).toEqual([]);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });

  it('checks the credentials before the file is written', async () => {
    const created = vi.spyOn(database, 'createVideoEntry');
    try {
      const res = await (await api()).post('/upload/simple').set('X-API-Key', 'sk_wrong')
        .field('owner', owner()).attach('file', Buffer.alloc(3000, 1), 'a.mp4');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or inactive API key' });
      expect(newLeftovers()).toEqual([]);
      expect(created).not.toHaveBeenCalled();
    } finally {
      created.mockRestore();
    }
  });

  it('stores the owner lowercased, however the client spelled it', async () => {
    const who = owner();
    const res = await (await api()).post('/upload/simple').set('X-API-Key', key)
      .field('owner', ` @${who.toUpperCase()}`).attach('file', FILE, 'a.mp4');
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(who);
    expect(await video(res.body.permlink)).toMatchObject({ owner: who });
    await waitStatus(res.body.permlink, 'processing');
  });
});

