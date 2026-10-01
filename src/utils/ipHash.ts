import crypto from 'crypto';

/**
 * Keyed hashes of the uploader's address, for telling apart "several people" and
 * "one person behind several accounts" without ever storing an address.
 *
 * Why: on 2026-10-01 a cluster of ~22 accounts from two tiny ISPs in one Dhaka
 * suburb could only be linked to a /24 (nginx masks the last octet on purpose) and
 * nothing recorded the real address anywhere, so "same connection" was unprovable.
 *
 *   uploader_ip_hash   HMAC of the full address: same value = same connection.
 *   uploader_net_hash  HMAC of its network (/24 for IPv4, /48 for IPv6): same
 *                      value = same neighbourhood ISP block.
 *
 * The raw address is never written. The key is IP_HASH_SECRET (service .env);
 * without it both fields are null and nothing is recorded. Rotating the key makes
 * every earlier hash unlinkable, which is the way to "forget" them.
 * ⚠️ IPv4 is small enough to brute-force, so the key is what protects these: keep
 * it out of logs, git and every other service.
 *
 * embed2 is NOT behind Cloudflare: nginx sets X-Real-IP from $remote_addr, which
 * is the real client. If that ever changes, read CF-Connecting-IP here instead.
 */

type HeaderBag = Record<string, string | string[] | undefined>;

/** The client address from request headers (Express or tusd's HTTPRequest.Header). */
export function clientIpFrom(headers: HeaderBag | undefined | null): string | null {
  if (!headers) return null;
  const get = (name: string): string | undefined => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    const v = key ? headers[key] : undefined;
    return Array.isArray(v) ? v[0] : v;
  };
  const real = get('x-real-ip');
  const fwd = get('x-forwarded-for');
  const ip = (real || (fwd ? fwd.split(',')[0] : '') || '').trim();
  return ip || null;
}

function networkOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  // IPv6: the first three groups (a /48), expanded enough to be stable.
  const groups = ip.toLowerCase().split('::')[0].split(':').filter(Boolean);
  return `${groups.slice(0, 3).join(':')}::/48`;
}

export function ipHashes(ip: string | null): { uploader_ip_hash: string | null; uploader_net_hash: string | null } {
  const secret = process.env.IP_HASH_SECRET || '';
  if (!secret || !ip) return { uploader_ip_hash: null, uploader_net_hash: null };
  const addr = ip.replace(/^::ffff:/i, '');
  const h = (v: string) => crypto.createHmac('sha256', secret).update(v).digest('hex').slice(0, 32);
  return { uploader_ip_hash: h(`ip:${addr}`), uploader_net_hash: h(`net:${networkOf(addr)}`) };
}
