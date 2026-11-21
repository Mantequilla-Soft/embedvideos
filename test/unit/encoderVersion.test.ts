import { describe, it, expect } from 'vitest';
import {
  parseReportedVersion,
  buildRegistrationVersionUpdate,
  buildHeartbeatVersionUpdate,
} from '../../src/utils/encoderVersion';

const SHA = 'a'.repeat(40);
const SHA2 = '0123456789abcdef0123456789abcdef01234567';
const NOW = new Date('2026-11-01T00:00:00Z');

describe('parseReportedVersion', () => {
  it('keeps a full lowercase SHA and a sane behind count', () => {
    expect(parseReportedVersion({ encoder_commit: SHA2, behind_by: 3 })).toEqual({ encoderCommit: SHA2, behindBy: 3 });
    expect(parseReportedVersion({ behind_by: 0 })).toEqual({ behindBy: 0 });
    expect(parseReportedVersion({ behind_by: 100000 })).toEqual({ behindBy: 100000 });
  });

  it.each([
    ['short SHA', { encoder_commit: SHA.slice(0, 7) }],
    ['uppercase SHA', { encoder_commit: SHA2.toUpperCase() }],
    ['41 chars', { encoder_commit: SHA + 'a' }],
    ['non-hex', { encoder_commit: 'g'.repeat(40) }],
    ['number commit', { encoder_commit: 1234 }],
    ['negative behind', { behind_by: -1 }],
    ['huge behind', { behind_by: 100001 }],
    ['fractional behind', { behind_by: 1.5 }],
    ['string behind', { behind_by: '5' }],
    ['NaN behind', { behind_by: NaN }],
    ['null behind', { behind_by: null }],
  ])('drops %s', (_label, payload) => {
    expect(parseReportedVersion(payload)).toEqual({});
  });

  it('tolerates non-object payloads', () => {
    expect(parseReportedVersion(undefined)).toEqual({});
    expect(parseReportedVersion(null)).toEqual({});
    expect(parseReportedVersion('x')).toEqual({});
  });
});

describe('buildRegistrationVersionUpdate', () => {
  it('clears everything when no commit is reported', () => {
    expect(buildRegistrationVersionUpdate({ behindBy: 4 }, NOW)).toEqual({
      $set: {},
      $unset: { encoderCommit: '', behindBy: '', versionReportedAt: '' },
    });
  });

  it('sets commit + behind + timestamp when both are reported', () => {
    expect(buildRegistrationVersionUpdate({ encoderCommit: SHA, behindBy: 2 }, NOW)).toEqual({
      $set: { encoderCommit: SHA, behindBy: 2, versionReportedAt: NOW },
      $unset: {},
    });
  });

  it('clears a stale behind count when only the commit is reported', () => {
    expect(buildRegistrationVersionUpdate({ encoderCommit: SHA }, NOW)).toEqual({
      $set: { encoderCommit: SHA, versionReportedAt: NOW },
      $unset: { behindBy: '' },
    });
  });
});

describe('buildHeartbeatVersionUpdate', () => {
  it('is a no-op with nothing reported', () => {
    expect(buildHeartbeatVersionUpdate({}, SHA, NOW)).toEqual({ $set: {}, $unset: {} });
  });

  it('ignores a behind count when no commit is known at all', () => {
    expect(buildHeartbeatVersionUpdate({ behindBy: 7 }, undefined, NOW)).toEqual({ $set: {}, $unset: {} });
  });

  it('updates the behind count against the stored commit', () => {
    expect(buildHeartbeatVersionUpdate({ behindBy: 7 }, SHA, NOW)).toEqual({
      $set: { behindBy: 7, versionReportedAt: NOW },
      $unset: {},
    });
  });

  it('does not rewrite an unchanged commit', () => {
    expect(buildHeartbeatVersionUpdate({ encoderCommit: SHA }, SHA, NOW)).toEqual({ $set: {}, $unset: {} });
  });

  it('a new commit without a behind count drops the old count', () => {
    expect(buildHeartbeatVersionUpdate({ encoderCommit: SHA2 }, SHA, NOW)).toEqual({
      $set: { encoderCommit: SHA2, versionReportedAt: NOW },
      $unset: { behindBy: '' },
    });
  });

  it('a new commit with a behind count sets both', () => {
    expect(buildHeartbeatVersionUpdate({ encoderCommit: SHA2, behindBy: 0 }, undefined, NOW)).toEqual({
      $set: { encoderCommit: SHA2, behindBy: 0, versionReportedAt: NOW },
      $unset: {},
    });
  });
});
