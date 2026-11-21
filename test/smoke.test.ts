import { describe, it, expect } from 'vitest';
import { api, loadApp, ADMIN } from './helpers/app';

describe('app boots without listening', () => {
  it('answers /health', async () => {
    const res = await (await api()).get('/health');
    expect(res.status).toBe(200);
  });

  it('keeps admin routes behind the admin password', async () => {
    const r = await api();
    expect((await r.get('/admin/api-keys')).status).toBe(401);
    const ok = await r.get('/admin/api-keys').set(ADMIN);
    expect(ok.status).toBe(200);
  });

  it('uses this file\'s own database', async () => {
    const { config } = await loadApp();
    expect(config.mongoDbName).toMatch(/^test_/);
  });
});
