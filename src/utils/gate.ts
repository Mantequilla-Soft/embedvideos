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
