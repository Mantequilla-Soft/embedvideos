/**
 * Tests for community encoder version reporting (issue #40).
 *
 * The property under test is backward compatibility: version fields are
 * observational, so a malformed or missing value must never cause a
 * rejection, and an encoder that doesn't report must behave exactly as today.
 *
 * Runs with no MongoDB and no network: the update builders are pure.
 *
 * Usage: npx ts-node --transpile-only scripts/test-encoder-version.ts
 */

import {
  parseReportedVersion,
  buildRegistrationVersionUpdate,
  buildHeartbeatVersionUpdate,
} from '../src/utils/encoderVersion';

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

const SHA = 'a'.repeat(32) + '0123abcd';
const SHA2 = 'b'.repeat(40);
const NOW = new Date('2026-10-30T00:00:00Z');
const isEmpty = (o: object) => Object.keys(o).length === 0;

section('parseReportedVersion: encoder_commit');
ok('accepts full lowercase SHA', parseReportedVersion({ encoder_commit: SHA }).encoderCommit === SHA);
ok('rejects short SHA', parseReportedVersion({ encoder_commit: SHA.slice(0, 7) }).encoderCommit === undefined);
ok('rejects uppercase', parseReportedVersion({ encoder_commit: SHA.toUpperCase() }).encoderCommit === undefined);
ok('rejects non-hex', parseReportedVersion({ encoder_commit: 'g'.repeat(40) }).encoderCommit === undefined);
ok('rejects 41 chars', parseReportedVersion({ encoder_commit: SHA + 'a' }).encoderCommit === undefined);
ok('rejects non-string', parseReportedVersion({ encoder_commit: 1234 }).encoderCommit === undefined);
ok('rejects legacy "2.0.0"', parseReportedVersion({ encoder_commit: '2.0.0' }).encoderCommit === undefined);

section('parseReportedVersion: behind_by');
ok('accepts 0', parseReportedVersion({ behind_by: 0 }).behindBy === 0);
ok('accepts 100000', parseReportedVersion({ behind_by: 100000 }).behindBy === 100000);
ok('rejects negative', parseReportedVersion({ behind_by: -1 }).behindBy === undefined);
ok('rejects numeric string', parseReportedVersion({ behind_by: '5' }).behindBy === undefined);
ok('rejects huge', parseReportedVersion({ behind_by: 100001 }).behindBy === undefined);
ok('rejects non-integer', parseReportedVersion({ behind_by: 1.5 }).behindBy === undefined);
ok('rejects NaN / Infinity', parseReportedVersion({ behind_by: NaN }).behindBy === undefined
  && parseReportedVersion({ behind_by: Infinity }).behindBy === undefined);
ok('rejects null', parseReportedVersion({ behind_by: null }).behindBy === undefined);

section('parseReportedVersion: old encoder payloads');
const legacy = parseReportedVersion({ name: 'x', cryptoAccounts: { hive: 'y' }, commit_hash: '2.0.0' });
ok('legacy node_info yields nothing', isEmpty(legacy));
ok('legacy heartbeat yields nothing', isEmpty(parseReportedVersion({ timestamp: 1, version: '2.0.0' })));
ok('non-object payload does not throw', isEmpty(parseReportedVersion(undefined)) && isEmpty(parseReportedVersion('x')));

section('buildRegistrationVersionUpdate');
{
  const u = buildRegistrationVersionUpdate({ encoderCommit: SHA, behindBy: 3 }, NOW);
  ok('stores commit, behindBy, reportedAt', u.$set.encoderCommit === SHA && u.$set.behindBy === 3 && u.$set.versionReportedAt === NOW);
  ok('unsets nothing', isEmpty(u.$unset));
}
{
  const u = buildRegistrationVersionUpdate({ encoderCommit: SHA }, NOW);
  ok('commit without behind_by clears stale behindBy', u.$set.encoderCommit === SHA && 'behindBy' in u.$unset && !('behindBy' in u.$set));
}
{
  const u = buildRegistrationVersionUpdate({}, NOW);
  ok('no commit sets nothing', isEmpty(u.$set));
  ok('no commit clears all version fields', 'encoderCommit' in u.$unset && 'behindBy' in u.$unset && 'versionReportedAt' in u.$unset);
}
{
  const u = buildRegistrationVersionUpdate({ behindBy: 4 }, NOW);
  ok('behind_by without a commit is ignored', isEmpty(u.$set) && 'behindBy' in u.$unset);
}
{
  const u = buildRegistrationVersionUpdate({}, NOW);
  ok('never touches protected fields', !['trusted', 'tier', 'access', 'enabled', 'banned']
    .some(k => k in u.$set || k in u.$unset));
}

section('buildHeartbeatVersionUpdate');
{
  const u = buildHeartbeatVersionUpdate({}, SHA, NOW);
  ok('no fields → no change', isEmpty(u.$set) && isEmpty(u.$unset));
}
{
  const u = buildHeartbeatVersionUpdate({ behindBy: 7 }, SHA, NOW);
  ok('behind_by only → updates behindBy', u.$set.behindBy === 7 && u.$set.versionReportedAt === NOW && isEmpty(u.$unset));
}
{
  const u = buildHeartbeatVersionUpdate({ behindBy: 7 }, undefined, NOW);
  ok('behind_by with no commit known → no change', isEmpty(u.$set) && isEmpty(u.$unset));
}
{
  const u = buildHeartbeatVersionUpdate({ encoderCommit: SHA, behindBy: 2 }, SHA, NOW);
  ok('same commit is not rewritten', !('encoderCommit' in u.$set) && u.$set.behindBy === 2);
}
{
  const u = buildHeartbeatVersionUpdate({ encoderCommit: SHA2 }, SHA, NOW);
  ok('changed commit without behind_by clears stale behindBy', u.$set.encoderCommit === SHA2 && 'behindBy' in u.$unset);
}
{
  const u = buildHeartbeatVersionUpdate({ encoderCommit: SHA2, behindBy: 0 }, undefined, NOW);
  ok('first commit on a legacy record is stored', u.$set.encoderCommit === SHA2 && u.$set.behindBy === 0 && isEmpty(u.$unset));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
