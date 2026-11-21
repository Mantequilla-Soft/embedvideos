import { describe, it, expect } from 'vitest';
import { unwrapJWS, JWSAuthError } from '../../src/utils/jws';
import { makeDid, toDagJws } from '../admin/didKey';

describe('unwrapJWS', () => {
  it('verifies a compact JWS signed by a did:key and returns payload + bare DID', async () => {
    const id = makeDid();
    const out = await unwrapJWS(id.sign({ hello: 'world', n: 1 }));
    expect(out.did).toBe(id.did);
    expect(out.payload).toEqual({ hello: 'world', n: 1 });
  });

  it('accepts the DagJWS object form', async () => {
    const id = makeDid();
    const out = await unwrapJWS(toDagJws(id.sign({ a: 1 })));
    expect(out).toEqual({ did: id.did, payload: { a: 1 } });
  });

  it('rejects a payload that was altered after signing', async () => {
    const id = makeDid();
    const [h, , s] = id.sign({ role: 'user' }).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url')}.${s}`;
    await expect(unwrapJWS(forged)).rejects.toBeInstanceOf(JWSAuthError);
  });

  it('rejects a JWS whose kid names a different key than the signer', async () => {
    const signer = makeDid();
    const victim = makeDid();
    const jws = signer.sign({ x: 1 }, { kid: victim.kid });
    await expect(unwrapJWS(jws)).rejects.toThrow(JWSAuthError);
  });

  it('rejects a JWS with no kid', async () => {
    const id = makeDid();
    const jws = id.sign({ x: 1 }, { kid: undefined });
    const err = await unwrapJWS(jws).catch((e) => e);
    expect(err).toBeInstanceOf(JWSAuthError);
    expect(err.name).toBe('JWSAuthError');
  });

  it('wraps garbage input and non-Error throws as JWSAuthError', async () => {
    await expect(unwrapJWS('not-a-jws')).rejects.toBeInstanceOf(JWSAuthError);
    await expect(unwrapJWS(undefined)).rejects.toBeInstanceOf(JWSAuthError);
  });
});
