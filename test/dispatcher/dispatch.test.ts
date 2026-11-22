import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Db } from 'mongodb';
import type { Database, Encoder, EncodingJob, VideoMetadata } from '../../src/database/mongodb';
import { JobDispatcher } from '../../src/dispatcher/jobDispatcher';
import { connectDb, clearAll, encoder, job, video, minutesAgo, user } from '../db/helpers';

// The poll cycle (processJobs) end to end: claim from embed-jobs, pick an
// encoder from embed-encoders, POST {encoder.url}/encode (global fetch is
// mocked), then write the outcome back.

let database: Database;
let raw: Db;
let close: () => Promise<void>;
const config = { webhookUrl: 'https://hooks.test/encode', webhookApiKey: 'hook-key' } as any;

beforeAll(async () => {
  ({ database, raw, close } = await connectDb());
});
afterAll(async () => close());

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown = { job_id: 'enc-job-1' }) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  await clearAll(raw);
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedVideoAndJob(v: Partial<VideoMetadata> = {}, j: Partial<EncodingJob> = {}) {
  const permlink = v.permlink ?? j.permlink ?? `p-${Math.random().toString(36).slice(2, 8)}`;
  await database.createVideoEntry(video({ status: 'processing', input_cid: 'QmInput', size: 1000, ...v, permlink }));
  await database.createJob(job({ ...j, permlink }));
  return permlink;
}
const addEncoder = (e: Partial<Encoder> = {}) => database.createEncoder(encoder({ name: 'std-1', url: 'http://std-1.test', apiKey: 'std-key', tier: 'standard', ...e }));
const run = (d: JobDispatcher) => (d as any).processJobs() as Promise<void>;
const sentBody = (call = 0) => JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

describe('successful dispatch', () => {
  it('POSTs the encode request and records the encoder on the job', async () => {
    await addEncoder();
    const permlink = await seedVideoAndJob({ owner: 'alice', frontend_app: 'snapie', originalFilename: 'movie.mov' }, { owner: 'alice', premium: false });
    await run(new JobDispatcher(database, config));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://std-1.test/encode');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-API-Key': 'std-key' });
    expect(sentBody()).toEqual({
      owner: 'alice',
      permlink,
      input_cid: 'https://ipfs.3speak.tv/ipfs/QmInput',
      short: false,
      premium: false,
      webhook_url: 'https://hooks.test/encode',
      api_key: 'hook-key',
      frontend_app: 'snapie',
      originalFilename: 'movie.mov',
    });

    const j = await database.getJob('alice', permlink);
    expect(j).toMatchObject({ status: 'encoding', encoderJobId: 'enc-job-1', assignedWorker: 'std-1', lastError: null, attemptCount: 0 });
    expect(j?.assignedAt).toBeInstanceOf(Date);
  });

  it('uses the user record for premium when the job does not carry it', async () => {
    await addEncoder({ name: 'perf', url: 'http://perf.test', tier: 'performance' });
    await addEncoder({ name: 'std', url: 'http://std.test', tier: 'standard' });
    await database.createUser(user({ username: 'pro', premium: true }));
    const { premium, ...noPremium } = job({ owner: 'pro', permlink: 'pp' });
    void premium;
    await database.createVideoEntry(video({ owner: 'pro', permlink: 'pp', status: 'processing', input_cid: 'Qm' }));
    await raw.collection('embed-jobs').insertOne(noPremium);
    await run(new JobDispatcher(database, config));
    expect(fetchMock.mock.calls[0][0]).toBe('http://perf.test/encode');
    expect(sentBody().premium).toBe(true);
  });

  it('job.premium wins over the user record', async () => {
    await addEncoder({ name: 'perf', url: 'http://perf.test', tier: 'performance' });
    await addEncoder({ name: 'std', url: 'http://std.test', tier: 'standard' });
    await database.createUser(user({ username: 'pro', premium: true }));
    await seedVideoAndJob({ owner: 'pro' }, { owner: 'pro', premium: false });
    await run(new JobDispatcher(database, config));
    expect(fetchMock.mock.calls[0][0]).toBe('http://std.test/encode');
  });

  it('falls back to job.fileSize when the video has no size', async () => {
    await addEncoder({ name: 'capped', url: 'http://capped.test', maxFileSize: 100 });
    await addEncoder({ name: 'lite', url: 'http://lite.test', tier: 'lite' });
    await seedVideoAndJob({ size: null }, { fileSize: 50 });
    await seedVideoAndJob({ size: null, createdAt: new Date() }, { fileSize: 500, createdAt: new Date(Date.now() + 1000) });
    await run(new JobDispatcher(database, config));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://capped.test/encode', 'http://lite.test/encode']);
  });

  it('sends short videos as short', async () => {
    await addEncoder({ name: 'perf', url: 'http://perf.test', tier: 'performance' });
    await seedVideoAndJob({ short: true }, { short: true });
    await run(new JobDispatcher(database, config));
    expect(sentBody().short).toBe(true);
  });

  it('claims and dispatches at most 5 jobs per cycle, oldest first', async () => {
    await addEncoder();
    for (let i = 0; i < 7; i++) await seedVideoAndJob({ permlink: `batch-${i}` }, { createdAt: minutesAgo(100 - i) });
    await run(new JobDispatcher(database, config));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map((_, i) => sentBody(i).permlink)).toEqual(['batch-0', 'batch-1', 'batch-2', 'batch-3', 'batch-4']);
    expect((await database.getPendingJobs()).map((j) => j.permlink)).toEqual(['batch-5', 'batch-6']);
  });

  it('round robins across a cycle', async () => {
    await addEncoder({ name: 'a', url: 'http://a.test', createdAt: minutesAgo(10) });
    await addEncoder({ name: 'b', url: 'http://b.test', createdAt: minutesAgo(5) });
    for (let i = 0; i < 3; i++) await seedVideoAndJob({ permlink: `rr-${i}` }, { createdAt: minutesAgo(50 - i) });
    await run(new JobDispatcher(database, config));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://a.test/encode', 'http://b.test/encode', 'http://a.test/encode']);
  });

  it('does nothing when no job is pending', async () => {
    await addEncoder();
    await run(new JobDispatcher(database, config));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('gated dispatch', () => {
  it('a gated video goes only to a trusted encoder, with gate fields in the payload', async () => {
    await addEncoder({ name: 'untrusted', url: 'http://untrusted.test', createdAt: minutesAgo(10) });
    await addEncoder({ name: 'trusted', url: 'http://trusted.test', trusted: true, tier: 'lite', createdAt: minutesAgo(5) });
    const permlink = await seedVideoAndJob({ gated: true, gate_video_id: 'gate-123' });
    await run(new JobDispatcher(database, config));
    expect(fetchMock.mock.calls[0][0]).toBe('http://trusted.test/encode');
    expect(sentBody()).toMatchObject({ gated: true, gate_video_id: 'gate-123', permlink });
  });

  it('the stricter answer wins: job.gated alone is enough; gate id falls back to job then permlink', async () => {
    await addEncoder({ name: 'trusted', url: 'http://trusted.test', trusted: true });
    await seedVideoAndJob({ permlink: 'g1', gated: false, createdAt: minutesAgo(3) }, { gated: true, gateVideoId: 'job-gate', createdAt: minutesAgo(3) });
    await seedVideoAndJob({ permlink: 'g2', gated: true }, { createdAt: minutesAgo(1) });
    await run(new JobDispatcher(database, config));
    expect(sentBody(0)).toMatchObject({ permlink: 'g1', gated: true, gate_video_id: 'job-gate' });
    expect(sentBody(1)).toMatchObject({ permlink: 'g2', gated: true, gate_video_id: 'g2' });
  });

  it('with no trusted encoder dispatchJob refuses and fetch is never called', async () => {
    await addEncoder({ name: 'untrusted' });
    const permlink = await seedVideoAndJob({ gated: true });
    const d = new JobDispatcher(database, config) as any;
    const claimed = await database.claimNextManagedJob({});
    await expect(d.dispatchJob('alice', permlink, claimed)).rejects.toThrow('No trusted encoders available for gated job');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no trusted encoder a poll cycle never sends it anywhere, and the job waits for the next cycle', async () => {
    await addEncoder({ name: 'untrusted' });
    const permlink = await seedVideoAndJob({ gated: true });
    await run(new JobDispatcher(database, config));
    expect(fetchMock).not.toHaveBeenCalled();
    const j = await database.getJob('alice', permlink);
    expect(j?.lastError).toContain('No trusted encoders available for gated job');
    expect(j?.failedWorkers).toBeUndefined();
    // One attempt per cycle: back in the queue, not burnt through.
    expect(j).toMatchObject({ status: 'pending', attemptCount: 1 });
  });

  it('dispatchJob re-asserts trust even if selection were to return an untrusted encoder', async () => {
    await addEncoder({ name: 'rogue' });
    const permlink = await seedVideoAndJob({ gated: true });
    const d = new JobDispatcher(database, config);
    vi.spyOn(d as any, 'getNextEncoder').mockResolvedValue(encoder({ name: 'rogue', trusted: false }));
    await run(d);
    expect(fetchMock).not.toHaveBeenCalled();
    const j = await database.getJob('alice', permlink);
    expect(j?.lastError).toContain('Refusing to dispatch gated job');
    expect(j?.failedWorkers).toBeUndefined();
  });

  it('non-gated payloads carry no gate fields', async () => {
    await addEncoder();
    await seedVideoAndJob();
    await run(new JobDispatcher(database, config));
    expect(sentBody()).not.toHaveProperty('gated');
    expect(sentBody()).not.toHaveProperty('gate_video_id');
  });
});

describe('dispatch failures', () => {
  it('encoder HTTP error: the job goes back to pending and the retry skips that encoder', async () => {
    await addEncoder({ name: 'a', url: 'http://a.test', createdAt: minutesAgo(10) });
    await addEncoder({ name: 'b', url: 'http://b.test', createdAt: minutesAgo(5) });
    fetchMock.mockResolvedValueOnce(new Response('encoder busy', { status: 503 }));
    const permlink = await seedVideoAndJob();
    const d = new JobDispatcher(database, config) as any;

    // One attempt, driven directly, to see the intermediate state.
    const claimed = await database.claimNextManagedJob({});
    await expect(d.dispatchJob('alice', permlink, claimed)).rejects.toMatchObject({ message: 'Encoder API error: 503 - encoder busy', encoderName: 'a' });

    await database.updateJobStatus('alice', permlink, 'pending');
    await database.incrementJobAttempt('alice', permlink, 'a');
    d.tierCounters = {}; // round robin alone would also pick b; reset so the exclusion is what steers it
    await run(d);
    expect(fetchMock.mock.calls[1][0]).toBe('http://b.test/encode');
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'encoding', assignedWorker: 'b', lastError: null, failedWorkers: ['a'] });
  });

  it('a failed job is retried on another encoder in the next cycle, not the same one', async () => {
    await addEncoder({ name: 'a', url: 'http://a.test', createdAt: minutesAgo(10) });
    await addEncoder({ name: 'b', url: 'http://b.test', createdAt: minutesAgo(5) });
    fetchMock.mockResolvedValueOnce(new Response('encoder busy', { status: 503 }));
    const permlink = await seedVideoAndJob();
    const d = new JobDispatcher(database, config);
    await run(d);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://a.test/encode']);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'pending', attemptCount: 1, failedWorkers: ['a'], lastError: 'Encoder API error: 503 - encoder busy' });
    await run(d);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://a.test/encode', 'http://b.test/encode']);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'encoding', assignedWorker: 'b', attemptCount: 1, failedWorkers: ['a'], lastError: null });
  });

  it('network error: the encoder is recorded as failed, and reused when it is the only one', async () => {
    await addEncoder({ name: 'down' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const permlink = await seedVideoAndJob();
    const d = new JobDispatcher(database, config);
    await run(d);
    await run(d);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'encoding', attemptCount: 1, failedWorkers: ['down'], assignedWorker: 'down' });
  });

  it('non-Error rejection is stringified', async () => {
    await addEncoder({ name: 'weird' });
    fetchMock.mockRejectedValue('plain string');
    const permlink = await seedVideoAndJob();
    const d = new JobDispatcher(database, config);
    await run(d);
    expect((await database.getJob('alice', permlink))?.lastError).toBe('plain string');
    await run(d);
    await run(d);
    expect((await database.getJob('alice', permlink))?.lastError).toBe('Max attempts exceeded: plain string');
  });

  it('missing video or missing input_cid: retried without blaming an encoder, one attempt per cycle', async () => {
    await addEncoder();
    await database.createJob(job({ permlink: 'orphan', createdAt: minutesAgo(5) }));
    await seedVideoAndJob({ permlink: 'nocid', input_cid: null }, { createdAt: minutesAgo(1) });
    const d = new JobDispatcher(database, config);
    await run(d);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await database.getJob('alice', 'orphan')).toMatchObject({ status: 'pending', attemptCount: 1, lastError: 'Video not found: orphan' });
    expect(await database.getJob('alice', 'nocid')).toMatchObject({ status: 'pending', attemptCount: 1, lastError: 'Video has no input_cid: nocid' });

    await run(d);
    await run(d);
    const orphan = await database.getJob('alice', 'orphan');
    expect(orphan).toMatchObject({ status: 'failed', attemptCount: 3, lastError: 'Max attempts exceeded: Video not found: orphan' });
    expect(orphan?.failedWorkers).toBeUndefined();
    expect(await database.getJob('alice', 'nocid')).toMatchObject({ status: 'failed', attemptCount: 3 });
    expect((await database.getVideo('nocid'))?.status).toBe('failed');
  });

  it('an encoder that keeps failing uses one attempt per cycle, and the third failure ends the job', async () => {
    await addEncoder({ name: 'flaky' });
    fetchMock.mockImplementation(async () => new Response('down', { status: 502 }));
    const permlink = await seedVideoAndJob();
    const d = new JobDispatcher(database, config);
    await run(d);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'pending', attemptCount: 1 });
    expect((await database.getVideo(permlink))?.status).toBe('processing');
    await run(d);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'pending', attemptCount: 2 });
    await run(d);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'failed', attemptCount: 3 });
    expect((await database.getVideo(permlink))?.status).toBe('failed');
    // Failed for good: later cycles leave it alone.
    await run(d);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a job already at 3 attempts is failed for good, video too', async () => {
    await addEncoder({ name: 'bad' });
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    const permlink = await seedVideoAndJob({}, { attemptCount: 3 });
    await run(new JobDispatcher(database, config));
    const j = await database.getJob('alice', permlink);
    expect(j?.status).toBe('failed');
    expect(j?.lastError).toBe('Max attempts exceeded: Encoder API error: 500 - nope');
    expect(j?.attemptCount).toBe(4);
    expect((await database.getVideo(permlink))?.status).toBe('failed');
  });

  it('below the limit a failure is retried next cycle and the video stays as it was', async () => {
    await addEncoder({ name: 'bad' });
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const permlink = await seedVideoAndJob({}, { attemptCount: 1 });
    const d = new JobDispatcher(database, config);
    await run(d);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'pending', attemptCount: 2 });
    expect((await database.getVideo(permlink))?.status).toBe('processing');
    await run(d);
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'encoding', attemptCount: 2 });
  });

  it('a job whose failure cannot be recorded stays claimed for the stalled-job check', async () => {
    await addEncoder({ name: 'bad' });
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const permlink = await seedVideoAndJob();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(database, 'incrementJobAttempt').mockRejectedValueOnce(new Error('db down'));
    await expect(run(new JobDispatcher(database, config))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(`Failed to record dispatch failure for alice/${permlink}:`, expect.any(Error));
    expect((await database.getJob('alice', permlink))?.status).toBe('encoding');
  });

  it('a failing job does not stop the rest of the batch', async () => {
    await addEncoder();
    fetchMock.mockRejectedValueOnce(new Error('first fails'));
    await seedVideoAndJob({ permlink: 'f1' }, { createdAt: minutesAgo(5) });
    await seedVideoAndJob({ permlink: 'f2' }, { createdAt: minutesAgo(1) });
    await run(new JobDispatcher(database, config));
    // f1 failed and waits for the next cycle; f2 still went out in this one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await database.getJob('alice', 'f1'))?.status).toBe('pending');
    expect((await database.getJob('alice', 'f2'))?.status).toBe('encoding');
  });

  it('a database error in the cycle is caught and logged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(database, 'getStalledJobs').mockRejectedValueOnce(new Error('db down'));
    await expect(run(new JobDispatcher(database, config))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('Error processing jobs:', expect.any(Error));
  });
});

describe('stalled jobs', () => {
  const check = (d: JobDispatcher) => (d as any).checkStalledJobs() as Promise<void>;

  it('resets a stalled job to pending and excludes its encoder', async () => {
    const permlink = await seedVideoAndJob({}, { status: 'encoding', assignedWorker: 'slow', attemptCount: 0, updatedAt: minutesAgo(45) });
    await seedVideoAndJob({ permlink: 'fresh' }, { status: 'encoding', assignedWorker: 'ok', updatedAt: minutesAgo(5) });
    await check(new JobDispatcher(database, config));
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'pending', attemptCount: 1, failedWorkers: ['slow'], assignedWorker: null });
    expect((await database.getJob('alice', 'fresh'))?.status).toBe('encoding');
  });

  it('gives up on the third stall and fails the video', async () => {
    const permlink = await seedVideoAndJob({}, { status: 'encoding', assignedWorker: 'slow', attemptCount: 2, updatedAt: minutesAgo(45) });
    await check(new JobDispatcher(database, config));
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'failed', lastError: 'Stalled 3 times — giving up' });
    expect((await database.getVideo(permlink))?.status).toBe('failed');
  });

  it('skips jobs that changed status in between (race with the webhook)', async () => {
    const p1 = await seedVideoAndJob({}, { status: 'encoding', attemptCount: 0, updatedAt: minutesAgo(45) });
    const p2 = await seedVideoAndJob({}, { status: 'encoding', attemptCount: 2, updatedAt: minutesAgo(45) });
    const d = new JobDispatcher(database, config);
    const reset = vi.spyOn(database, 'resetStalledJob').mockResolvedValue(false);
    const fail = vi.spyOn(database, 'failStalledJob').mockResolvedValue(false);
    await check(d);
    expect(reset).toHaveBeenCalledWith('alice', p1, null);
    expect(fail).toHaveBeenCalled();
    expect((await database.getVideo(p2))?.status).toBe('processing');
  });

  it('an error on one stalled job does not stop the others', async () => {
    const p1 = await seedVideoAndJob({}, { status: 'encoding', updatedAt: minutesAgo(50) });
    const p2 = await seedVideoAndJob({}, { status: 'encoding', updatedAt: minutesAgo(40) });
    const real = database.resetStalledJob.bind(database);
    vi.spyOn(database, 'resetStalledJob').mockImplementation(async (o, p, w) => {
      if (p === p1) throw new Error('boom');
      return real(o, p, w);
    });
    await check(new JobDispatcher(database, config));
    expect((await database.getJob('alice', p1))?.status).toBe('encoding');
    expect((await database.getJob('alice', p2))?.status).toBe('pending');
  });

  it('the poll cycle runs the stall check before claiming', async () => {
    await addEncoder({ name: 'healthy' });
    const permlink = await seedVideoAndJob({}, { status: 'encoding', assignedWorker: 'slow', updatedAt: minutesAgo(45) });
    await run(new JobDispatcher(database, config));
    // Reset by the stall check, then re-dispatched to a different encoder in the same cycle.
    expect(await database.getJob('alice', permlink)).toMatchObject({ status: 'encoding', assignedWorker: 'healthy', failedWorkers: ['slow'], attemptCount: 1 });
  });
});

describe('start / stop', () => {
  it('runs immediately, then on the interval; a second start is ignored; stop clears it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const d = new JobDispatcher(database, config);
    const spy = vi.spyOn(d as any, 'processJobs').mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    d.start(10);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20_000);
    expect(spy).toHaveBeenCalledTimes(4);

    d.start(10);
    expect(log).toHaveBeenCalledWith('Dispatcher already running');
    expect(spy).toHaveBeenCalledTimes(4);

    d.stop();
    expect(log).toHaveBeenCalledWith('Job dispatcher stopped');
    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(4);

    // Stopping twice is harmless, and it can start again afterwards.
    d.stop();
    d.start();
    expect(spy).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(30_000);
    expect(spy).toHaveBeenCalledTimes(6);
    d.stop();
  });
});
