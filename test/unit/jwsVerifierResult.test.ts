import { describe, it, expect, vi } from 'vitest';

// The real dids stack already refuses a JWS without a kid before unwrapJWS
// sees it (see jws.test.ts). These cover unwrapJWS's own guards for a verifier
// result that lacks a usable kid, and for a non-Error rejection.
const verifyJWS = vi.fn();
vi.mock('dids', () => ({
  DID: class {
    verifyJWS = verifyJWS;
  },
}));

const { unwrapJWS, JWSAuthError } = await import('../../src/utils/jws');

describe('unwrapJWS guards on the verifier result', () => {
  it('rejects a verified result without a kid', async () => {
    verifyJWS.mockResolvedValueOnce({ payload: { a: 1 } });
    await expect(unwrapJWS('x')).rejects.toThrow(new JWSAuthError('Missing kid in JWS'));
  });

  it('rejects a non-string kid', async () => {
    verifyJWS.mockResolvedValueOnce({ payload: {}, kid: 42 });
    await expect(unwrapJWS('x')).rejects.toThrow('Missing kid in JWS');
  });

  it('strips the key fragment from the kid', async () => {
    verifyJWS.mockResolvedValueOnce({ payload: { p: true }, kid: 'did:key:zAbc#zAbc' });
    expect(await unwrapJWS('x')).toEqual({ payload: { p: true }, did: 'did:key:zAbc' });
  });

  it('maps a non-Error rejection to a generic JWSAuthError', async () => {
    verifyJWS.mockRejectedValueOnce('nope');
    const err = await unwrapJWS('x').catch((e) => e);
    expect(err).toBeInstanceOf(JWSAuthError);
    expect(err.message).toBe('JWS verification failed');
  });
});
