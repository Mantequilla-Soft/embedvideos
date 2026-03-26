import KeyResolver from 'key-did-resolver';
import { DID } from 'dids';

const did = new DID({ resolver: KeyResolver.getResolver() });

export class JWSAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JWSAuthError';
  }
}

export async function unwrapJWS(jws: any): Promise<{ payload: any; did: string }> {
  try {
    const data = await did.verifyJWS(jws);
    if (!data.kid || typeof data.kid !== 'string') {
      throw new JWSAuthError('Missing kid in JWS');
    }
    const encoderDid = data.kid.split('#')[0];
    return { payload: data.payload, did: encoderDid };
  } catch (error) {
    throw new JWSAuthError(error instanceof Error ? error.message : 'JWS verification failed');
  }
}
