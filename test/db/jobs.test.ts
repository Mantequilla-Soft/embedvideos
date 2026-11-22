import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Db } from 'mongodb';
import type { Database } from '../../src/database/mongodb';
import { connectDb, clearAll, job, video, minutesAgo, hoursAgo } from './helpers';

let database: Database;
let raw: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ database, raw, close } = await connectDb());
});
afterAll(async () => close());
beforeEach(async () => clearAll(raw));

const jobs = () => raw.collection('embed-jobs');

describe('createJob / getJob', () => {
  it('round trips and enforces one job per owner+permlink', async () => {
    await database.createJob(job({ owner: 'a', permlink: 'p' }));
    expect((await database.getJob('a', 'p'))?.status).toBe('pending');
    expect(await database.getJob('a', 'other')).toBeNull();
    expect(await database.getJob('b', 'p')).toBeNull();
    await expect(database.createJob(job({ owner: 'a', permlink: 'p' }))).rejects.toMatchObject({ code: 11000 });
    // Same permlink, different owner is a different job.
    await database.createJob(job({ owner: 'b', permlink: 'p' }));
    expect(await jobs().countDocuments()).toBe(2);
    const idx = await jobs().indexes();
    expect(idx.find((i) => JSON.stringify(i.key) === '{"owner":1,"permlink":1}')?.unique).toBe(true);
  });
});

describe('getPendingJobs', () => {
  it('returns pending jobs oldest first, limited', async () => {
    await database.createJob(job({ permlink: 'p3', createdAt: minutesAgo(1) }));
    await database.createJob(job({ permlink: 'p1', createdAt: minutesAgo(30) }));
    await database.createJob(job({ permlink: 'p2', createdAt: minutesAgo(10) }));
    await database.createJob(job({ permlink: 'enc', status: 'encoding', createdAt: minutesAgo(60) }));
    expect((await database.getPendingJobs()).map((j) => j.permlink)).toEqual(['p1', 'p2', 'p3']);
    expect((await database.getPendingJobs(2)).map((j) => j.permlink)).toEqual(['p1', 'p2']);
  });
});

describe('claimNextManagedJob', () => {
  it('claims the oldest pending job and marks it encoding', async () => {
    await database.createJob(job({ permlink: 'new', createdAt: minutesAgo(1) }));
    await database.createJob(job({ permlink: 'old', createdAt: minutesAgo(9) }));
    const claimed = await database.claimNextManagedJob({});
    expect(claimed?.permlink).toBe('old');
    expect(claimed?.status).toBe('encoding');
    expect((await database.getJob('alice', 'old'))?.status).toBe('encoding');
    expect((await database.claimNextManagedJob({}))?.permlink).toBe('new');
    expect(await database.claimNextManagedJob({})).toBeNull();
  });

  it('filters by premium and short when given', async () => {
    await database.createJob(job({ permlink: 'free', premium: false, short: false, createdAt: minutesAgo(5) }));
    await database.createJob(job({ permlink: 'prem', premium: true, short: false, createdAt: minutesAgo(4) }));
    await database.createJob(job({ permlink: 'short', premium: false, short: true, createdAt: minutesAgo(3) }));
    expect((await database.claimNextManagedJob({ premium: true }))?.permlink).toBe('prem');
    expect((await database.claimNextManagedJob({ short: true }))?.permlink).toBe('short');
    expect(await database.claimNextManagedJob({ premium: true })).toBeNull();
    expect((await database.claimNextManagedJob({ premium: false, short: false }))?.permlink).toBe('free');
  });

  it('two concurrent claims never get the same job', async () => {
    await database.createJob(job({ permlink: 'only' }));
    const [a, b] = await Promise.all([database.claimNextManagedJob({}), database.claimNextManagedJob({})]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe('updateJobStatus / incrementJobAttempt / resetJob', () => {
  it('updateJobStatus writes status and extra fields', async () => {
    await database.createJob(job({ permlink: 'p', updatedAt: hoursAgo(2) }));
    await database.updateJobStatus('alice', 'p', 'encoding', { assignedWorker: 'enc-1', encoderJobId: 'e1', encodingProgress: 10 });
    const j = await database.getJob('alice', 'p');
    expect(j).toMatchObject({ status: 'encoding', assignedWorker: 'enc-1', encoderJobId: 'e1', encodingProgress: 10 });
    expect(j!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await database.updateJobStatus('alice', 'p', 'completed');
    expect((await database.getJob('alice', 'p'))?.status).toBe('completed');
  });

  it('incrementJobAttempt counts attempts and adds the failed worker once', async () => {
    await database.createJob(job({ permlink: 'p' }));
    await database.incrementJobAttempt('alice', 'p');
    let j = await database.getJob('alice', 'p');
    expect(j?.attemptCount).toBe(1);
    expect(j?.failedWorkers).toBeUndefined();

    await database.incrementJobAttempt('alice', 'p', 'enc-a');
    await database.incrementJobAttempt('alice', 'p', 'enc-a');
    await database.incrementJobAttempt('alice', 'p', 'enc-b');
    j = await database.getJob('alice', 'p');
    expect(j?.attemptCount).toBe(4);
    expect(j?.failedWorkers).toEqual(['enc-a', 'enc-b']);
  });

  it('resetJob returns the job to a fresh pending state and clears failedWorkers', async () => {
    await database.createJob(job({
      permlink: 'p', status: 'failed', attemptCount: 3, assignedWorker: 'enc-a', encoderJobId: 'x',
      assignedAt: new Date(), lastError: 'boom', encodingProgress: 50, encodingStage: 'hls', failedWorkers: ['enc-a'],
    }));
    await database.resetJob('alice', 'p');
    const j: any = await jobs().findOne({ permlink: 'p' });
    expect(j).toMatchObject({
      status: 'pending', attemptCount: 0, assignedWorker: null, encoderJobId: null, assignedAt: null,
      lastError: null, encodingProgress: null, encodingStage: null,
    });
    expect('failedWorkers' in j).toBe(false);
  });
});

describe('stall handling', () => {
  it('getStalledJobs: encoding jobs not updated within the window', async () => {
    await database.createJob(job({ permlink: 'stalled', status: 'encoding', updatedAt: minutesAgo(45) }));
    await database.createJob(job({ permlink: 'active', status: 'encoding', updatedAt: minutesAgo(5) }));
    await database.createJob(job({ permlink: 'pend', status: 'pending', updatedAt: minutesAgo(45) }));
    expect((await database.getStalledJobs(30)).map((j) => j.permlink)).toEqual(['stalled']);
  });

  it('resetStalledJob resets an encoding job, records the worker, and is atomic', async () => {
    await database.createJob(job({ permlink: 'p', status: 'encoding', assignedWorker: 'enc-a', encoderJobId: 'e', attemptCount: 1, encodingProgress: 30 }));
    expect(await database.resetStalledJob('alice', 'p', 'enc-a')).toBe(true);
    const j = await database.getJob('alice', 'p');
    expect(j).toMatchObject({
      status: 'pending', assignedWorker: null, encoderJobId: null, attemptCount: 2,
      lastError: 'Reset due to stall (no progress update)', encodingProgress: null,
    });
    expect(j?.failedWorkers).toEqual(['enc-a']);
    // Already pending (e.g. webhook raced us): nothing changes.
    expect(await database.resetStalledJob('alice', 'p', 'enc-a')).toBe(false);
    expect((await database.getJob('alice', 'p'))?.attemptCount).toBe(2);
  });

  it('resetStalledJob without a worker does not add failedWorkers', async () => {
    await database.createJob(job({ permlink: 'p', status: 'encoding' }));
    expect(await database.resetStalledJob('alice', 'p', null)).toBe(true);
    expect((await database.getJob('alice', 'p'))?.failedWorkers).toBeUndefined();
  });

  it('failStalledJob only fails a job that is still encoding', async () => {
    await database.createJob(job({ permlink: 'p', status: 'encoding' }));
    expect(await database.failStalledJob('alice', 'p', 'gave up')).toBe(true);
    expect(await database.getJob('alice', 'p')).toMatchObject({ status: 'failed', lastError: 'gave up' });
    expect(await database.failStalledJob('alice', 'p', 'again')).toBe(false);
    await database.createJob(job({ permlink: 'done', status: 'completed' }));
    expect(await database.failStalledJob('alice', 'done', 'x')).toBe(false);
    expect((await database.getJob('alice', 'done'))?.status).toBe('completed');
  });
});

describe('getCompletedJobStats', () => {
  it('returns completed and failed jobs updated since the date', async () => {
    await database.createJob(job({ permlink: 'c', status: 'completed', updatedAt: hoursAgo(1) }));
    await database.createJob(job({ permlink: 'f', status: 'failed', updatedAt: hoursAgo(2) }));
    await database.createJob(job({ permlink: 'old', status: 'completed', updatedAt: hoursAgo(48) }));
    await database.createJob(job({ permlink: 'e', status: 'encoding', updatedAt: hoursAgo(1) }));
    const rows = await database.getCompletedJobStats(hoursAgo(24));
    expect(rows.map((j) => j.permlink).sort()).toEqual(['c', 'f']);
  });
});

describe('getJobsForVideofixer', () => {
  it('joins jobs with their video, newest first, with failedWorkers defaulting to []', async () => {
    await database.createVideoEntry(video({ permlink: 'vf1', input_cid: 'QmIn1', originalFilename: 'a.mp4', status: 'processing' }));
    await database.createJob(job({ permlink: 'vf1', status: 'failed', lastError: 'x', failedWorkers: ['enc-a'], updatedAt: hoursAgo(1) }));
    await database.createJob(job({ permlink: 'vf2', status: 'failed', updatedAt: minutesAgo(1) })); // no video row
    await database.createJob(job({ permlink: 'vf3', status: 'pending' }));

    const rows = await database.getJobsForVideofixer('failed');
    expect(rows.map((r) => r.permlink)).toEqual(['vf2', 'vf1']);
    const [noVideo, withVideo] = rows;
    expect(withVideo).toMatchObject({ owner: 'alice', input_cid: 'QmIn1', originalFilename: 'a.mp4', videoStatus: 'processing', failedWorkers: ['enc-a'], lastError: 'x' });
    expect((withVideo as any)._id).toBeUndefined();
    expect(noVideo.failedWorkers).toEqual([]);
    expect(noVideo.input_cid).toBeUndefined();

    expect(await database.getJobsForVideofixer('failed', 1)).toHaveLength(1);
    expect((await database.getJobsForVideofixer('pending')).map((r) => r.permlink)).toEqual(['vf3']);
  });
});

describe('claimNextCommunityJob', () => {
  it('only claims free, non-short, non-gated jobs and stamps the worker and a callback token', async () => {
    await database.createJob(job({ permlink: 'prem', premium: true, createdAt: minutesAgo(10) }));
    await database.createJob(job({ permlink: 'short', short: true, createdAt: minutesAgo(9) }));
    await database.createJob(job({ permlink: 'gated', gated: true, createdAt: minutesAgo(8) }));
    // Legacy job without premium/short fields must not leak to community nodes.
    const { premium, short, ...legacy } = job({ permlink: 'legacy', createdAt: minutesAgo(7) });
    void premium; void short;
    await jobs().insertOne(legacy);
    await database.createJob(job({ permlink: 'ok', createdAt: minutesAgo(6) }));
    await database.createJob(job({ permlink: 'ok-gated-false', gated: false, createdAt: minutesAgo(5) }));

    const first = await database.claimNextCommunityJob('community-1', null);
    expect(first?.permlink).toBe('ok');
    expect(first).toMatchObject({ status: 'encoding', assignedWorker: 'community-1' });
    expect(first?.assignedAt).toBeInstanceOf(Date);
    expect(first?.callbackToken).toMatch(/^[0-9a-f]{64}$/);

    const second = await database.claimNextCommunityJob('community-1', null);
    expect(second?.permlink).toBe('ok-gated-false');
    expect(second?.callbackToken).not.toBe(first?.callbackToken);

    expect(await database.claimNextCommunityJob('community-1', null)).toBeNull();
  });

  it('skips jobs this encoder already failed but lets others take them', async () => {
    await database.createJob(job({ permlink: 'p', failedWorkers: ['community-1'] }));
    expect(await database.claimNextCommunityJob('community-1', null)).toBeNull();
    expect((await database.claimNextCommunityJob('community-2', null))?.permlink).toBe('p');
  });

  it('capped encoders only take jobs with a known size within the cap', async () => {
    await database.createJob(job({ permlink: 'unknown', fileSize: null, createdAt: minutesAgo(5) }));
    await database.createJob(job({ permlink: 'zero', fileSize: 0, createdAt: minutesAgo(4) }));
    await database.createJob(job({ permlink: 'big', fileSize: 2000, createdAt: minutesAgo(3) }));
    await database.createJob(job({ permlink: 'fits', fileSize: 1000, createdAt: minutesAgo(2) }));
    expect((await database.claimNextCommunityJob('capped', 1000))?.permlink).toBe('fits');
    expect(await database.claimNextCommunityJob('capped', 1000)).toBeNull();
    // Uncapped takes anything, including unknown sizes, oldest first.
    expect((await database.claimNextCommunityJob('uncapped', null))?.permlink).toBe('unknown');
  });
});
