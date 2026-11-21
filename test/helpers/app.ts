import request from 'supertest';
import type { Database } from '../../src/database/mongodb';

export const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_PASSWORD}` };

let loaded: Promise<{ app: any; database: Database; config: any; mod: any }> | undefined;

/**
 * The Express app from src/index.ts, imported (so nothing listens and no
 * background timer starts) with its database connected to this file's own
 * test database. Loaded once per test file.
 */
export function loadApp() {
  loaded ??= (async () => {
    const mod = await import('../../src/index');
    const { app, database, config } = mod;
    await database.connect(config.mongoDbName, config.mongoCollectionVideos);
    if (config.uploadTokenSecret) await database.initUploadTokenCollection();
    return { app, database, config, mod };
  })();
  return loaded;
}

export async function api() {
  const { app } = await loadApp();
  return request(app);
}

/** Creates an active API key and returns its value. */
export async function makeApiKey(database: Database, overrides: Record<string, unknown> = {}): Promise<string> {
  const key = `sk_test_${Math.random().toString(36).slice(2)}`;
  await database.createApiKey({ key, app_name: 'test-app', owner: 'tester', active: true, createdAt: new Date(), lastUsed: null, ...overrides } as any);
  return key;
}
