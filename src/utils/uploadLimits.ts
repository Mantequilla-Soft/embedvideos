/**
 * Daily upload limits for owners without 3Speak Pro.
 *
 * Rule (owner, 2026-11-20): at most `videosPerDay` regular videos and
 * `shortsPerDay` shorts per ROLLING 24 hours (defaults 1 and 3).
 *
 * What counts: rows in embed-video created in the last 24 hours whose status
 * says the bytes landed (COUNTED_UPLOAD_STATUSES in database/mongodb.ts). An
 * upload still in flight, a failed one and a deleted one do not use a slot.
 * Stream recordings (VODs) published by the hangouts server never count and are
 * never refused.
 *
 * Who is exempt: owners listed in UPLOAD_LIMIT_EXEMPT, 3Speak Pro owners
 * (embed-users `premium`), and warm-up accounts (incubating users with no Hive
 * account yet, who upload under their bare handle as `owner`).
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
export type ExemptReason = 'pro' | 'warmup' | 'listed';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** `frontend_app` the hangouts server stamps on the stream recordings it publishes. */
export const STREAM_VOD_APP = '3speak-hangouts';
export const LIMIT_ERROR_CODE = 'daily_upload_limit';

export interface LimiterDeps {
  getRecentCountedUploads(owner: string, since: Date): Promise<CountedUploadRow[]>;
  isUserPremium(owner: string): Promise<boolean>;
  streamRecordExists(host: string, roomName: string): Promise<boolean>;
  /** true = warm-up, false = not, null = could not tell (treated as exempt by check()). */
  isWarmup(owner: string): Promise<boolean | null>;
  now?: () => number;
}

export interface LimitRefusalBody {
  error: string;
  code: typeof LIMIT_ERROR_CODE;
  kind: UploadKind;
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
  video: KindQuota;
  short: KindQuota;
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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  limitFor(kind: UploadKind): number {
    return kind === 'short' ? this.cfg!.shortsPerDay : this.cfg!.videosPerDay;
  }

  isListed(owner: string): boolean {
    return !!this.cfg?.exempt.includes(owner.trim().toLowerCase().replace(/^@/, ''));
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

  /** Creation times (ms, oldest first) of this owner's counted uploads in the window, per kind. */
  async usage(owner: string): Promise<Record<UploadKind, number[]>> {
    const since = new Date(this.now() - DAY_MS);
    const rows = await this.deps.getRecentCountedUploads(owner, since);
    const out: Record<UploadKind, number[]> = { video: [], short: [] };
    for (const row of rows) {
      if (await this.isVodRow(owner, row)) continue;
      const t = new Date(row.createdAt).getTime();
      if (!Number.isFinite(t) || t < since.getTime()) continue;
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

  refusal(owner: string, kind: UploadKind, limit: number, times: number[]): LimitRefusal {
    const nextMs = this.nextSlotAt(times, limit);
    const nextAt = nextMs != null ? isoSeconds(nextMs) : null;
    const retryAfter = nextMs != null ? Math.max(1, Math.ceil((nextMs - this.now()) / 1000)) : null;
    const message = limit > 0
      ? `Free accounts can upload ${limit} ${noun(kind, limit)} per 24 hours. ` +
        `Your next ${kind} upload is possible at ${nextAt}. 3Speak Pro removes this limit.`
      : `Free accounts cannot upload ${noun(kind, 2)} at the moment. 3Speak Pro removes this limit.`;
    return {
      status: 429,
      body: {
        error: `Daily ${kind} upload limit reached`,
        code: LIMIT_ERROR_CODE,
        kind,
        limit,
        used: times.length,
        next_at: nextAt,
        retry_after_seconds: retryAfter,
        message,
        upgrade_url: this.upgradeUrl(owner),
      },
      headers: retryAfter != null ? { 'Retry-After': String(retryAfter) } : {},
    };
  }

  /**
   * May `owner` upload one more `kind`? Returns null to allow, or the refusal.
   *
   * Cheapest first: the count needs one indexed query, and only an owner who
   * is already at the limit pays for the Pro and warm-up lookups.
   */
  async check(owner: string, kind: UploadKind): Promise<LimitRefusal | null> {
    if (!this.enabled) return null;
    try {
      if (this.isListed(owner)) return null;
      const limit = this.limitFor(kind);
      const times = (await this.usage(owner))[kind];
      if (times.length < limit) return null;
      if (await this.deps.isUserPremium(owner)) return null;
      // null = the warm-up lookup could not answer: fail open.
      if ((await this.deps.isWarmup(owner)) !== false) return null;
      console.warn(`[uploadLimits] refused ${kind} for ${owner}: ${times.length}/${limit} in 24h`);
      return this.refusal(owner, kind, limit, times);
    } catch (err) {
      console.error(`[uploadLimits] check failed for ${owner}, allowing:`, (err as Error)?.message || err);
      return null;
    }
  }

  /** Why `owner` is exempt, or null. A warm-up lookup that cannot answer reports not exempt. */
  async exemptReason(owner: string): Promise<ExemptReason | null> {
    if (this.isListed(owner)) return 'listed';
    if (await this.deps.isUserPremium(owner)) return 'pro';
    if ((await this.deps.isWarmup(owner)) === true) return 'warmup';
    return null;
  }

  /** Body of GET /uploads/quota. Throws when the count cannot be read. */
  async quota(owner: string): Promise<QuotaResponse> {
    if (!this.enabled) {
      return { enabled: false, exempt: true, reason: null, video: { ...UNLIMITED }, short: { ...UNLIMITED } };
    }
    const [reason, usage] = await Promise.all([this.exemptReason(owner), this.usage(owner)]);
    const kindQuota = (kind: UploadKind): KindQuota => {
      const used = usage[kind].length;
      if (reason) return { limit: null, used, remaining: null, next_at: null };
      const limit = this.limitFor(kind);
      const next = this.nextSlotAt(usage[kind], limit);
      return { limit, used, remaining: Math.max(0, limit - used), next_at: next != null ? isoSeconds(next) : null };
    };
    return { enabled: true, exempt: reason !== null, reason, video: kindQuota('video'), short: kindQuota('short') };
  }
}

// ---- Warm-up detection -------------------------------------------------------

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

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
): (owner: string) => Promise<boolean | null> {
  const cache = new Map<string, { value: boolean; until: number }>();

  const remember = (h: string, value: boolean): boolean => {
    if (cache.size > 5000) cache.clear();
    cache.set(h, { value, until: Date.now() + ttlMs });
    return value;
  };

  const hiveAccountExists = async (h: string): Promise<boolean> => {
    let lastErr: unknown = new Error('no Hive API nodes configured');
    for (const node of cfg.hiveApiNodes) {
      try {
        const res = await postJson(fetchImpl, node, {
          jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[h]],
        }, timeoutMs);
        if (!Array.isArray(res?.result)) throw new Error(`bad get_accounts answer from ${node}`);
        return res.result.some((a: any) => a?.name === h);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

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
    const isWarmup = cfg ? createWarmupLookup(cfg) : async () => null;
    limiter = new UploadLimiter(cfg, {
      getRecentCountedUploads: (owner, since) => database.getRecentCountedUploads(owner, since),
      isUserPremium: (owner) => database.isUserPremium(owner),
      streamRecordExists: (host, room) => database.streamRecordExists(host, room),
      isWarmup,
    });
    limiters.set(database, { cfg, limiter });
  }
  return limiter;
}
