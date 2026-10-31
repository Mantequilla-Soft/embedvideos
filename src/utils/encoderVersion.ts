/**
 * Version reporting from community encoders (3speakencoder, behind
 * EMBED_REPORT_COMMIT=true).
 *
 * Purely observational. Every field here is optional and anything malformed
 * is dropped, never rejected: a registration or heartbeat must not fail
 * because of a version field, or a buggy encoder release would knock every
 * node that runs it off the network.
 */

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_BEHIND_BY = 100000;

export interface ReportedVersion {
  encoderCommit?: string;
  behindBy?: number;
}

export interface VersionUpdate {
  $set: Record<string, unknown>;
  $unset: Record<string, ''>;
}

/** Extracts the valid version fields from a JWS payload; invalid ones are omitted. */
export function parseReportedVersion(payload: any): ReportedVersion {
  const result: ReportedVersion = {};
  if (!payload || typeof payload !== 'object') return result;

  const commit = payload.encoder_commit;
  if (typeof commit === 'string' && FULL_SHA.test(commit)) {
    result.encoderCommit = commit;
  }

  const behind = payload.behind_by;
  if (typeof behind === 'number' && Number.isInteger(behind) && behind >= 0 && behind <= MAX_BEHIND_BY) {
    result.behindBy = behind;
  }

  return result;
}

/**
 * Registration happens once per encoder start, so it describes the code that
 * is running right now. Anything not reported is cleared: an encoder that
 * restarted onto non-reporting code (or hasn't done its first GitHub check
 * yet) would otherwise keep showing the previous run's values.
 */
export function buildRegistrationVersionUpdate(reported: ReportedVersion, now: Date): VersionUpdate {
  if (reported.encoderCommit === undefined) {
    return { $set: {}, $unset: { encoderCommit: '', behindBy: '', versionReportedAt: '' } };
  }
  const update: VersionUpdate = {
    $set: { encoderCommit: reported.encoderCommit, versionReportedAt: now },
    $unset: {},
  };
  if (reported.behindBy !== undefined) {
    update.$set.behindBy = reported.behindBy;
  } else {
    update.$unset.behindBy = '';
  }
  return update;
}

/**
 * Heartbeats only ever add information. Encoders with reporting off never
 * send these fields, so their absence says nothing and the stored values stay.
 */
export function buildHeartbeatVersionUpdate(reported: ReportedVersion, storedCommit: string | undefined, now: Date): VersionUpdate {
  const update: VersionUpdate = { $set: {}, $unset: {} };

  if (reported.encoderCommit !== undefined && reported.encoderCommit !== storedCommit) {
    update.$set.encoderCommit = reported.encoderCommit;
    // A behind count measured against the old commit is meaningless for the new one.
    if (reported.behindBy === undefined) update.$unset.behindBy = '';
  }
  if (reported.behindBy !== undefined) {
    update.$set.behindBy = reported.behindBy;
  }
  if (Object.keys(update.$set).length > 0) {
    update.$set.versionReportedAt = now;
  }
  return update;
}
