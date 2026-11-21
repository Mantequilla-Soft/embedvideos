import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { signUploadToken, verifyUploadToken, generateTokenId, UploadTokenClaims } from '../../src/utils/uploadToken';

const SECRET = 'unit-secret';

function claims(over: Partial<UploadTokenClaims> = {}): UploadTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: 'abc', owner: 'alice', app: 'test', issuedByKey: 'test', short: false,
    maxFileSize: 1000, allowedOrigins: [], iat: now, exp: now + 60, ...over,
  };
}

describe('upload tokens', () => {
  it('round-trips signed claims', () => {
    const c = claims({ permlink: 'p1', gated: true, allowlist: ['bob'] });
    const token = signUploadToken(c, SECRET);
    expect(token.split('.')).toHaveLength(2);
    expect(verifyUploadToken(token, SECRET)).toEqual(c);
  });

  it('rejects a token signed with another secret', () => {
    const token = signUploadToken(claims(), SECRET);
    expect(verifyUploadToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signUploadToken(claims(), SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ owner: 'mallory' }))).toString('base64url');
    expect(verifyUploadToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUploadToken('nodot', SECRET)).toBeNull();
    expect(verifyUploadToken('a.b.c', SECRET)).toBeNull();
    // Signature of a different length never reaches timingSafeEqual.
    expect(verifyUploadToken('payload.short', SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signUploadToken(claims({ iat: now - 120, exp: now - 60 }), SECRET);
    expect(verifyUploadToken(token, SECRET)).toBeNull();
  });

  it('rejects a correctly signed payload that is not JSON', () => {
    const payload = Buffer.from('not json{').toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifyUploadToken(`${payload}.${sig}`, SECRET)).toBeNull();
  });

  it('generates unique 32-hex token ids', () => {
    const a = generateTokenId();
    const b = generateTokenId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
