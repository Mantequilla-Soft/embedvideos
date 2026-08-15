/**
 * 🔐 Tests for gated (paid) content dispatch routing.
 *
 * The property under test is a safety property, not a feature: a gated job must
 * never reach an encoder we do not operate. An encoder holds the plaintext
 * source of everything it transcodes, so that disclosure cannot be undone.
 *
 * Runs with no MongoDB and no network. Encoder selection is exercised against a
 * stub database, and the community claim filter is captured from a fake
 * collection so the query shape can be asserted without a live server.
 *
 * Usage: npx ts-node scripts/test-gated-dispatch.ts
 */

import { JobDispatcher } from '../src/dispatcher/jobDispatcher';
import { Database, Encoder } from '../src/database/mongodb';

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

/** Builds a dispatcher whose only real dependency is the encoder list. */
function dispatcherWith(encoders: Encoder[]): any {
  const fakeDb = { getAllEncoders: async () => encoders } as unknown as Database;
  return new JobDispatcher(fakeDb, { webhookUrl: '', webhookApiKey: '' } as any) as any;
}

async function select(
  encoders: Encoder[],
  opts: { premium?: boolean; fileSize?: number | null; isShort?: boolean; gated?: boolean } = {},
): Promise<{ name?: string; error?: string }> {
  const d = dispatcherWith(encoders);
  try {
    const chosen = await d.getNextEncoder(
      opts.premium ?? false,
      opts.fileSize ?? null,
      opts.isShort ?? false,
      opts.gated ?? false,
    );
    return { name: chosen.name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  section('Gated jobs never leave the trusted set');

  const mixed = [
    encoder('untrusted-a'),
    encoder('untrusted-b', { tier: 'performance' }),
    encoder('trusted-a', { trusted: true }),
  ];

  const r1 = await select(mixed, { gated: true });
  ok('a gated job picks a trusted encoder', r1.name === 'trusted-a', JSON.stringify(r1));

  // Premium normally prefers the performance tier. Here the only performance
  // encoder is untrusted, so the trusted standard one must win instead: the
  // trusted filter has to beat the tier preference, not lose to it.
  const r2 = await select(mixed, { gated: true, premium: true });
  ok('a gated premium job does not fall back to an untrusted performance encoder', r2.name === 'trusted-a', JSON.stringify(r2));

  // Shorts take an "any managed encoder" path with its own maxFileSize
  // fallback, which is exactly the kind of branch that leaks if the trusted
  // filter is applied per-branch instead of up front.
  const r3 = await select(mixed, { gated: true, isShort: true });
  ok('a gated short job stays trusted', r3.name === 'trusted-a', JSON.stringify(r3));

  // The maxFileSize fallback explicitly ignores size limits. It must still not
  // ignore trust.
  const sizeCapped = [
    encoder('untrusted-big'),
    encoder('trusted-small', { trusted: true, maxFileSize: 1000 }),
  ];
  const r4 = await select(sizeCapped, { gated: true, isShort: true, fileSize: 999_999 });
  ok('the short-video size fallback does not escape the trusted set', r4.name === 'trusted-small', JSON.stringify(r4));

  section('No trusted encoder means no dispatch');

  const r5 = await select([encoder('untrusted-only')], { gated: true });
  ok('a gated job with no trusted encoder fails rather than falling back', Boolean(r5.error), JSON.stringify(r5));
  ok('the failure explains how to fix it', Boolean(r5.error?.includes('trusted')), r5.error);

  const r6 = await select([encoder('untrusted-only')], { gated: true, premium: true });
  ok('same for premium gated', Boolean(r6.error));

  const r7 = await select([encoder('untrusted-only')], { gated: true, isShort: true });
  ok('same for short gated', Boolean(r7.error));

  section('Trust is ignored for ordinary jobs');

  const r8 = await select([encoder('untrusted-a')], { gated: false });
  ok('a normal job still dispatches to an untrusted encoder', r8.name === 'untrusted-a', JSON.stringify(r8));

  const r9 = await select([encoder('trusted-a', { trusted: true })], { gated: false });
  ok('a normal job may also use a trusted encoder', r9.name === 'trusted-a', JSON.stringify(r9));

  section('Community encoders are excluded even when marked trusted');

  // access:'community' is filtered before the trusted check, so a community row
  // that somehow carries trusted:true still cannot be push-dispatched.
  const rogue = [encoder('rogue-community', { access: 'community', trusted: true })];
  const r10 = await select(rogue, { gated: true });
  ok('a community encoder with trusted:true is still not dispatched a gated job', Boolean(r10.error), JSON.stringify(r10));

  section('Community claim filter excludes gated work');

  let capturedFilter: any = null;
  const db = new Database('mongodb://unused', 'unused', 'unused');
  (db as any).db = {
    collection: () => ({
      findOneAndUpdate: async (filter: any) => {
        capturedFilter = filter;
        return null;
      },
    }),
  };

  await db.claimNextCommunityJob('community-node', null);
  ok('claim filter carries a gated exclusion', capturedFilter?.gated !== undefined, JSON.stringify(capturedFilter));
  ok('gated exclusion is $ne:true, not an equality on false', capturedFilter?.gated?.$ne === true,
    'An equality check on gated:false would strand every pre-existing pending job, which lacks the field entirely.');
  ok('existing premium/short guards are untouched', capturedFilter?.premium === false && capturedFilter?.short === false);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ntest crashed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
