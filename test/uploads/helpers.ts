import { vi } from 'vitest';
import type { Database } from '../../src/database/mongodb';
import { signUploadToken, generateTokenId, UploadTokenClaims } from '../../src/utils/uploadToken';

/** The raw Mongo handle behind a Database (for seeding rows the API cannot create). */
export function rawDb(database: Database): any {
  return (database as any).db;
}

/** A checker GET /publish-quota body ("allowed" unless `over` says otherwise). */
export function publishBody(over: Record<string, unknown> = {}) {
  return { success: true, enabled: true, exempt: false, reason: null, limit: 1, window_hours: 24, allowed: true, conflicts: [], next_free_at: null, ...over };
}

export type PublishStub = (owner: string, kind: string) => unknown;

/**
 * Replaces global fetch with a stub that answers the warm-up lookups only:
 * the checker's /incubation/authors says every handle in `incubating` is
 * incubating, and Hive says none of `hiveAccounts` exist except those listed.
 * Anything else is an unexpected outside call and fails the request.
 * Must be installed before the app builds its upload limiter (first request).
 */
/**
 * Stubs global fetch for the warm-up registry and Hive. `hiveCreated` gives an
 * account a `created` time (Hive's format, UTC without a zone); accounts
 * without one answer no `created`.
 *
 * The checker's GET /publish-quota/:owner answers with `publish(owner, kind)`
 * (a body, or `{ status }` for an HTTP error; throwing = unreachable), or
 * "allowed" when that returns undefined or is not given.
 */
export function installFetchStub(opts: { incubating?: string[]; hiveAccounts?: string[]; hiveCreated?: Record<string, string>; publish?: PublishStub } = {}) {
  const incubating = new Set(opts.incubating ?? []);
  const created = opts.hiveCreated ?? {};
  const hive = new Set([...(opts.hiveAccounts ?? []), ...Object.keys(created)]);
  const fn = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    const pq = u.match(/\/publish-quota\/([^?]+)\?kind=(\w+)/);
    if (pq) {
      const owner = decodeURIComponent(pq[1]);
      const out: any = opts.publish?.(owner, pq[2]);
      if (out && typeof out.status === 'number') return { ok: false, status: out.status, json: async () => ({}) };
      return json(out ?? publishBody({ kind: pq[2], limit: pq[2] === 'short' ? 3 : 1 }));
    }
    if (u.includes('/incubation/authors')) {
      const authors: Record<string, unknown> = {};
      for (const h of body.handles ?? []) if (incubating.has(h)) authors[h] = { status: 'incubating' };
      return json({ authors });
    }
    if (body.method === 'condenser_api.get_accounts') {
      return json({ result: (body.params?.[0] ?? []).filter((n: string) => hive.has(n)).map((name: string) => (created[name] ? { name, created: created[name] } : { name })) });
    }
    throw new Error(`unexpected outside call in test: ${u}`);
  });
  (globalThis as any).fetch = fn;
  return fn;
}

/** Inserts a video row whose bytes landed (so it counts toward the daily limit). */
export async function seedVideo(database: Database, owner: string, over: Record<string, unknown> = {}) {
  const { agoMs = 60_000, ...rest } = over as any;
  const permlink = (rest.permlink as string) ?? `seed${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date(Date.now() - agoMs);
  await rawDb(database).collection('embed-video').insertOne({
    owner, permlink, frontend_app: '3speak-tv', status: 'published', short: false,
    createdAt, updatedAt: createdAt, ...rest,
  });
  return permlink;
}

/** Signs an upload token directly (for claims the token route never issues, like expired ones). */
export function mintToken(secret: string, over: Partial<UploadTokenClaims> = {}): { token: string; claims: UploadTokenClaims } {
  const now = Math.floor(Date.now() / 1000);
  const claims: UploadTokenClaims = {
    jti: generateTokenId(), owner: 'minted', app: 'test-app', issuedByKey: 'test-app', short: false,
    maxFileSize: 1024 * 1024 * 1024, allowedOrigins: [], permlink: `m${generateTokenId().slice(0, 10)}`,
    iat: now, exp: now + 600, ...over,
  };
  return { token: signUploadToken(claims, secret), claims };
}

/** Unique-ish Hive-shaped owner name per test, so rows and caches never collide. */
let n = 0;
export function owner(prefix = 'user'): string {
  n += 1;
  return `${prefix}${n}${Math.random().toString(36).slice(2, 6)}`;
}
