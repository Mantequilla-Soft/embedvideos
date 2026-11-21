import { describe, it, expect, afterEach } from 'vitest';
import { generateApiKey, generateAdminToken } from '../../src/utils/keyGenerator';
import { generateVideoId } from '../../src/utils/videoId';
import { clientIpFrom, ipHashes } from '../../src/utils/ipHash';

describe('keyGenerator', () => {
  it('builds sk_<sanitised app>_<48 hex>', () => {
    const key = generateApiKey('My App-2!');
    expect(key).toMatch(/^sk_myapp2_[0-9a-f]{48}$/);
  });

  it('never repeats', () => {
    expect(generateApiKey('x')).not.toBe(generateApiKey('x'));
  });

  it('makes 64-hex admin tokens', () => {
    const t = generateAdminToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(generateAdminToken()).not.toBe(t);
  });
});

describe('generateVideoId', () => {
  it('returns 8 lowercase alphanumerics, unique across many draws', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateVideoId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('clientIpFrom', () => {
  it('returns null without headers', () => {
    expect(clientIpFrom(undefined)).toBeNull();
    expect(clientIpFrom(null)).toBeNull();
    expect(clientIpFrom({})).toBeNull();
  });

  it('prefers X-Real-IP, case-insensitively', () => {
    expect(clientIpFrom({ 'X-Real-IP': ' 1.2.3.4 ', 'x-forwarded-for': '5.6.7.8' })).toBe('1.2.3.4');
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    expect(clientIpFrom({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' })).toBe('5.6.7.8');
  });

  it('reads array-valued headers (tusd HTTPRequest.Header shape)', () => {
    expect(clientIpFrom({ 'X-Real-Ip': ['9.9.9.9', '1.1.1.1'] })).toBe('9.9.9.9');
  });

  it('returns null for a blank value', () => {
    expect(clientIpFrom({ 'x-real-ip': '   ' })).toBeNull();
  });
});

describe('ipHashes', () => {
  const saved = process.env.IP_HASH_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.IP_HASH_SECRET;
    else process.env.IP_HASH_SECRET = saved;
  });

  it('records nothing without a secret or an address', () => {
    delete process.env.IP_HASH_SECRET;
    expect(ipHashes('1.2.3.4')).toEqual({ uploader_ip_hash: null, uploader_net_hash: null });
    process.env.IP_HASH_SECRET = 's';
    expect(ipHashes(null)).toEqual({ uploader_ip_hash: null, uploader_net_hash: null });
  });

  it('same /24 shares the net hash but not the ip hash', () => {
    process.env.IP_HASH_SECRET = 'secret-1';
    const a = ipHashes('203.0.113.5');
    const b = ipHashes('203.0.113.77');
    const c = ipHashes('203.0.114.5');
    expect(a.uploader_ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(a.uploader_net_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(a.uploader_net_hash).toBe(b.uploader_net_hash);
    expect(a.uploader_ip_hash).not.toBe(b.uploader_ip_hash);
    expect(a.uploader_net_hash).not.toBe(c.uploader_net_hash);
    // Hashes never contain the address itself.
    expect(JSON.stringify(a)).not.toContain('203.0.113');
  });

  it('treats IPv4-mapped IPv6 as the plain IPv4 address', () => {
    process.env.IP_HASH_SECRET = 'secret-1';
    expect(ipHashes('::ffff:203.0.113.5')).toEqual(ipHashes('203.0.113.5'));
  });

  it('groups IPv6 by /48', () => {
    process.env.IP_HASH_SECRET = 'secret-1';
    const a = ipHashes('2001:db8:abcd:1::1');
    const b = ipHashes('2001:DB8:abcd:ffff::2');
    const c = ipHashes('2001:db8:abce::1');
    expect(a.uploader_net_hash).toBe(b.uploader_net_hash);
    expect(a.uploader_ip_hash).not.toBe(b.uploader_ip_hash);
    expect(a.uploader_net_hash).not.toBe(c.uploader_net_hash);
  });

  it('rotating the secret makes earlier hashes unlinkable', () => {
    process.env.IP_HASH_SECRET = 'secret-1';
    const before = ipHashes('198.51.100.1');
    process.env.IP_HASH_SECRET = 'secret-2';
    const after = ipHashes('198.51.100.1');
    expect(after.uploader_ip_hash).not.toBe(before.uploader_ip_hash);
    expect(after.uploader_net_hash).not.toBe(before.uploader_net_hash);
  });
});
