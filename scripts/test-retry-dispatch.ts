/**
 * Tests for retrying a failed job on a different encoder (issue #42).
 *
 * The property under test: an encoder that failed, stalled on or rejected a
 * job is skipped on the retry when another encoder can take it, and used again
 * when none can, so the job never gets stuck in pending. The exclusion only
 * narrows the pool, so a gated job still never reaches an untrusted encoder.
 *
 * Runs with no MongoDB and no network: encoder selection runs against a stub
 * database, and query shapes are captured from a fake collection.
 *
 * Usage: npx ts-node --transpile-only scripts/test-retry-dispatch.ts
 */

import { JobDispatcher } from '../src/dispatcher/jobDispatcher';
import { Database, Encoder, EncodingJob } from '../src/database/mongodb';

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

function encoder(name: string, over: Partial<Encoder> = {}): Encoder {
  return {
    name,
    url: `https://${name}.example.com`,
    apiKey: 'k',
    enabled: true,
    access: 'managed',
    tier: 'standard',
    maxFileSize: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/** Names chosen over `rounds` selections, so a lucky round-robin turn can't hide a bug. */
async function picks(
  encoders: Encoder[],
  failedWorkers: string[],
  opts: { premium?: boolean; isShort?: boolean; gated?: boolean } = {},
  rounds = 4,
): Promise<Set<string>> {
  const fakeDb = { getAllEncoders: async () => encoders } as unknown as Database;
  const d = new JobDispatcher(fakeDb, { webhookUrl: '', webhookApiKey: '' } as any) as any;
  const names = new Set<string>();
  for (let i = 0; i < rounds; i++) {
    const e = await d.getNextEncoder(opts.premium ?? false, null, opts.isShort ?? false, opts.gated ?? false, failedWorkers);
    names.add(e.name);
  }
  return names;
}

const only = (s: Set<string>, name: string) => s.size === 1 && s.has(name);
const show = (s: Set<string>) => `got ${JSON.stringify([...s])}`;

/** A Database whose collection records the last update call. */
function capturingDb(): { db: Database; last: () => { filter: any; update: any } } {
  let captured: { filter: any; update: any } = { filter: null, update: null };
  const db = new Database('mongodb://unused', 'unused', 'unused');
  const record = async (filter: any, update?: any) => {
    captured = { filter, update };
    return update === undefined ? null : { modifiedCount: 1 };
  };
  (db as any).db = {
    collection: () => ({ updateOne: record, findOneAndUpdate: record }),
  };
  return { db, last: () => captured };
}

async function main(): Promise<void> {
  section('Managed selection skips encoders that failed the job');
  {
    const pool = [encoder('a'), encoder('b')];
    ok('a failed → always b', only(await picks(pool, ['a']), 'b'), show(await picks(pool, ['a'])));
    ok('no failures → round robin over both', (await picks(pool, [])).size === 2);
    ok('a is the only encoder → retried on a', only(await picks([encoder('a')], ['a']), 'a'));
    ok('every encoder failed → still dispatches', (await picks(pool, ['a', 'b'])).size === 2);
    ok('unknown name in the list changes nothing', (await picks(pool, ['gone'])).size === 2);
  }

  section('Tier fallback');
  {
    const pool = [encoder('perf', { tier: 'performance' }), encoder('std')];
    ok('premium: performance failed → standard', only(await picks(pool, ['perf'], { premium: true }), 'std'));
    const perfAndLite = [encoder('perf', { tier: 'performance' }), encoder('lite', { tier: 'lite' })];
    ok('premium: performance failed, only lite left → back to performance, never lite',
      only(await picks(perfAndLite, ['perf'], { premium: true }), 'perf'), show(await picks(perfAndLite, ['perf'], { premium: true })));
    const shorts = [encoder('s1', { tier: 'lite' }), encoder('s2', { tier: 'performance' })];
    ok('short: s1 failed → s2', only(await picks(shorts, ['s1'], { isShort: true }), 's2'));
  }

  section('Gated jobs stay inside the trusted set');
  {
    const pool = [encoder('trusted', { trusted: true }), encoder('untrusted')];
    ok('only trusted encoder failed → retried on it, never the untrusted one',
      only(await picks(pool, ['trusted'], { gated: true }), 'trusted'), show(await picks(pool, ['trusted'], { gated: true })));
    const two = [encoder('t1', { trusted: true }), encoder('t2', { trusted: true }), encoder('u')];
    ok('t1 failed → t2', only(await picks(two, ['t1'], { gated: true }), 't2'));
  }

  section('Requeue paths record the failed encoder');
  {
    const { db, last } = capturingDb();
    await db.incrementJobAttempt('o', 'p', 'enc-a');
    ok('incrementJobAttempt adds the encoder', last().update?.$addToSet?.failedWorkers === 'enc-a', JSON.stringify(last().update));
    await db.incrementJobAttempt('o', 'p');
    ok('incrementJobAttempt without an encoder adds nothing', last().update?.$addToSet === undefined);

    await db.resetStalledJob('o', 'p', 'enc-b');
    ok('resetStalledJob adds the stalled encoder in the same update',
      last().update?.$addToSet?.failedWorkers === 'enc-b' && last().update?.$inc?.attemptCount === 1);
    await db.resetStalledJob('o', 'p', null);
    ok('resetStalledJob with no assigned encoder adds nothing', last().update?.$addToSet === undefined);

    await db.resetJob('o', 'p');
    ok('admin reset clears the list', last().update?.$unset?.failedWorkers === '');
  }

  section('Dispatch error records the encoder it was sent to');
  {
    const job: Partial<EncodingJob> = { owner: 'o', permlink: 'p', attemptCount: 0, premium: false, failedWorkers: [] };
    let claimed = false;
    const recorded: Array<string | null> = [];
    const fakeDb = {
      getStalledJobs: async () => [],
      claimNextManagedJob: async () => (claimed ? null : (claimed = true, job)),
      getVideo: async () => ({ permlink: 'p', input_cid: 'cid', short: false, size: 10 }),
      getAllEncoders: async () => [encoder('down')],
      incrementJobAttempt: async (_o: string, _p: string, w: string | null = null) => { recorded.push(w); },
      updateJobStatus: async () => {},
      updateVideoStatus: async () => {},
    } as unknown as Database;
    const realFetch = globalThis.fetch;
    const realError = console.error;
    globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as any;
    console.error = () => {};
    try {
      await (new JobDispatcher(fakeDb, { webhookUrl: '', webhookApiKey: '' } as any) as any).processJobs();
    } finally {
      globalThis.fetch = realFetch;
      console.error = realError;
    }
    ok('unreachable encoder is recorded', recorded.length === 1 && recorded[0] === 'down', JSON.stringify(recorded));
  }

  section('Community claim');
  {
    const { db, last } = capturingDb();
    await db.claimNextCommunityJob('community-x', null);
    const f = last().filter;
    ok('skips jobs this encoder failed', f?.failedWorkers?.$ne === 'community-x', JSON.stringify(f));
    ok('existing premium/short/gated guards untouched', f?.premium === false && f?.short === false && f?.gated?.$ne === true);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ntest crashed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
