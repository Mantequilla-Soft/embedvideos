/**
 * Tests for deferred encoding and its finalize token.
 *
 * The property under test is the same safety property as gated dispatch, one
 * step earlier: gating has to be decided before the encoder runs, because the
 * encoder is what encrypts and an unencrypted rendition is public the moment
 * its CID is pinned. Deferring exists so the choice can be made after the
 * upload has started without the job having already been queued.
 *
 * The credential added for that — the finalize token — must not widen anything:
 * it may commission one specific video's encode and nothing else. In
 * particular it must not work as upload credentials, and neither `deferEncode`
 * nor `gated` may be settable from client metadata.
 *
 * Runs with no MongoDB and no network, against a stub database.
 *
 * Usage: npx ts-node scripts/test-deferred-encode.ts
 */

import { signUploadToken, verifyUploadToken, UploadTokenClaims } from '../src/utils/uploadToken';
import { validateUploadAuth } from '../src/utils/uploadAuth';
import { Database } from '../src/database/mongodb';
import { Config } from '../src/config/config';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const SECRET = 'test-secret-not-a-real-key';

const config = { uploadTokenSecret: SECRET } as unknown as Config;

/** Stub: every token is unused, every user exists and is neither banned nor Pro. */
function stubDb(over: Partial<Record<string, unknown>> = {}): Database {
  return {
    consumeUploadToken: async () => true,
    getUser: async () => ({ username: 'alice', banned: false }),
    createUser: async () => undefined,
    getApiKey: async () => ({ active: true, app_name: 'test' }),
    updateApiKeyLastUsed: async () => undefined,
    isUserPremium: async () => false,
    ...over,
  } as unknown as Database;
}

function claims(over: Partial<UploadTokenClaims> = {}): UploadTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    owner: 'alice',
    app: 'test',
    issuedByKey: 'test',
    short: false,
    gated: false,
    maxFileSize: 1_000_000,
    allowedOrigins: [],
    permlink: 'vid12345',
    iat: now,
    exp: now + 600,
    ...over,
  };
}

function bearer(c: UploadTokenClaims): Record<string, string[]> {
  return { Authorization: [`Bearer ${signUploadToken(c, SECRET)}`] };
}

async function main(): Promise<void> {
  section('Finalize token round-trips its scope');
  {
    const signed = signUploadToken(claims({ scope: 'finalize' }), SECRET);
    const decoded = verifyUploadToken(signed, SECRET);
    ok('scope survives sign/verify', decoded?.scope === 'finalize', `got ${decoded?.scope}`);
    ok('a token with no scope decodes as undefined', verifyUploadToken(signUploadToken(claims(), SECRET), SECRET)?.scope === undefined);
  }

  section('A finalize token is not upload credentials');
  {
    const res = await validateUploadAuth(bearer(claims({ scope: 'finalize' })), {}, 100, stubDb(), config);
    ok('rejected', res.ok === false);
    ok('with 403', res.ok === false && res.status === 403, res.ok === false ? `got ${res.status}` : '');
  }
  {
    // The rejection must land before the token is consumed, or a misdirected
    // finalize token would burn the jti and break a legitimate retry.
    let consumed = false;
    const db = stubDb({ consumeUploadToken: async () => { consumed = true; return true; } });
    await validateUploadAuth(bearer(claims({ scope: 'finalize' })), {}, 100, db, config);
    ok('and without consuming the token', consumed === false);
  }

  section('An ordinary upload token still works');
  {
    const res = await validateUploadAuth(bearer(claims()), {}, 100, stubDb(), config);
    ok('accepted', res.ok === true, res.ok === false ? res.error : '');
    ok('scope-less token is treated as an upload token', res.ok === true);
  }

  section('deferEncode comes from the signed claim only');
  {
    const res = await validateUploadAuth(bearer(claims({ deferEncode: true })), {}, 100, stubDb(), config);
    ok('honoured from the claim', res.ok === true && res.deferEncode === true);
  }
  {
    const res = await validateUploadAuth(bearer(claims()), {}, 100, stubDb(), config);
    ok('defaults to false', res.ok === true && res.deferEncode === false);
  }
  {
    // An API-key caller with hostile metadata. The API key ships in browser
    // bundles, so metadata is not a trusted input.
    const res = await validateUploadAuth(
      { 'X-Api-Key': ['some-key'] },
      { defer_encode: 'true', deferEncode: 'true', gated: 'true', owner: 'alice' },
      100,
      stubDb(),
      config,
    );
    ok('not settable from TUS metadata', res.ok === true && res.deferEncode === false);
    ok('gated likewise not settable from metadata', res.ok === true && res.gated === false);
  }

  section('Tampering is rejected');
  {
    const signed = signUploadToken(claims({ scope: 'finalize' }), SECRET);
    const [payload] = signed.split('.');
    const forged = `${payload}.${'a'.repeat(43)}`;
    ok('a forged signature does not verify', verifyUploadToken(forged, SECRET) === null);

    // Flipping scope in the payload changes the signature, so the token dies.
    const tweaked = Buffer.from(
      JSON.stringify({ ...claims(), scope: 'upload' })
    ).toString('base64url');
    const swapped = `${tweaked}.${signed.split('.')[1]}`;
    ok('scope cannot be swapped without resigning', verifyUploadToken(swapped, SECRET) === null);
  }

  section('An expired finalize token is refused');
  {
    const now = Math.floor(Date.now() / 1000);
    const expired = signUploadToken(claims({ scope: 'finalize', iat: now - 100, exp: now - 1 }), SECRET);
    ok('rejected', verifyUploadToken(expired, SECRET) === null);
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
