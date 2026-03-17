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
  /** Max upload size in bytes */
  maxFileSize: number;
  /** Allowed CORS origins */
  allowedOrigins: string[];
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
