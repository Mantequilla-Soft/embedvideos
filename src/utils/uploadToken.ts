import crypto from 'crypto';

export interface UploadTokenClaims {
  /** Token ID for single-use enforcement */
  jti: string;
  /** Hive username */
  owner: string;
  /** Frontend app name (e.g. "ecency") */
  app: string;
  /** API key that issued this token (for audit trail) */
  issuedByKey: string;
  /** Short-form video flag */
  short: boolean;
  /**
   * 🔐 Gated (paid) content flag.
   *
   * Only ever set here, in a signed claim, and only after the issuer has
   * confirmed the owner is a 3Speak Pro user. It is deliberately NOT readable
   * from TUS metadata: that is client-supplied, and the embed API key travels
   * in browser bundles, so metadata cannot be trusted to decide whether content
   * is paid.
   */
  gated?: boolean;
  /**
   * Named accounts that may watch this gated video without 3Speak Pro.
   *
   * Carried in the signed claim for the same reason as `gated`: it is an
   * authorisation input, and the embed API key ships in browser bundles, so an
   * API-key caller cannot be trusted to name its own guests. Never written to
   * the Hive post, so the recipient list is not published on-chain.
   */
  allowlist?: string[];
  /** Max upload size in bytes */
  maxFileSize: number;
  /** Allowed CORS origins */
  allowedOrigins: string[];
  /**
   * Video permlink assigned at token issuance. Binding the permlink to the
   * token lets the client know the embed URL before uploading a single byte,
   * so success no longer depends on reading the X-Embed-URL response header
   * (which is unreliable for parallel/Concatenation uploads). Optional for
   * backward compatibility with tokens minted before this field existed.
   */
  permlink?: string;
  /** Issued at (unix seconds) */
  iat: number;
  /** Expires at (unix seconds) */
  exp: number;
}

/**
 * Sign a token using HMAC-SHA256.
 * Format: base64url(claims).base64url(signature)
 */
export function signUploadToken(claims: UploadTokenClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify and decode an upload token.
 * Returns null if the token is invalid or expired.
 */
export function verifyUploadToken(token: string, secret: string): UploadTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  // Length check before timingSafeEqual to avoid TypeError on mismatched buffer sizes
  if (signature.length !== expectedSignature.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const claims: UploadTokenClaims = JSON.parse(Buffer.from(payload, 'base64url').toString());

    // Check expiry
    if (claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}

/**
 * Generate a unique token ID.
 */
export function generateTokenId(): string {
  return crypto.randomBytes(16).toString('hex');
}
