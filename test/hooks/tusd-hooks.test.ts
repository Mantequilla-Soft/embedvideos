import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import type { AddressInfo } from 'net';

process.env.IP_HASH_SECRET = 'test-ip-hash-secret';
process.env.MAX_UPLOAD_SIZE = String(1024 * 1024 * 100); // 100 MiB cap

vi.mock('../../src/utils/ipfs', () => ({
  pinFile: vi.fn(),
  unpinFile: vi.fn(),
  announceDHT: vi.fn(),
}));

import * as ipfs from '../../src/utils/ipfs';
import { api, loadApp, makeApiKey } from '../helpers/app';
import { makeToken, uid, insertVideo, insertUser, waitFor } from './fixtures';

const pinFile = vi.mocked(ipfs.pinFile);
const announceDHT = vi.mocked(ipfs.announceDHT);

let database: any;
let config: any;
let apiKey: string;

// The daily-limit warm-up lookup goes to the checker over fetch. Offline by
// default (fails open); individual tests answer it.
const fetchMock = vi.fn();

beforeAll(async () => {
  ({ database, config } = await loadApp());
  apiKey = await makeApiKey(database);
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  pinFile.mockResolvedValue({ cid: 'QmInputCid', endpoint: 'http://127.0.0.1:5001' });
  announceDHT.mockResolvedValue(undefined);
});

function preCreate(opts: {
  headers?: Record<string, string[]>;
  meta?: Record<string, string>;
  size?: number | null;
  partial?: boolean;
}) {
  return api().then((r) =>
    r.post('/tusd-hooks').send({
      Type: 'pre-create',
      Event: {
        Upload: { Size: opts.size ?? 1000, IsPartial: !!opts.partial, MetaData: opts.meta ?? {} },
        HTTPRequest: { Header: opts.headers ?? {} },
      },
    })
  );
}

function postFinish(upload: Record<string, unknown>) {
  return api().then((r) => r.post('/tusd-hooks').send({ Type: 'post-finish', Event: { Upload: upload } }));
}

function tempFile(name = uid('f')): string {
  const p = path.join(process.env.UPLOAD_DIR!, name);
  writeFileSync(p, 'video bytes');
  return p;
}

describe('POST /tusd-hooks guard', () => {
  it('refuses callers that are not on loopback', async () => {
    const { app } = await loadApp();
    const addr = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|172\.|192\.168\.)/.test(i.address))?.address;
    if (!addr) return; // no private interface on this machine; nothing to prove
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, addr, resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: addr, port, path: '/tusd-hooks', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on('error', reject);
        req.end(JSON.stringify({ Type: 'pre-create', Event: {} }));
      });
      expect(status).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('answers unknown hook types with an empty object', async () => {
    const res = await (await api()).post('/tusd-hooks').send({ Type: 'post-receive', Event: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

describe('pre-create', () => {
  it('rejects an upload without credentials', async () => {
    const res = await preCreate({ meta: { owner: 'alice' } });
    expect(res.body.RejectUpload).toBe(true);
    expect(res.body.HTTPResponse.StatusCode).toBe(401);
    expect(JSON.parse(res.body.HTTPResponse.Body).error).toMatch(/API key or upload token required/);
    // tusd v2 reads `Header`; both spellings are sent.
    expect(res.body.HTTPResponse.Header['Content-Type']).toBe('application/json');
    expect(res.body.HTTPResponse.Headers['Content-Type']).toBe('application/json');
  });

  it('rejects an unknown or inactive API key', async () => {
    const res = await preCreate({ headers: { 'X-Api-Key': ['sk_nope'] }, meta: { owner: 'alice' } });
    expect(res.body.HTTPResponse.StatusCode).toBe(401);

    const inactive = await makeApiKey(database, { active: false });
    const res2 = await preCreate({ headers: { 'X-Api-Key': [inactive] }, meta: { owner: 'alice' } });
    expect(res2.body.HTTPResponse.StatusCode).toBe(401);
  });

  it('creates the video row for an API-key upload, from the metadata', async () => {
    const permlink = uid('api');
    const res = await preCreate({
      headers: { 'X-Api-Key': [apiKey], 'X-Real-IP': ['203.0.113.7'] },
      meta: { owner: 'carol', permlink, frontend_app: '3speak-tv', short: 'true', filename: 'clip.mp4', duration: '12.5', gated: 'true' },
      size: 4242,
    });
    expect(res.body.RejectUpload).toBeUndefined();
    expect(res.body.ChangeFileInfo.MetaData).toEqual({
      permlink,
      owner: 'carol',
      frontend_app: '3speak-tv',
      short: 'true',
      originalFilename: 'clip.mp4',
    });

    const v = await database.getVideo(permlink);
    expect(v).toMatchObject({
      owner: 'carol',
      status: 'uploading',
      short: true,
      size: 4242,
      duration: 12.5,
      originalFilename: 'clip.mp4',
      // An API-key caller cannot declare its own upload paid.
      gated: false,
      gate_video_id: null,
      listed_on_3speak: true,
    });
    expect(v.uploader_ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(v.uploader_net_hash).toMatch(/^[0-9a-f]{32}$/);
    // The user is auto-created on first upload.
    expect(await database.getUser('carol')).toMatchObject({ banned: false, premium: false });
  });

  it('only lists 3speak-tv uploads', async () => {
    const permlink = uid('eco');
    await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'carol', permlink, frontend_app: 'ecency' } });
    expect((await database.getVideo(permlink)).listed_on_3speak).toBe(false);
  });

  it('takes owner/permlink/gating from the signed token and ignores the metadata', async () => {
    const permlink = uid('tok');
    const token = makeToken({ owner: 'dave', permlink, app: 'ecency', short: false, gated: true, allowlist: ['erin'], deferEncode: true });
    const res = await preCreate({
      headers: { Authorization: [`Bearer ${token}`] },
      meta: { owner: 'mallory', permlink: 'other', short: 'true', frontend_app: 'evil' },
    });
    expect(res.body.ChangeFileInfo.MetaData).toMatchObject({ owner: 'dave', permlink, frontend_app: 'ecency', short: 'false' });
    const v = await database.getVideo(permlink);
    expect(v).toMatchObject({ owner: 'dave', gated: true, gate_video_id: permlink, allowlist: ['erin'], defer_encode: true, short: false });
    expect(await database.getVideo('other')).toBeNull();
  });

  it('consumes a token once: a second upload with it is refused', async () => {
    const token = makeToken({ owner: 'dave', permlink: uid('once') });
    const first = await preCreate({ headers: { Authorization: [`Bearer ${token}`] } });
    expect(first.body.RejectUpload).toBeUndefined();
    const second = await preCreate({ headers: { Authorization: [`Bearer ${token}`] } });
    expect(second.body.RejectUpload).toBe(true);
    expect(second.body.HTTPResponse.StatusCode).toBe(403);
    expect(JSON.parse(second.body.HTTPResponse.Body).error).toMatch(/already been used/);
  });

  it('lets partial (parallel chunk) uploads through without a row and without burning the token', async () => {
    const permlink = uid('part');
    const token = makeToken({ owner: 'dave', permlink });
    const part = await preCreate({ headers: { Authorization: [`Bearer ${token}`] }, partial: true });
    expect(part.body).toEqual({});
    expect(await database.getVideo(permlink)).toBeNull();

    const final = await preCreate({ headers: { Authorization: [`Bearer ${token}`] } });
    expect(final.body.ChangeFileInfo.MetaData.permlink).toBe(permlink);
    expect(await database.getVideo(permlink)).not.toBeNull();
  });

  it('refuses tampered, finalize-scope, wrong-origin and oversize tokens', async () => {
    const bad = await preCreate({ headers: { Authorization: [`Bearer ${makeToken()}x`] } });
    expect(bad.body.HTTPResponse.StatusCode).toBe(401);

    const fin = await preCreate({ headers: { Authorization: [`Bearer ${makeToken({ scope: 'finalize' })}`] } });
    expect(fin.body.HTTPResponse.StatusCode).toBe(403);
    expect(JSON.parse(fin.body.HTTPResponse.Body).error).toMatch(/cannot be used to upload/);

    const originToken = makeToken({ allowedOrigins: ['https://3speak.tv'] });
    const wrongOrigin = await preCreate({ headers: { Authorization: [`Bearer ${originToken}`], Origin: ['https://evil.example'] } });
    expect(wrongOrigin.body.HTTPResponse.StatusCode).toBe(403);
    const rightOrigin = await preCreate({ headers: { Authorization: [`Bearer ${originToken}`], Origin: ['https://3speak.tv'] } });
    expect(rightOrigin.body.RejectUpload).toBeUndefined();

    const big = await preCreate({ headers: { Authorization: [`Bearer ${makeToken({ maxFileSize: 100 })}`] }, size: 101 });
    expect(big.body.HTTPResponse.StatusCode).toBe(413);
  });

  it('refuses banned users', async () => {
    await insertUser(database, 'banned1', { banned: true });
    const res = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'banned1', permlink: uid('b') } });
    expect(res.body.HTTPResponse.StatusCode).toBe(403);
    expect(JSON.parse(res.body.HTTPResponse.Body).error).toMatch(/banned/);
  });

  it('enforces the hard size cap for every auth method', async () => {
    const permlink = uid('huge');
    const res = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'carol', permlink }, size: config.maxUploadSize + 1 });
    expect(res.body.RejectUpload).toBe(true);
    expect(res.body.HTTPResponse.StatusCode).toBe(413);
    expect(JSON.parse(res.body.HTTPResponse.Body).error).toMatch(/maximum allowed size/);
    expect(res.body.HTTPResponse.Header['Content-Type']).toBe('application/json');
    expect(await database.getVideo(permlink)).toBeNull();
  });

  it('refuses a taken permlink with a 409 instead of crashing on the insert', async () => {
    const taken = await insertVideo(database, { owner: 'carol', status: 'published' });
    const res = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'carol', permlink: taken.permlink } });
    expect(res.body.RejectUpload).toBe(true);
    expect(res.body.HTTPResponse.StatusCode).toBe(409);
    expect(JSON.parse(res.body.HTTPResponse.Body)).toEqual({ error: 'A video with this permlink already exists' });

    // Lost in a race (the check passed, the insert did not): the same answer.
    const spy = vi.spyOn(database, 'videoExists').mockResolvedValueOnce(false);
    const raced = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'carol', permlink: taken.permlink } });
    spy.mockRestore();
    expect(raced.body.HTTPResponse.StatusCode).toBe(409);
    expect((await database.getVideo(taken.permlink)).status).toBe('published');
  });

  it('answers a database failure with a 500 refusal, not an unhandled rejection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(database, 'createVideoEntry').mockRejectedValueOnce(new Error('mongo down'));
    const res = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'carol', permlink: uid('dbfail') } });
    spy.mockRestore();
    err.mockRestore();
    expect(res.body.RejectUpload).toBe(true);
    expect(res.body.HTTPResponse.StatusCode).toBe(500);
  });

  it('records a verified replacement and keeps it unlisted', async () => {
    const original = await insertVideo(database, { owner: 'frank', status: 'published' });
    const permlink = uid('repl');
    await preCreate({
      headers: { 'X-Api-Key': [apiKey] },
      meta: { owner: 'frank', permlink, frontend_app: '3speak-tv', replaces: original.permlink },
    });
    expect(await database.getVideo(permlink)).toMatchObject({
      replaces_existing: true,
      replaces_target: original.permlink,
      listed_on_3speak: false,
    });
  });

  it('treats a replacement claim on someone else\'s video as an ordinary upload', async () => {
    const original = await insertVideo(database, { owner: 'gina', status: 'published' });
    const permlink = uid('steal');
    await preCreate({
      headers: { 'X-Api-Key': [apiKey] },
      meta: { owner: 'frank', permlink, frontend_app: '3speak-tv', replaces: original.permlink },
    });
    const v = await database.getVideo(permlink);
    expect(v.replaces_existing).toBeUndefined();
    expect(v.listed_on_3speak).toBe(true);
  });

  it('verifies stream VOD claims against the stream records', async () => {
    const room = uid('room');
    await (database as any).db.collection('stream-golive').insertOne({ owner: 'hank', roomName: room });
    await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'hank', permlink: room, frontend_app: '3speak-hangouts' } });
    expect((await database.getVideo(room)).stream_vod).toBe(true);

    const fake = uid('room');
    await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'hank', permlink: fake, frontend_app: '3speak-hangouts' } });
    expect((await database.getVideo(fake)).stream_vod).toBe(false);
  });

  it('passes the daily-limit 429 and its Retry-After through to tusd', async () => {
    // One counted upload already today, the warm-up registry says "not incubating",
    // and Hive has an account `ivan` from long before it (so the upload counts).
    await insertVideo(database, { owner: 'ivan', status: 'published', createdAt: new Date() });
    fetchMock.mockImplementation(async (url: unknown) => new Response(JSON.stringify(
      String(url).includes('/incubation/authors')
        ? { authors: { ivan: { status: 'graduated' } } }
        : { result: [{ name: 'ivan', created: '2020-01-01T00:00:00' }] },
    ), { status: 200 }));
    const permlink = uid('lim');
    const res = await preCreate({ headers: { 'X-Api-Key': [apiKey] }, meta: { owner: 'ivan', permlink } });
    expect(res.body.RejectUpload).toBe(true);
    expect(res.body.HTTPResponse.StatusCode).toBe(429);
    expect(JSON.parse(res.body.HTTPResponse.Body).code).toBe('daily_upload_limit');
    expect(Number(res.body.HTTPResponse.Header['Retry-After'])).toBeGreaterThan(0);
    expect(res.body.HTTPResponse.Headers['Retry-After']).toBe(res.body.HTTPResponse.Header['Retry-After']);
    expect(await database.getVideo(permlink)).toBeNull();
  });
});

describe('pre-finish', () => {
  it('acknowledges whole and partial uploads', async () => {
    const r = await api();
    const whole = await r.post('/tusd-hooks').send({
      Type: 'pre-finish',
      Event: { Upload: { ID: 'abc', IsPartial: false, MetaData: { permlink: 'x', owner: 'y' } } },
    });
    expect(whole.body).toEqual({});
    const part = await r.post('/tusd-hooks').send({ Type: 'pre-finish', Event: { Upload: { ID: 'abd', IsPartial: true } } });
    expect(part.body).toEqual({});
  });
});

describe('post-finish', () => {
  it('pins the file, queues a job, counts the upload and removes the temp file', async () => {
    await insertUser(database, 'pro1', { premium: true });
    const v = await insertVideo(database, { owner: 'pro1' });
    const file = tempFile();
    const res = await postFinish({ IsPartial: false, Size: 777, Storage: { Path: file }, MetaData: { permlink: v.permlink, owner: 'pro1', short: 'true' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    const job = await waitFor(() => database.getJob('pro1', v.permlink));
    expect(job).toMatchObject({ status: 'pending', premium: true, short: true, fileSize: 777, gated: false, gateVideoId: v.permlink, attemptCount: 0 });
    expect(await database.getVideo(v.permlink)).toMatchObject({ status: 'processing', input_cid: 'QmInputCid', ipfs_pin_endpoint: 'http://127.0.0.1:5001', size: 777 });
    expect(pinFile).toHaveBeenCalledWith(file);
    expect(announceDHT).toHaveBeenCalledWith('QmInputCid');
    expect(existsSync(file)).toBe(false);
    const user = await database.getUser('pro1');
    expect(user.stats.totalUploads).toBe(1);
    expect(user.stats.totalStorageUsed).toBe(777);
  });

  it('reads gating from the video row, not the client metadata', async () => {
    const gated = await insertVideo(database, { owner: 'alice', gated: true, gate_video_id: 'gate-id-1' });
    await postFinish({ Size: 10, Storage: { Path: tempFile() }, MetaData: { permlink: gated.permlink, owner: 'alice' } });
    expect(await waitFor(() => database.getJob('alice', gated.permlink))).toMatchObject({ gated: true, gateVideoId: 'gate-id-1', premium: false });

    const plain = await insertVideo(database, { owner: 'alice' });
    await postFinish({ Size: 10, Storage: { Path: tempFile() }, MetaData: { permlink: plain.permlink, owner: 'alice', gated: 'true' } });
    expect(await waitFor(() => database.getJob('alice', plain.permlink))).toMatchObject({ gated: false });
  });

  it('parks a deferred upload at awaiting_encode without a job', async () => {
    const v = await insertVideo(database, { owner: 'alice', defer_encode: true });
    const file = tempFile();
    await postFinish({ Size: 50, Storage: { Path: file }, MetaData: { permlink: v.permlink, owner: 'alice' } });
    const row = await waitFor(async () => {
      const r = await database.getVideo(v.permlink);
      return r.status === 'awaiting_encode' ? r : null;
    });
    expect(row.input_cid).toBe('QmInputCid');
    expect(await database.getJob('alice', v.permlink)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('marks the video failed when pinning fails', async () => {
    pinFile.mockRejectedValueOnce(new Error('ipfs down'));
    const v = await insertVideo(database, { owner: 'alice' });
    const file = tempFile();
    await postFinish({ Size: 5, Storage: { Path: file }, MetaData: { permlink: v.permlink, owner: 'alice' } });
    await waitFor(async () => (await database.getVideo(v.permlink)).status === 'failed');
    expect(await database.getJob('alice', v.permlink)).toBeNull();
    // Kept on disk: nothing was pinned.
    expect(existsSync(file)).toBe(true);
  });

  it('does not wait on (or fail because of) the DHT announce', async () => {
    announceDHT.mockRejectedValueOnce(new Error('provide hung'));
    const v = await insertVideo(database, { owner: 'alice' });
    await postFinish({ Size: 5, Storage: { Path: tempFile() }, MetaData: { permlink: v.permlink, owner: 'alice' } });
    expect(await waitFor(() => database.getJob('alice', v.permlink))).toBeTruthy();
  });

  it('still queues the job when the temp file is already gone', async () => {
    const v = await insertVideo(database, { owner: 'alice' });
    const deferred = await insertVideo(database, { owner: 'alice', defer_encode: true });
    await postFinish({ Size: 5, Storage: { Path: path.join(process.env.UPLOAD_DIR!, 'missing-1') }, MetaData: { permlink: v.permlink, owner: 'alice' } });
    await postFinish({ Size: 5, Storage: { Path: path.join(process.env.UPLOAD_DIR!, 'missing-2') }, MetaData: { permlink: deferred.permlink, owner: 'alice' } });
    expect(await waitFor(() => database.getJob('alice', v.permlink))).toBeTruthy();
    await waitFor(async () => (await database.getVideo(deferred.permlink)).status === 'awaiting_encode');
  });

  it('ignores partial uploads and incomplete events', async () => {
    await postFinish({ IsPartial: true, Storage: { Path: tempFile() }, MetaData: { permlink: 'p', owner: 'o' } });
    await postFinish({ Storage: { Path: tempFile() }, MetaData: { owner: 'o' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(pinFile).not.toHaveBeenCalled();
  });

  it('survives a user-stats failure', async () => {
    const v = await insertVideo(database, { owner: 'alice' });
    const spy = vi.spyOn(database, 'incrementUserUpload').mockRejectedValueOnce(new Error('stats down'));
    await postFinish({ Size: 5, Storage: { Path: tempFile() }, MetaData: { permlink: v.permlink, owner: 'alice' } });
    expect(await waitFor(() => database.getJob('alice', v.permlink))).toBeTruthy();
    spy.mockRestore();
  });
});
