/**
 * 🔐 Client for 3speak-gate, the entitlement and content-key service.
 *
 * embedvideos talks to the gate for exactly one thing: telling it where a
 * finished gated video lives, so the gate can fetch and rewrite its manifest.
 * Content keys never pass through here. Only trusted encoders fetch those, and
 * they fetch them directly.
 */

import { Config } from '../config/config';

const REQUEST_TIMEOUT_MS = 10_000;

export function isGateConfigured(config: Config): boolean {
  return Boolean(config.gateUrl && config.gateInternalApiKey);
}

/**
 * Registers a finished gated video with the gate.
 *
 * Called after encoding completes. Until this succeeds the gate returns 404 for
 * the video and nobody can play it, including the creator, so a failure here is
 * logged loudly rather than swallowed.
 */
export async function registerGatedVideo(
  config: Config,
  params: {
    videoId: string;
    creator: string;
    manifestCid: string;
    previewPath?: string;
    /** Named accounts that may watch without Pro. Omitted when empty. */
    allowlist?: string[];
  }
): Promise<void> {
  if (!isGateConfigured(config)) {
    throw new Error('Gate is not configured (GATE_URL / GATE_INTERNAL_API_KEY)');
  }

  const cdnBase = config.gateCdnBase.replace(/\/+$/, '');
  const upstreamBaseUrl = `${cdnBase}/${params.manifestCid}/`;

  const body = {
    videoId: params.videoId,
    creator: params.creator,
    gated: true,
    upstreamBaseUrl,
    manifestPath: 'manifest.m3u8',
    // The encoder writes an unencrypted trailer beside the encrypted renditions.
    previewUrl: `${upstreamBaseUrl}${params.previewPath ?? 'preview/index.m3u8'}`,
    ...(params.allowlist?.length ? { allowlist: params.allowlist } : {}),
  };

  const response = await fetch(`${config.gateUrl.replace(/\/+$/, '')}/internal/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.gateInternalApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gate registration failed: HTTP ${response.status} ${text}`.trim());
  }
}

/**
 * Defense-in-depth: confirms a finished gated video's output is actually
 * encrypted before it is registered with the gate.
 *
 * The encoder is supposed to guarantee this itself (see internal-docs/
 * gated-passthrough-bypass.md for a case where a passthrough/remux fast path
 * silently skipped encryption while still reporting job success). Rather than
 * trust that guarantee, fetch the manifest we are about to hand to the gate
 * and check for an #EXT-X-KEY tag on every rendition it references. A gated
 * video with no key tag is plaintext on public IPFS, so treat that as an
 * encode failure rather than something worth publishing.
 */
export async function verifyGatedManifestEncrypted(
  config: Config,
  manifestCid: string
): Promise<{ encrypted: boolean; reason?: string }> {
  const cdnBase = config.gateCdnBase.replace(/\/+$/, '');
  const manifestUrl = `${cdnBase}/${manifestCid}/manifest.m3u8`;

  const master = await fetchPlaylist(manifestUrl);
  if (master === null) {
    return { encrypted: false, reason: `Could not fetch manifest at ${manifestUrl}` };
  }

  const variantUris = extractVariantUris(master);

  // Not a master playlist (no #EXT-X-STREAM-INF) — it IS the media playlist.
  if (variantUris.length === 0) {
    return hasKeyTag(master)
      ? { encrypted: true }
      : { encrypted: false, reason: 'manifest.m3u8 has no #EXT-X-KEY tag' };
  }

  for (const uri of variantUris) {
    const variantUrl = new URL(uri, manifestUrl).toString();
    const variant = await fetchPlaylist(variantUrl);
    if (variant === null) {
      return { encrypted: false, reason: `Could not fetch rendition playlist ${variantUrl}` };
    }
    if (!hasKeyTag(variant)) {
      return { encrypted: false, reason: `Rendition ${uri} has no #EXT-X-KEY tag` };
    }
  }

  return { encrypted: true };
}

async function fetchPlaylist(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function extractVariantUris(masterPlaylist: string): string[] {
  const lines = masterPlaylist.split('\n').map(l => l.trim());
  const uris: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) uris.push(next);
    }
  }
  return uris;
}

function hasKeyTag(playlist: string): boolean {
  return playlist.split('\n').some(l => l.trim().startsWith('#EXT-X-KEY'));
}
