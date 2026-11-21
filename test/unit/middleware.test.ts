import { describe, it, expect, vi } from 'vitest';
import { createApiKeyMiddleware } from '../../src/middleware/auth';
import { createAdminAuthMiddleware } from '../../src/middleware/adminAuth';

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function fakeDb(keys: Record<string, any>, opts: { lastUsedRejects?: boolean; getThrows?: boolean } = {}) {
  return {
    getApiKey: vi.fn(async (k: string) => {
      if (opts.getThrows) throw new Error('db down');
      return keys[k] ?? null;
    }),
    updateApiKeyLastUsed: vi.fn(async () => {
      if (opts.lastUsedRejects) throw new Error('write failed');
    }),
  };
}

describe('requireApiKey middleware', () => {
  it('401s without a key', async () => {
    const db = fakeDb({});
    const res = mockRes();
    const next = vi.fn();
    await createApiKeyMiddleware(db as any)({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe('API key required');
    expect(next).not.toHaveBeenCalled();
    expect(db.getApiKey).not.toHaveBeenCalled();
  });

  it('401s for an unknown key', async () => {
    const res = mockRes();
    const next = vi.fn();
    await createApiKeyMiddleware(fakeDb({}) as any)({ headers: { 'x-api-key': 'nope' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe('Invalid API key');
    expect(next).not.toHaveBeenCalled();
  });

  it('403s for a revoked key', async () => {
    const res = mockRes();
    const next = vi.fn();
    const db = fakeDb({ k1: { key: 'k1', active: false } });
    await createApiKeyMiddleware(db as any)({ headers: { 'x-api-key': 'k1' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe('API key revoked');
    expect(db.updateApiKeyLastUsed).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts X-API-Key, attaches the key data and touches lastUsed', async () => {
    const data = { key: 'k1', active: true, app_name: 'a' };
    const db = fakeDb({ k1: data });
    const req: any = { headers: { 'x-api-key': 'k1' } };
    const next = vi.fn();
    await createApiKeyMiddleware(db as any)(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKey).toBe(data);
    expect(db.updateApiKeyLastUsed).toHaveBeenCalledWith('k1');
  });

  it('accepts Authorization: Bearer <key>', async () => {
    const db = fakeDb({ k2: { key: 'k2', active: true } });
    const req: any = { headers: { authorization: 'Bearer k2' } };
    const next = vi.fn();
    await createApiKeyMiddleware(db as any)(req, mockRes(), next);
    expect(db.getApiKey).toHaveBeenCalledWith('k2');
    expect(next).toHaveBeenCalledOnce();
  });

  it('a failed lastUsed write does not block the request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb({ k1: { key: 'k1', active: true } }, { lastUsedRejects: true });
    const next = vi.fn();
    await createApiKeyMiddleware(db as any)({ headers: { 'x-api-key': 'k1' } } as any, mockRes(), next);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('500s when the lookup throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    const next = vi.fn();
    await createApiKeyMiddleware(fakeDb({}, { getThrows: true }) as any)({ headers: { 'x-api-key': 'k' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('requireAdminAuth middleware', () => {
  const mw = createAdminAuthMiddleware({ adminPassword: 'pw' } as any);

  it('401s with no password', () => {
    const res = mockRes();
    const next = vi.fn();
    mw({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe('Admin password required');
    expect(next).not.toHaveBeenCalled();
  });

  it('403s with a wrong password', () => {
    const res = mockRes();
    const next = vi.fn();
    mw({ headers: { 'x-admin-password': 'nope' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe('Invalid admin password');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts X-Admin-Password', () => {
    const next = vi.fn();
    mw({ headers: { 'x-admin-password': 'pw' } } as any, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts Authorization: Bearer', () => {
    const next = vi.fn();
    mw({ headers: { authorization: 'Bearer pw' } } as any, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('never logs the password, right or wrong', () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      mw({ headers: { 'x-admin-password': 'pw' }, method: 'GET', originalUrl: '/admin/x' } as any, mockRes(), vi.fn());
      mw({ headers: { 'x-admin-password': 'pw-typo' }, method: 'GET', originalUrl: '/admin/x' } as any, mockRes(), vi.fn());
      mw({ headers: {} } as any, mockRes(), vi.fn());
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
      expect(logged).not.toContain('pw');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('X-Admin-Password takes precedence over Authorization', () => {
    const res = mockRes();
    const next = vi.fn();
    mw({ headers: { 'x-admin-password': 'wrong', authorization: 'Bearer pw' } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
