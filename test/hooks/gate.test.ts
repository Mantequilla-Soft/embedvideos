import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_PUBLIC_AT_AHEAD_MS, isGateConfigured, parsePublicAt, registerGatedVideo, verifyGatedManifestEncrypted } from '../../src/utils/gate';

const cfg = (overrides: Record<string, unknown> = {}) =>
  ({ gateUrl: 'https://gate.test//', gateInternalApiKey: 'k', gateCdnBase: 'https://cdn.test/ipfs///', ...overrides }) as any;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const ok = (text: string) => new Response(text, { status: 200 });

describe('isGateConfigured', () => {
  it('needs both the URL and the internal key', () => {
    expect(isGateConfigured(cfg())).toBe(true);
    expect(isGateConfigured(cfg({ gateUrl: '' }))).toBe(false);
    expect(isGateConfigured(cfg({ gateInternalApiKey: '' }))).toBe(false);
  });
});

describe('registerGatedVideo', () => {
  it('refuses to run unconfigured', async () => {
    await expect(registerGatedVideo(cfg({ gateUrl: '' }), { videoId: 'v', creator: 'c', manifestCid: 'Qm' })).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the upstream location with trailing slashes normalised', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    await registerGatedVideo(cfg(), { videoId: 'vid', creator: 'alice', manifestCid: 'QmM', previewPath: 'trailer/x.m3u8', allowlist: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.test/internal/videos');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-API-Key': 'k' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // An empty allowlist is omitted, not sent as [].
    expect(JSON.parse(init.body)).toEqual({
      videoId: 'vid',
      creator: 'alice',
      gated: true,
      upstreamBaseUrl: 'https://cdn.test/ipfs/QmM/',
      manifestPath: 'manifest.m3u8',
      previewUrl: 'https://cdn.test/ipfs/QmM/trailer/x.m3u8',
    });
  });

  it('sends a non-empty allowlist', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await registerGatedVideo(cfg(), { videoId: 'v', creator: 'c', manifestCid: 'Qm', allowlist: ['bob'] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).allowlist).toEqual(['bob']);
  });

  it('sends publicAt as an ISO date when set, and omits it when not', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    await registerGatedVideo(cfg(), { videoId: 'v', creator: 'c', manifestCid: 'Qm', publicAt: new Date('2027-01-02T03:04:05Z') });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).publicAt).toBe('2027-01-02T03:04:05.000Z');
    await registerGatedVideo(cfg(), { videoId: 'v', creator: 'c', manifestCid: 'Qm', publicAt: null });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('publicAt');
  });

  it('throws with the gate\'s answer on failure', async () => {
    fetchMock.mockResolvedValue(new Response('upstream host not allowed', { status: 422 }));
    await expect(registerGatedVideo(cfg(), { videoId: 'v', creator: 'c', manifestCid: 'Qm' })).rejects.toThrow('Gate registration failed: HTTP 422 upstream host not allowed');
  });

  it('throws even when the error body cannot be read', async () => {
    const res = new Response(null, { status: 500 });
    vi.spyOn(res, 'text').mockRejectedValue(new Error('stream broke'));
    fetchMock.mockResolvedValue(res);
    await expect(registerGatedVideo(cfg(), { videoId: 'v', creator: 'c', manifestCid: 'Qm' })).rejects.toThrow(/^Gate registration failed: HTTP 500$/);
  });
});

describe('verifyGatedManifestEncrypted', () => {
  const KEY = '#EXT-X-KEY:METHOD=AES-128,URI="https://gate/key"';

  it('accepts a master playlist whose every rendition is keyed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.test/ipfs/QmM/manifest.m3u8') {
        return ok('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n  720p/index.m3u8  \n#EXT-X-STREAM-INF:BANDWIDTH=2\n#comment\n#EXT-X-STREAM-INF:BANDWIDTH=3\nhttps://other.test/abs.m3u8\n');
      }
      return ok(`#EXTM3U\n${KEY}\nseg.ts`);
    });
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: true });
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    // Relative URIs resolve against the manifest; a STREAM-INF followed by a
    // comment line has no URI.
    expect(urls).toEqual(['https://cdn.test/ipfs/QmM/manifest.m3u8', 'https://cdn.test/ipfs/QmM/720p/index.m3u8', 'https://other.test/abs.m3u8']);
  });

  it('rejects when a rendition has no key tag', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('manifest.m3u8') ? ok('#EXT-X-STREAM-INF:B=1\na.m3u8\n#EXT-X-STREAM-INF:B=2\nb.m3u8') : ok(url.endsWith('a.m3u8') ? KEY : '#EXTINF:4,\nseg.ts')
    );
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: false, reason: 'Rendition b.m3u8 has no #EXT-X-KEY tag' });
  });

  it('rejects when a rendition cannot be fetched', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('manifest.m3u8') ? ok('#EXT-X-STREAM-INF:B=1\na.m3u8') : new Response('', { status: 404 })
    );
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: false, reason: 'Could not fetch rendition playlist https://cdn.test/ipfs/QmM/a.m3u8' });
  });

  it('treats a manifest without variants as the media playlist itself', async () => {
    fetchMock.mockResolvedValueOnce(ok(`#EXTM3U\n  ${KEY}\nseg.ts`));
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: true });
    fetchMock.mockResolvedValueOnce(ok('#EXTM3U\n#EXTINF:4,\nseg.ts'));
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: false, reason: 'manifest.m3u8 has no #EXT-X-KEY tag' });
  });

  it('reports an unreachable manifest (HTTP error or network error)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    expect(await verifyGatedManifestEncrypted(cfg(), 'QmM')).toEqual({ encrypted: false, reason: 'Could not fetch manifest at https://cdn.test/ipfs/QmM/manifest.m3u8' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await verifyGatedManifestEncrypted(cfg(), 'QmM')).encrypted).toBe(false);
  });
});

describe('parsePublicAt', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');

  it('treats absent as members-only for good', () => {
    expect(parsePublicAt(undefined, now)).toEqual({ ok: true, date: null });
    expect(parsePublicAt(null, now)).toEqual({ ok: true, date: null });
  });

  it('accepts an ISO string or epoch milliseconds in the future', () => {
    expect(parsePublicAt('2026-12-01T00:00:00Z', now)).toEqual({ ok: true, date: new Date('2026-12-01T00:00:00Z') });
    expect(parsePublicAt(now + 1000, now)).toEqual({ ok: true, date: new Date(now + 1000) });
  });

  it('rejects other types, unparseable, past and too-far dates', () => {
    expect(parsePublicAt(true, now)).toMatchObject({ ok: false });
    expect(parsePublicAt('soon', now)).toEqual({ ok: false, error: 'public_at is not a valid date' });
    expect(parsePublicAt(now, now)).toEqual({ ok: false, error: 'public_at must be in the future' });
    expect(parsePublicAt(now + MAX_PUBLIC_AT_AHEAD_MS + 1, now)).toEqual({ ok: false, error: 'public_at may be at most a year ahead' });
  });
});
