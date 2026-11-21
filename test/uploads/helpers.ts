import { vi } from 'vitest';
import type { Database } from '../../src/database/mongodb';
import { signUploadToken, generateTokenId, UploadTokenClaims } from '../../src/utils/uploadToken';

/** The raw Mongo handle behind a Database (for seeding rows the API cannot create). */
export function rawDb(database: Database): any {
  return (database as any).db;
}

/**
 * Replaces global fetch with a stub that answers the warm-up lookups only:
 * the checker's /incubation/authors says every handle in `incubating` is
 * incubating, and Hive says none of `hiveAccounts` exist except those listed.
 * Anything else is an unexpected outside call and fails the request.
 * Must be installed before the app builds its upload limiter (first request).
 */
export function installFetchStub(opts: { incubating?: string[]; hiveAccounts?: string[] } = {}) {
  const incubating = new Set(opts.incubating ?? []);
  const hive = new Set(opts.hiveAccounts ?? []);
  const fn = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/incubation/authors')) {
      const authors: Record<string, unknown> = {};
      for (const h of body.handles ?? []) if (incubating.has(h)) authors[h] = { status: 'incubating' };
      return json({ authors });
    }
    if (body.method === 'condenser_api.get_accounts') {
      return json({ result: (body.params?.[0] ?? []).filter((n: string) => hive.has(n)).map((name: string) => ({ name })) });
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
