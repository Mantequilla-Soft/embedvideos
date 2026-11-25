/**
 * Daily upload limits for owners without 3Speak Pro.
 *
 * Who is limited (owner, 2026-11-25): warm-up accounts, by default, and free
 * Hive accounts uploading through other apps (below). Free Hive accounts have
 * no upload cap: their limit moved to PUBLISHING (1 video and 3 shorts per 24
 * hours by publish time), which the checker enforces when a post is
 * scheduled, so anything over it is scheduled for a free time. Their quota
 * answers exempt with reason 'publish_limit'.
 *
 * Other apps (owner, 2026-11-25): an app outside UPLOAD_PUBLISH_CHECK_SKIP_APPS
 * (Ecency, Snapie, PeakD, ...) publishes to Hive straight after the upload and
 * cannot schedule, so the publish limit is checked here for it: a free Hive
 * account uploading through such an app is refused while the checker says it
 * cannot publish one more of that kind right now (GET /publish-quota/:owner),
 * and its quota reports the free plan again. The app is the API key's
 * `app_name` (for a token upload, the key that issued the token), never a
 * client-supplied field. 3speak.tv's studio and editor (the default skip list)
 * check the publish limit themselves and let people schedule.
 *
 * Warm-up accounts (owner, 2026-11-22): at most `warmupVideosPerDay` regular
 * videos and `warmupShortsPerDay` shorts per ROLLING 24 hours (defaults 3 and
 * 3). They cannot schedule, so their cap stays on uploading.
 * Free Hive accounts, only with UPLOAD_LIMIT_FREE_UPLOADS_CAPPED=true (the
 * rule of 2026-11-20): `videosPerDay` regular videos and `shortsPerDay` shorts
 * per rolling 24 hours (defaults 1 and 3). Each refusal and quota says which
 * `plan` applied ('free' or 'warmup').
 *
 * What counts: rows in embed-video created in the last 24 hours whose status
 * says the bytes landed (COUNTED_UPLOAD_STATUSES in database/mongodb.ts). An
 * upload still in flight, a failed one and a deleted one do not use a slot.
 * Stream recordings (VODs) published by the hangouts server never count and are
 * never refused. Nor are replacements: an upload that replaces the media of an
 * existing video of the same owner (verified against the database, see
 * verifyReplacementTarget), as long as it is then registered as one.
 *
 * Who is exempt: owners listed in UPLOAD_LIMIT_EXEMPT and 3Speak Pro owners
 * (embed-users `premium`), and free Hive accounts while their uploads are not
 * capped.
 *
 * The warm-up backlog never counts for a Hive account (owner, 2026-11-22; it
 * only matters while free uploads are capped). A warm-up user (incubating, no
 * Hive account yet) uploads under the bare handle as `owner`. At graduation
 * those uploads become the new Hive account's: either the checker's
 * claim-assets rewrites `owner` and stamps `owner_claimed_from`, or the handle
 * IS the Hive name and the rows stay as they are. Neither kind uses a slot of
 * the Hive account: rows with `owner_claimed_from` are dropped, and so are rows
 * created before the Hive account itself (nobody could have uploaded as that
 * Hive account before it existed).
 *
 * Enforced server side for every app on this API: at POST /uploads/token and
 * again when an upload is created (TUS pre-create, /upload/simple,
 * /upload/chunk/create), which is the only point an X-API-Key upload passes.
 * The embed API key ships in browser bundles, so an API-key upload is held to
 * the same limit or the token-route check could simply be skipped.
 *
 * Known limits of the scheme:
 * - `owner` is not cryptographically verified on either path (the API key is
 *   public). The limit is per owner NAME; it stops ordinary users, not someone
 *   uploading under names that are not theirs.
 * - Two uploads started at the same moment can both pass: neither has landed
 *   yet, so neither is counted. The upload-time re-check catches a second one
 *   that starts after the first has landed.
 *
 * Everything here FAILS OPEN: a lookup that errors (Mongo, the checker, Hive)
 * lets the upload through. A broken dependency must not stop everyone uploading.
 */

import type { CountedUploadRow, Database } from '../database/mongodb';
import type { Config, UploadLimitsConfig } from '../config/config';

export type UploadKind = 'video' | 'short';
/** 'publish_limit' = a free Hive account while its uploads are not capped (limited when publishing instead). */
export type ExemptReason = 'pro' | 'listed' | 'publish_limit';
/** Which limit applied: the free plan of a Hive account, or a warm-up account's. */
export type UploadPlan = 'free' | 'warmup';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** `frontend_app` the hangouts server stamps on the stream recordings it publishes. */
export const STREAM_VOD_APP = '3speak-hangouts';
export const LIMIT_ERROR_CODE = 'daily_upload_limit';
/**
 * A replacement upload that was never registered as one (POST
 * /video/:permlink/replaces) within this long of its creation starts counting
 * like a normal upload. The frontend registers right after the bytes land, so
 * this only has to outlast a slow upload. It closes the obvious dodge: claiming
 * "replaces my old video" on every upload and then using the new asset as an
 * ordinary video.
 */
export const REPLACEMENT_REGISTER_GRACE_MS = 6 * 60 * 60 * 1000;

/** What verifyReplacementTarget needs from the database. */
export interface ReplacementLookups {
  getVideo(permlink: string): Promise<{ owner: string } | null>;
  getLegacyVideo(permlink: string): Promise<{ owner: string } | null>;
}

/**
 * Is `target` an existing video (embed-video, or the legacy `videos`
 * collection) owned by `owner`? Same rule POST /video/:permlink/replaces
 * applies when the swap is registered. A client flag alone never makes an
 * upload a replacement.
 *
 * true = verified, false = confirmed not (missing, someone else's, itself, not
 * a string): an ordinary upload. null = the lookup failed, so nobody can tell:
 * callers let the upload through without the limit (fail open, like every
 * other lookup here) but do not record it as a verified replacement.
 */
export async function verifyReplacementTarget(
  db: ReplacementLookups,
  owner: string,
  target: unknown,
  newPermlink?: string,
): Promise<boolean | null> {
  if (typeof target !== 'string' || !target.trim()) return false;
  const t = target.trim();
  if (newPermlink && t === newPermlink) return false;
  try {
    const video = (await db.getVideo(t)) ?? (await db.getLegacyVideo(t));
    return !!video && video.owner === owner;
  } catch (err) {
    console.warn(`[uploadLimits] replacement target lookup failed for ${owner}/${t}:`, (err as Error)?.message || err);
    return null;
  }
}

export interface LimiterDeps {
  getRecentCountedUploads(owner: string, since: Date): Promise<CountedUploadRow[]>;
  isUserPremium(owner: string): Promise<boolean>;
  streamRecordExists(host: string, roomName: string): Promise<boolean>;
  /** true = warm-up, false = not, null = could not tell (check() lets the upload through). */
  isWarmup(owner: string): Promise<boolean | null>;
  /**
   * When the Hive account `owner` was created (ms; 0 = exists, time unknown),
   * or null when there is no such account. Throws when the lookup fails.
   * Missing = never known: no row is dropped for its age.
   */
  hiveAccountCreatedAt?(owner: string): Promise<number | null>;
  /**
   * The checker's publish quota for `owner` and `kind` right now, or null when
   * it cannot answer (callers let the upload through). Missing = the publish
   * limit is never checked.
   */
  publishQuota?(owner: string, kind: UploadKind): Promise<PublishAnswer | null>;
  now?: () => number;
}

/** The checker's publish quota for one owner and kind, as this service reads it. */
export interface PublishAnswer {
  /** May the owner publish one more of this kind right now? */
  allowed: boolean;
  /** Publishes per window; null = the checker does not limit this owner (exempt, or its limit is off). */
  limit: number | null;
  /** Publishes holding a slot (the checker's conflicts). */
  used: number;
  /** When the next one can go out (ms), or null when unknown. */
  nextMs: number | null;
  /** Length of the checker's window in hours. */
  windowHours: number;
}

export interface CheckOptions {
  /**
   * `app_name` of the API key behind the upload (for a token upload, the key
   * that issued the token). Decides whether the publish limit is checked; null
   * or absent = not checked.
   */
  app?: string | null;
}

export interface LimitRefusalBody {
  error: string;
  code: typeof LIMIT_ERROR_CODE;
  kind: UploadKind;
  plan: UploadPlan;
  limit: number;
  used: number;
  next_at: string | null;
  retry_after_seconds: number | null;
  message: string;
  upgrade_url: string;
}

export interface LimitRefusal {
  status: 429;
  body: LimitRefusalBody;
  /** `Retry-After` (seconds) when a next slot time is known. */
  headers: Record<string, string>;
}

export interface KindQuota {
  /** null = unlimited (exempt, or limits disabled). */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** When the next slot frees up. null while slots remain, or when unlimited. */
  next_at: string | null;
}

export interface QuotaResponse {
  enabled: boolean;
  exempt: boolean;
  reason: ExemptReason | null;
  /** The limit that applies; null when exempt or the limits are off. */
  plan: UploadPlan | null;
  video: KindQuota;
  short: KindQuota;
}

/**
 * Hive account names are lowercase, so `Alice`, ` alice` and `@alice` are the
 * same owner. Rows are written and counted under this form; without it each
 * spelling had its own daily allowance.
 */
export function normalizeOwner(name: unknown): string {
  return String(name ?? '').trim().replace(/^@/, '').toLowerCase();
}

/** ISO 8601 without milliseconds, e.g. 2026-11-21T14:32:00Z. */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function noun(kind: UploadKind, n: number): string {
  return `${kind}${n === 1 ? '' : 's'}`;
}

const UNLIMITED: KindQuota = { limit: null, used: 0, remaining: null, next_at: null };

export class UploadLimiter {
  constructor(private readonly cfg: UploadLimitsConfig | undefined, private readonly deps: LimiterDeps) {}

  get enabled(): boolean {
    return this.cfg?.enabled === true;
  }

  /** Are free Hive accounts held to an upload cap? Off by default: they are limited when publishing. */
  get freeUploadsCapped(): boolean {
    return this.cfg?.freeUploadsCapped === true;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  limitFor(kind: UploadKind, plan: UploadPlan = 'free'): number {
    if (plan === 'warmup') return kind === 'short' ? this.cfg!.warmupShortsPerDay : this.cfg!.warmupVideosPerDay;
    return kind === 'short' ? this.cfg!.shortsPerDay : this.cfg!.videosPerDay;
  }

  isListed(owner: string): boolean {
    return !!this.cfg?.exempt.includes(owner.trim().toLowerCase().replace(/^@/, ''));
  }

  /**
   * Is the publish limit checked for uploads through `app` (an API key's
   * `app_name`)? Only while free uploads are not capped (capped, the upload
   * cap applies instead) and for apps outside the skip list.
   */
  checksPublishFor(app: string | null | undefined): boolean {
    if (!this.enabled || this.freeUploadsCapped || this.cfg?.publishCheckEnabled !== true || !this.deps.publishQuota) return false;
    if (app == null) return false;
    return !(this.cfg.publishCheckSkipApps ?? []).includes(String(app).trim().toLowerCase());
  }

  upgradeUrl(owner: string): string {
    // `{owner}`, or `{user}` as snapieaudio's AUDIO_UPGRADE_URL spells it.
    return (this.cfg?.upgradeUrl || 'https://3speak.tv/wallet/{owner}#pro').replace(/\{(owner|user)\}/g, encodeURIComponent(owner));
  }

  /**
   * Is this counted row a stream recording? Rows written since the limit exist
   * carry the verdict made at upload time. Older hangouts rows are verified
   * now, the same way; a failing lookup counts as a VOD (fail open).
   */
  private async isVodRow(owner: string, row: CountedUploadRow): Promise<boolean> {
    if (row.stream_vod === true) return true;
    if (row.stream_vod === false) return false;
    if (row.frontend_app !== STREAM_VOD_APP || row.short === true) return false;
    try {
      return await this.deps.streamRecordExists(owner, row.permlink);
    } catch {
      return true;
    }
  }

  /**
   * A replacement upload is free once it is registered as the replacement
   * (`replacesPermlink`, set only by POST /video/:permlink/replaces after it
   * checked that both videos belong to the same owner), whether or not the
   * upload announced itself. A verified upload-time claim stays free while it
   * still has time to be registered; one never registered within the grace
   * period was used as an ordinary video and counts.
   */
  private isFreeReplacement(row: CountedUploadRow, createdMs: number): boolean {
    if (row.replacesPermlink) return true;
    if (row.replaces_existing !== true) return false;
    return this.now() - createdMs < REPLACEMENT_REGISTER_GRACE_MS;
  }

  /**
   * Creation times (ms, oldest first) of this owner's counted uploads in the
   * window, per kind. Warm-up uploads claimed onto this account never count;
   * `notBefore` (the Hive account's creation) also drops older rows, which were
   * uploaded under the same name while it was still a warm-up handle.
   */
  async usage(owner: string, notBefore: number | null = null): Promise<Record<UploadKind, number[]>> {
    const since = new Date(this.now() - DAY_MS);
    const rows = await this.deps.getRecentCountedUploads(owner, since);
    const out: Record<UploadKind, number[]> = { video: [], short: [] };
    for (const row of rows) {
      const t = new Date(row.createdAt).getTime();
      if (!Number.isFinite(t) || t < since.getTime()) continue;
      if (row.owner_claimed_from) continue;
      if (notBefore != null && t < notBefore) continue;
      if (this.isFreeReplacement(row, t)) continue;
      if (await this.isVodRow(owner, row)) continue;
      out[row.short === true ? 'short' : 'video'].push(t);
    }
    out.video.sort((a, b) => a - b);
    out.short.sort((a, b) => a - b);
    return out;
  }

  /** When the next slot frees, given creation times (oldest first) and the limit. */
  private nextSlotAt(times: number[], limit: number): number | null {
    if (limit <= 0 || times.length < limit) return null;
    return times[times.length - limit] + DAY_MS;
  }

  private buildRefusal(
    owner: string, kind: UploadKind, plan: UploadPlan, limit: number, used: number, nextMs: number | null,
    error: string, message: (nextAt: string | null) => string,
  ): LimitRefusal {
    const nextAt = nextMs != null ? isoSeconds(nextMs) : null;
    const retryAfter = nextMs != null ? Math.max(1, Math.ceil((nextMs - this.now()) / 1000)) : null;
    return {
      status: 429,
      body: {
        error,
        code: LIMIT_ERROR_CODE,
        kind,
        plan,
        limit,
        used,
        next_at: nextAt,
        retry_after_seconds: retryAfter,
        message: message(nextAt),
        upgrade_url: this.upgradeUrl(owner),
      },
      headers: retryAfter != null ? { 'Retry-After': String(retryAfter) } : {},
    };
  }

  refusal(owner: string, kind: UploadKind, limit: number, times: number[], plan: UploadPlan = 'free'): LimitRefusal {
    // A warm-up account cannot buy Pro (that needs a Hive account), so its
    // message names no way out but time.
    const who = plan === 'warmup' ? 'Warm-up accounts' : 'Free accounts';
    const pro = plan === 'warmup' ? '' : ' 3Speak Pro removes this limit.';
    return this.buildRefusal(owner, kind, plan, limit, times.length, this.nextSlotAt(times, limit), `Daily ${kind} upload limit reached`,
      (nextAt) => limit > 0
        ? `${who} can upload ${limit} ${noun(kind, limit)} per 24 hours. ` +
          `Your next ${kind} upload is possible at ${nextAt}.${pro}`
        : `${who} cannot upload ${noun(kind, 2)} at the moment.${pro}`);
  }

  /**
   * The refusal for a free Hive account the checker says cannot publish one
   * more `kind` now. Same body as the upload cap's, so apps that handle that
   * one need nothing new; `next_at` is when the next one can be published.
   */
  publishRefusal(owner: string, kind: UploadKind, answer: PublishAnswer): LimitRefusal {
    const limit = answer.limit ?? this.limitFor(kind, 'free');
    return this.buildRefusal(owner, kind, 'free', limit, answer.used, answer.nextMs, `Daily ${kind} publish limit reached`,
      (nextAt) => limit > 0
        ? `The free plan publishes ${limit} ${noun(kind, limit)} per ${answer.windowHours} hours. ` +
          (nextAt ? `Your next ${kind} can be published at ${nextAt}. ` : '') + '3Speak Pro removes this limit.'
        : `The free plan cannot publish ${noun(kind, 2)} at the moment. 3Speak Pro removes this limit.`);
  }

  /**
   * The publish limit for an upload through another app: the refusal when the
   * checker says `owner` cannot publish one more `kind` now and `owner` is a
   * free Hive account, else null. Pro is asked only after the checker says
   * no. A warm-up account is left to its own upload limit, and one whose
   * warm-up lookup cannot answer is let through (fail open).
   */
  private async publishCheck(owner: string, kind: UploadKind): Promise<LimitRefusal | null> {
    const answer = await this.deps.publishQuota!(owner, kind);
    if (!answer || answer.allowed || answer.limit == null) return null;
    if (await this.deps.isUserPremium(owner)) return null;
    if ((await this.deps.isWarmup(owner)) !== false) return null;
    console.warn(`[uploadLimits] refused ${kind} for ${owner} (free, publish limit): next publish at ${answer.nextMs != null ? isoSeconds(answer.nextMs) : 'unknown'}`);
    return this.publishRefusal(owner, kind, answer);
  }

  /**
   * Quota from the checker's publish limit (free plan), or null when a lookup
   * cannot answer or the checker limits neither kind: the caller answers
   * exempt 'publish_limit' then, as the upload is let through anyway.
   */
  private async publishQuotaFor(owner: string): Promise<QuotaResponse | null> {
    const ask = (kind: UploadKind) => this.deps.publishQuota!(owner, kind).catch(() => null);
    const [video, short] = await Promise.all([ask('video'), ask('short')]);
    if (!video || !short || (video.limit == null && short.limit == null)) return null;
    const kindQuota = (a: PublishAnswer): KindQuota => {
      if (a.limit == null) return { ...UNLIMITED, used: a.used };
      return {
        limit: a.limit,
        used: a.used,
        remaining: a.allowed ? Math.max(1, a.limit - a.used) : 0,
        next_at: !a.allowed && a.nextMs != null ? isoSeconds(a.nextMs) : null,
      };
    };
    return { enabled: true, exempt: false, reason: null, plan: 'free', video: kindQuota(video), short: kindQuota(short) };
  }

  /**
   * Which plan's limit applies to a non-exempt owner, and from when its rows
   * count. null = a lookup could not answer.
   */
  private async planFor(owner: string): Promise<{ plan: UploadPlan; notBefore: number | null } | null> {
    const warmup = await this.deps.isWarmup(owner);
    if (warmup === null) return null;
    if (warmup) return { plan: 'warmup', notBefore: null };
    // Uncapped, no free row is ever counted: no need to know the account's age.
    if (!this.freeUploadsCapped || !this.deps.hiveAccountCreatedAt) return { plan: 'free', notBefore: null };
    try {
      return { plan: 'free', notBefore: await this.deps.hiveAccountCreatedAt(owner) };
    } catch (err) {
      console.warn(`[uploadLimits] Hive account age lookup failed for ${owner}:`, (err as Error)?.message || err);
      return null;
    }
  }

  /**
   * May `owner` upload one more `kind`? Returns null to allow, or the refusal.
   * `opts.app` is the API key's app: through an app outside the skip list the
   * publish limit is checked first (see checksPublishFor).
   *
   * Cheapest first: the count needs one indexed query, and only an owner who
   * has used as many slots as the smallest limit that can apply pays for the
   * Pro, warm-up and Hive account lookups.
   */
  async check(rawOwner: string, kind: UploadKind, opts: CheckOptions = {}): Promise<LimitRefusal | null> {
    if (!this.enabled) return null;
    const owner = normalizeOwner(rawOwner);
    try {
      if (this.isListed(owner)) return null;
      if (this.checksPublishFor(opts.app)) {
        const refusal = await this.publishCheck(owner, kind);
        if (refusal) return refusal;
      }
      const all = (await this.usage(owner))[kind];
      const floor = this.freeUploadsCapped
        ? Math.min(this.limitFor(kind, 'free'), this.limitFor(kind, 'warmup'))
        : this.limitFor(kind, 'warmup');
      if (all.length < floor) return null;
      if (await this.deps.isUserPremium(owner)) return null;
      // null = a lookup could not answer: fail open.
      const p = await this.planFor(owner);
      if (!p) return null;
      // A free Hive account is limited when it publishes, not here.
      if (p.plan === 'free' && !this.freeUploadsCapped) return null;
      const limit = this.limitFor(kind, p.plan);
      const times = p.notBefore != null ? all.filter((t) => t >= p.notBefore!) : all;
      if (times.length < limit) return null;
      console.warn(`[uploadLimits] refused ${kind} for ${owner} (${p.plan}): ${times.length}/${limit} in 24h`);
      return this.refusal(owner, kind, limit, times, p.plan);
    } catch (err) {
      console.error(`[uploadLimits] check failed for ${owner}, allowing:`, (err as Error)?.message || err);
      return null;
    }
  }

  /**
   * Why `owner` is exempt, or null. Warm-up accounts are not exempt: they have
   * their own limit. While free uploads are not capped, every other owner is
   * ('publish_limit'), including one whose warm-up lookup cannot answer: its
   * upload is let through then anyway (check() fails open).
   */
  async exemptReason(owner: string): Promise<ExemptReason | null> {
    if (this.isListed(owner)) return 'listed';
    if (await this.deps.isUserPremium(owner)) return 'pro';
    if (!this.freeUploadsCapped && (await this.deps.isWarmup(owner)) !== true) return 'publish_limit';
    return null;
  }

  /**
   * Body of GET /uploads/quota. Throws when the count cannot be read.
   * `opts.app` as for check(): through another app a free Hive account gets
   * the free plan's publish quota instead of 'publish_limit'.
   */
  async quota(rawOwner: string, opts: CheckOptions = {}): Promise<QuotaResponse> {
    const owner = normalizeOwner(rawOwner);
    if (!this.enabled) {
      return { enabled: false, exempt: true, reason: null, plan: null, video: { ...UNLIMITED }, short: { ...UNLIMITED } };
    }
    const reason = await this.exemptReason(owner);
    // A warm-up lookup that cannot answer keeps 'publish_limit' (the upload
    // is let through then, see publishCheck).
    if (reason === 'publish_limit' && this.checksPublishFor(opts.app) && (await this.deps.isWarmup(owner)) === false) {
      const q = await this.publishQuotaFor(owner);
      if (q) return q;
    }
    if (reason) {
      const usage = await this.usage(owner);
      const unlimited = (kind: UploadKind): KindQuota => ({ limit: null, used: usage[kind].length, remaining: null, next_at: null });
      return { enabled: true, exempt: true, reason, plan: null, video: unlimited('video'), short: unlimited('short') };
    }
    // Uncapped, only a warm-up account gets this far (see exemptReason).
    // Capped, a lookup that cannot answer reports the free plan over every
    // row: the upload itself is let through then (check() fails open).
    const p = !this.freeUploadsCapped
      ? { plan: 'warmup' as UploadPlan, notBefore: null }
      : (await this.planFor(owner)) ?? { plan: 'free' as UploadPlan, notBefore: null };
    const usage = await this.usage(owner, p.notBefore);
    const kindQuota = (kind: UploadKind): KindQuota => {
      const used = usage[kind].length;
      const limit = this.limitFor(kind, p.plan);
      const next = this.nextSlotAt(usage[kind], limit);
      return { limit, used, remaining: Math.max(0, limit - used), next_at: next != null ? isoSeconds(next) : null };
    };
    return { enabled: true, exempt: false, reason: null, plan: p.plan, video: kindQuota('video'), short: kindQuota('short') };
  }
}

// ---- Warm-up detection -------------------------------------------------------

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Shape a warm-up handle can take; anything else is never looked up (and is not a warm-up). */
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

async function postJson(fetchImpl: FetchLike, url: string, body: unknown, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Hive `created` ("2026-11-20T10:00:00", UTC without a zone) as ms; 0 when unreadable. */
function hiveCreatedMs(created: unknown): number {
  if (typeof created !== 'string' || !created) return 0;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(created) ? created : `${created}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * When was the Hive account `name` created? ms (0 = exists, time unreadable),
 * or null when there is no such account. Throws when every node fails. Answers
 * are cached for `ttlMs`; failures are not.
 */
export function createHiveAccountLookup(
  cfg: Pick<UploadLimitsConfig, 'hiveApiNodes'>,
  fetchImpl: FetchLike = (globalThis as any).fetch,
  ttlMs = 5 * 60 * 1000,
  timeoutMs = 4000,
): (name: string) => Promise<number | null> {
  const cache = new Map<string, { value: number | null; until: number }>();
  return async (name: string): Promise<number | null> => {
    const h = String(name || '').trim().toLowerCase();
    if (!h) return null;
    const hit = cache.get(h);
    if (hit && hit.until > Date.now()) return hit.value;
    let lastErr: unknown = new Error('no Hive API nodes configured');
    for (const node of cfg.hiveApiNodes) {
      try {
        const res = await postJson(fetchImpl, node, {
          jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[h]],
        }, timeoutMs);
        if (!Array.isArray(res?.result)) throw new Error(`bad get_accounts answer from ${node}`);
        const acct = res.result.find((a: any) => a?.name === h);
        const value = acct ? hiveCreatedMs(acct.created) : null;
        if (cache.size > 5000) cache.clear();
        cache.set(h, { value, until: Date.now() + ttlMs });
        return value;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
}

/**
 * Is `owner` a warm-up account?
 *
 * Source of truth is the incubation registry, asked through the checker
 * (POST /incubation/authors, which relays Butter Auth's hosted incubation
 * service): the handle must exist there with status `incubating`. A registry
 * entry needs a Butter Auth signup, so a Hive account holder cannot claim it by
 * typing a name, which a bare "has no Hive account" test would allow (any
 * made-up owner has no Hive account).
 *
 * A handle the registry calls incubating is then checked against Hive: if a
 * Hive account by that name exists, the owner is a Hive account holder
 * (graduated, or someone else took the name on Hive) and is not exempt.
 *
 * Answers are cached for `ttlMs`. A lookup that errors returns null (unknown)
 * and is not cached, so the caller can fail open.
 */
export function createWarmupLookup(
  cfg: Pick<UploadLimitsConfig, 'warmupLookupUrl' | 'hiveApiNodes'>,
  fetchImpl: FetchLike = (globalThis as any).fetch,
  ttlMs = 5 * 60 * 1000,
  timeoutMs = 4000,
  hiveAccount: (name: string) => Promise<number | null> = createHiveAccountLookup(cfg, fetchImpl, ttlMs, timeoutMs),
): (owner: string) => Promise<boolean | null> {
  const cache = new Map<string, { value: boolean; until: number }>();

  const remember = (h: string, value: boolean): boolean => {
    if (cache.size > 5000) cache.clear();
    cache.set(h, { value, until: Date.now() + ttlMs });
    return value;
  };

  const hiveAccountExists = async (h: string): Promise<boolean> => (await hiveAccount(h)) !== null;

  return async (owner: string): Promise<boolean | null> => {
    const h = String(owner || '').trim().toLowerCase();
    if (!HANDLE_RE.test(h)) return false;
    const hit = cache.get(h);
    if (hit && hit.until > Date.now()) return hit.value;

    let incubating: boolean;
    try {
      const res = await postJson(fetchImpl, cfg.warmupLookupUrl, { handles: [h] }, timeoutMs);
      incubating = res?.authors?.[h]?.status === 'incubating';
    } catch (err) {
      console.warn(`[uploadLimits] warm-up lookup failed for ${h}:`, (err as Error)?.message || err);
      return null;
    }
    if (!incubating) return remember(h, false);

    try {
      return remember(h, !(await hiveAccountExists(h)));
    } catch (err) {
      console.warn(`[uploadLimits] Hive account lookup failed for ${h}:`, (err as Error)?.message || err);
      return null;
    }
  };
}

// ---- Publish limit (checker) ---------------------------------------------------

/**
 * Reads the checker's GET /publish-quota answer (`{ success, enabled, exempt,
 * limit, window_hours, allowed, conflicts, next_free_at }`). null = not an
 * answer (no boolean `allowed`, or `success: false`). A checker whose limit is
 * off, or that calls the owner exempt, allows with no limit. `fallbackLimit`
 * stands in for a missing `limit`.
 */
export function parsePublishQuota(body: any, fallbackLimit: number): PublishAnswer | null {
  if (!body || typeof body !== 'object' || body.success === false || typeof body.allowed !== 'boolean') return null;
  const windowHours = typeof body.window_hours === 'number' && body.window_hours > 0 ? body.window_hours : 24;
  const conflicts = Array.isArray(body.conflicts) ? body.conflicts.length : null;
  if (body.enabled === false || body.exempt === true) {
    return { allowed: true, limit: null, used: conflicts ?? 0, nextMs: null, windowHours };
  }
  const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit >= 0 ? Math.floor(body.limit) : fallbackLimit;
  const allowed = body.allowed;
  // Refused with no conflict listed: count the window as full.
  const used = conflicts != null && (allowed || conflicts > 0) ? conflicts : (allowed ? 0 : limit);
  const next = typeof body.next_free_at === 'string' ? Date.parse(body.next_free_at)
    : typeof body.next_free_at === 'number' ? body.next_free_at : NaN;
  return { allowed, limit, used, nextMs: Number.isFinite(next) ? next : null, windowHours };
}

/**
 * The checker's publish quota for an owner and kind (GET
 * `<publishCheckUrl>/publish-quota/:owner?kind=`). Answers are cached per
 * owner and kind for `ttlMs`. A failure (unreachable, timeout, non-200, not an
 * answer) returns null so the upload is let through, and is cached the same
 * way, so a checker that is down costs each owner one timeout per `ttlMs`, not
 * one per upload. Failures are logged at most once a minute.
 */
export function createPublishQuotaLookup(
  cfg: Pick<UploadLimitsConfig, 'publishCheckUrl' | 'videosPerDay' | 'shortsPerDay'>,
  fetchImpl: FetchLike = (globalThis as any).fetch,
  ttlMs = 30 * 1000,
  timeoutMs = 3000,
  now: () => number = Date.now,
): (owner: string, kind: UploadKind) => Promise<PublishAnswer | null> {
  const cache = new Map<string, { value: PublishAnswer | null; until: number }>();
  let lastWarn = -Infinity;
  return async (owner: string, kind: UploadKind): Promise<PublishAnswer | null> => {
    const h = normalizeOwner(owner);
    if (!h) return null;
    const key = `${kind}:${h}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    let value: PublishAnswer | null = null;
    const url = `${cfg.publishCheckUrl}/publish-quota/${encodeURIComponent(h)}?kind=${kind}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      value = parsePublishQuota(await r.json(), kind === 'short' ? cfg.shortsPerDay : cfg.videosPerDay);
      if (!value) throw new Error('not a publish quota answer');
    } catch (err) {
      value = null;
      if (now() - lastWarn >= 60 * 1000) {
        lastWarn = now();
        console.warn(`[uploadLimits] publish quota lookup failed (${url}), allowing:`, (err as Error)?.message || err);
      }
    } finally {
      clearTimeout(timer);
    }
    if (cache.size > 5000) cache.clear();
    cache.set(key, { value, until: now() + ttlMs });
    return value;
  };
}

// ---- Wiring ------------------------------------------------------------------

const limiters = new WeakMap<object, { cfg: UploadLimitsConfig | undefined; limiter: UploadLimiter }>();

/**
 * The process-wide limiter for this database and limits config, built on first
 * use (one per pair, so the warm-up cache is shared by every request).
 */
export function getUploadLimiter(database: Database, config: Config): UploadLimiter {
  const cfg = config.uploadLimits;
  const cached = limiters.get(database);
  let limiter = cached && cached.cfg === cfg ? cached.limiter : undefined;
  if (!limiter) {
    // One Hive account cache for both questions (is it a warm-up, how old is it).
    const hiveAccount = cfg ? createHiveAccountLookup(cfg) : undefined;
    const isWarmup = cfg ? createWarmupLookup(cfg, undefined, undefined, undefined, hiveAccount) : async () => null;
    limiter = new UploadLimiter(cfg, {
      getRecentCountedUploads: (owner, since) => database.getRecentCountedUploads(owner, since),
      isUserPremium: (owner) => database.isUserPremium(owner),
      streamRecordExists: (host, room) => database.streamRecordExists(host, room),
      isWarmup,
      ...(hiveAccount ? { hiveAccountCreatedAt: hiveAccount } : {}),
      ...(cfg ? { publishQuota: createPublishQuotaLookup(cfg) } : {}),
    });
    limiters.set(database, { cfg, limiter });
  }
  return limiter;
}
