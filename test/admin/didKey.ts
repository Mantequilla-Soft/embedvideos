import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';

/**
 * A throwaway did:key (Ed25519) identity that signs real compact JWS, the same
 * thing a community encoder sends to the gateway. Verified by the service with
 * the real `dids` + `key-did-resolver` stack, so nothing about the signature
 * check is mocked.
 */
export interface TestDid {
  did: string;
  kid: string;
  sign(payload: unknown, header?: Record<string, unknown>): string;
}

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64url');

export function makeDid(): TestDid {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  // multicodec ed25519-pub = 0xed 0x01, then multibase base58btc ('z' prefix).
  const did = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...pub]))}`;
  const kid = `${did}#${did.slice('did:key:'.length)}`;
  return {
    did,
    kid,
    sign(payload, header = {}) {
      const h = b64url(JSON.stringify({ alg: 'EdDSA', kid, ...header }));
      const p = b64url(JSON.stringify(payload));
      const sig = ed25519.sign(new TextEncoder().encode(`${h}.${p}`), secret);
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** Turns a compact JWS into the DagJWS object form ({ payload, signatures }). */
export function toDagJws(compact: string) {
  const [protectedHeader, payload, signature] = compact.split('.');
  return { payload, signatures: [{ protected: protectedHeader, signature }] };
}
