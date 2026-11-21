import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Db } from 'mongodb';
import type { Database, Encoder } from '../../src/database/mongodb';
import { JobDispatcher } from '../../src/dispatcher/jobDispatcher';
import { connectDb, clearAll, encoder, minutesAgo } from '../db/helpers';

// Encoder selection (getNextEncoder) against real encoder rows. The method is
// private; it is the unit the tier rules live in, so it is called directly.

let database: Database;
let raw: Db;
let close: () => Promise<void>;
const config = { webhookUrl: 'https://hooks.test/encode', webhookApiKey: 'hook-key' } as any;

beforeAll(async () => {
  ({ database, raw, close } = await connectDb());
});
afterAll(async () => close());
beforeEach(async () => clearAll(raw));

let seq = 0;
async function seed(...encs: Partial<Encoder>[]) {
  for (const e of encs) await database.createEncoder(encoder({ createdAt: minutesAgo(1000 - seq++), ...e }));
}

type Pick = { premium?: boolean; size?: number | null; short?: boolean; gated?: boolean; failed?: string[] };
function picker() {
  const d = new JobDispatcher(database, config) as any;
  return (o: Pick = {}): Promise<Encoder> =>
    d.getNextEncoder(o.premium ?? false, o.size ?? null, o.short ?? false, o.gated ?? false, o.failed);
}

describe('premium jobs', () => {
  it('prefer performance, fall back to standard, never lite', async () => {
    await seed({ name: 'perf', tier: 'performance' }, { name: 'std', tier: 'standard' }, { name: 'lite', tier: 'lite' });
    const pick = picker();
    expect((await pick({ premium: true })).name).toBe('perf');

    await database.updateEncoder('perf', { enabled: false });
    expect((await pick({ premium: true })).name).toBe('std');

    await database.updateEncoder('std', { enabled: false });
    await expect(pick({ premium: true })).rejects.toThrow('No suitable managed encoders available for premium job');
  });

  it('never go to a community encoder, even a performance one', async () => {
    await seed({ name: 'comm-perf', tier: 'performance', access: 'community' }, { name: 'std', tier: 'standard' });
    expect((await picker()({ premium: true })).name).toBe('std');
  });
});

describe('free jobs', () => {
  it('prefer standard, fall back to lite, never performance', async () => {
    await seed({ name: 'perf', tier: 'performance' }, { name: 'std', tier: 'standard' }, { name: 'lite', tier: 'lite' });
    const pick = picker();
    expect((await pick()).name).toBe('std');
    await database.updateEncoder('std', { enabled: false });
    expect((await pick()).name).toBe('lite');
    await database.updateEncoder('lite', { enabled: false });
    await expect(pick()).rejects.toThrow('No suitable encoders available for free job');
  });

  it('skip community and disabled encoders; no encoders at all is an error', async () => {
    const pick = picker();
    await expect(pick()).rejects.toThrow('No suitable encoders available for free job');
    await seed({ name: 'comm', tier: 'standard', access: 'community' }, { name: 'off', tier: 'standard', enabled: false });
    await expect(pick()).rejects.toThrow('No suitable encoders available for free job');
  });

  it('treat a missing tier as standard and a missing access as managed', async () => {
    const { tier, access, ...bare } = encoder({ name: 'legacy' });
    void tier; void access;
    await raw.collection('embed-encoders').insertOne(bare);
    await seed({ name: 'lite', tier: 'lite' });
    expect((await picker()()).name).toBe('legacy');
  });
});

describe('maxFileSize', () => {
  it('skips encoders whose cap is below the file, and capped ones when the size is unknown', async () => {
    await seed({ name: 'small', tier: 'standard', maxFileSize: 1000 }, { name: 'lite-big', tier: 'lite', maxFileSize: 10_000 });
    const pick = picker();
    expect((await pick({ size: 500 })).name).toBe('small');
    expect((await pick({ size: 1000 })).name).toBe('small');
    expect((await pick({ size: 5000 })).name).toBe('lite-big');
    await expect(pick({ size: 50_000 })).rejects.toThrow('No suitable encoders available for free job');
    await expect(pick({ size: null })).rejects.toThrow('No suitable encoders available for free job');

    await seed({ name: 'uncapped-lite', tier: 'lite', maxFileSize: null });
    expect((await pick({ size: null })).name).toBe('uncapped-lite');
  });

  it('applies to premium tiers too', async () => {
    await seed({ name: 'perf', tier: 'performance', maxFileSize: 100 }, { name: 'std', tier: 'standard' });
    expect((await picker()({ premium: true, size: 200 })).name).toBe('std');
  });
});

describe('short videos', () => {
  it('go to any managed encoder regardless of tier, never community', async () => {
    await seed({ name: 'perf', tier: 'performance' }, { name: 'comm', tier: 'lite', access: 'community' });
    expect((await picker()({ short: true })).name).toBe('perf');
  });

  it('prefer encoders whose cap fits, then ignore maxFileSize rather than stall', async () => {
    await seed({ name: 'tiny', tier: 'lite', maxFileSize: 10 }, { name: 'mid', tier: 'standard', maxFileSize: 1000 });
    const pick = picker();
    expect((await pick({ short: true, size: 500 })).name).toBe('mid');
    // Nothing fits 5000: fall back to the whole managed pool, round robin.
    const names = [(await pick({ short: true, size: 5000 })).name, (await pick({ short: true, size: 5000 })).name];
    expect(names.sort()).toEqual(['mid', 'tiny']);
  });

  it('with an unknown size only uncapped encoders qualify, else fallback', async () => {
    await seed({ name: 'capped', tier: 'standard', maxFileSize: 1000 }, { name: 'open', tier: 'lite' });
    expect((await picker()({ short: true, size: null })).name).toBe('open');
  });

  it('error when no managed encoder exists', async () => {
    await seed({ name: 'comm', access: 'community' });
    await expect(picker()({ short: true })).rejects.toThrow('No suitable encoders available for free job');
    await expect(picker()({ short: true, premium: true })).rejects.toThrow('No suitable managed encoders available for premium job');
  });
});

describe('gated jobs', () => {
  it('only reach trusted managed encoders, any tier', async () => {
    await seed(
      { name: 'std', tier: 'standard' },
      { name: 'trusted-lite', tier: 'lite', trusted: true },
      { name: 'trusted-comm', tier: 'standard', access: 'community', trusted: true },
    );
    expect((await picker()({ gated: true })).name).toBe('trusted-lite');
  });

  it('refuse to dispatch with no trusted encoder: no fallback to untrusted', async () => {
    await seed({ name: 'perf', tier: 'performance' }, { name: 'std', tier: 'standard' });
    const pick = picker();
    await expect(pick({ gated: true })).rejects.toThrow('No trusted encoders available for gated job');
    await expect(pick({ gated: true, premium: true })).rejects.toThrow('No trusted encoders available');
    await expect(pick({ gated: true, short: true })).rejects.toThrow('No trusted encoders available');
    // A disabled trusted encoder does not count.
    await seed({ name: 'trusted-off', tier: 'standard', trusted: true, enabled: false });
    await expect(pick({ gated: true })).rejects.toThrow('No trusted encoders available');
  });

  it('keep tier rules inside the trusted set', async () => {
    await seed({ name: 'untrusted-perf', tier: 'performance' }, { name: 'trusted-lite', tier: 'lite', trusted: true });
    const pick = picker();
    await expect(pick({ gated: true, premium: true })).rejects.toThrow('No suitable trusted encoders available for premium gated job');

    await database.updateEncoder('trusted-lite', { tier: 'performance' });
    expect((await pick({ gated: true, premium: true })).name).toBe('trusted-lite');
    // Free gated job: a trusted performance encoder is not a free-tier target.
    await expect(pick({ gated: true })).rejects.toThrow('No suitable trusted encoders available for gated job');
  });

  it('short gated jobs ignore maxFileSize only within the trusted set', async () => {
    await seed({ name: 'untrusted-open', tier: 'standard' }, { name: 'trusted-tiny', tier: 'lite', trusted: true, maxFileSize: 1 });
    expect((await picker()({ gated: true, short: true, size: 999 })).name).toBe('trusted-tiny');
  });

  it('retry exclusions never widen past the trusted set', async () => {
    await seed({ name: 'untrusted', tier: 'standard' }, { name: 'trusted', tier: 'standard', trusted: true });
    expect((await picker()({ gated: true, failed: ['trusted'] })).name).toBe('trusted');
  });
});

describe('round robin', () => {
  it('alternates within a tier and keeps separate counters per tier key', async () => {
    await seed({ name: 's1', tier: 'standard' }, { name: 's2', tier: 'standard' }, { name: 'p1', tier: 'performance' }, { name: 'p2', tier: 'performance' });
    const pick = picker();
    const free = [];
    for (let i = 0; i < 4; i++) free.push((await pick()).name);
    expect(free).toEqual(['s1', 's2', 's1', 's2']);
    // Premium counter starts fresh, unaffected by the free picks.
    expect((await pick({ premium: true })).name).toBe('p1');
    expect((await pick({ premium: true })).name).toBe('p2');
    // Premium fallback to standard uses its own counter, not the free one.
    await database.updateEncoder('p1', { enabled: false });
    await database.updateEncoder('p2', { enabled: false });
    expect((await pick({ premium: true })).name).toBe('s1');
    // Gated picks use a gated- prefixed counter.
    await database.updateEncoder('s1', { trusted: true });
    await database.updateEncoder('s2', { trusted: true });
    expect((await pick({ gated: true })).name).toBe('s1');
    expect((await pick()).name).toBe('s1'); // free counter was at 4
  });

  it('roundRobin on an empty group throws', () => {
    const d = new JobDispatcher(database, config) as any;
    expect(() => d.roundRobin([], 'x')).toThrow('No encoders available for tier: x');
  });
});

describe('retry exclusions (failedWorkers)', () => {
  it('skip an encoder that failed the job when another can take it', async () => {
    await seed({ name: 's1', tier: 'standard' }, { name: 's2', tier: 'standard' });
    const pick = picker();
    for (let i = 0; i < 3; i++) expect((await pick({ failed: ['s1'] })).name).toBe('s2');
  });

  it('prefer a fresh lower tier over a failed better tier', async () => {
    await seed({ name: 'std', tier: 'standard' }, { name: 'lite', tier: 'lite' });
    expect((await picker()({ failed: ['std'] })).name).toBe('lite');
  });

  it('reuse failed encoders rather than strand the job', async () => {
    await seed({ name: 'only', tier: 'standard' }, { name: 'perf', tier: 'performance' });
    expect((await picker()({ failed: ['only'] })).name).toBe('only');
  });

  it('ignore names that are not in the pool', async () => {
    await seed({ name: 'only', tier: 'standard' });
    expect((await picker()({ failed: ['gone'] })).name).toBe('only');
  });
});
