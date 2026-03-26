import KeyResolver from 'key-did-resolver';
import { DID } from 'dids';

const did = new DID({ resolver: KeyResolver.getResolver() });

export async function unwrapJWS(jws: any): Promise<{ payload: any; did: string }> {
  const data = await did.verifyJWS(jws);
  const encoderDid = data.kid.split('#')[0];
  return { payload: data.payload, did: encoderDid };
}
