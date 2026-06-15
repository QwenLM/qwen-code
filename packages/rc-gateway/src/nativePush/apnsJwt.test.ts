/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createApnsJwt, ApnsJwtSigner } from './apnsJwt.js';

// A real EC P-256 private key in PKCS#8 PEM — the P-8 format Apple issues.
function p8KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey,
  };
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

describe('createApnsJwt', () => {
  it('produces a header.payload.signature with the documented claims', () => {
    const { pem } = p8KeyPair();
    const jwt = createApnsJwt({
      keyPem: pem,
      keyId: 'KEY123',
      teamId: 'TEAM456',
      now: () => 1_700_000_000_000,
    });
    const [h, p, s] = jwt.split('.');
    expect(decodeSegment(h)).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(decodeSegment(p)).toEqual({ iss: 'TEAM456', iat: 1_700_000_000 });
    expect(s.length).toBeGreaterThan(0);
  });

  it('signs with ES256 verifiably against the public key', () => {
    const { pem, publicKey } = p8KeyPair();
    const jwt = createApnsJwt({
      keyPem: pem,
      keyId: 'k',
      teamId: 't',
      now: () => 0,
    });
    const [h, p, sig] = jwt.split('.');
    // ES256 JWT signature is raw R||S (64 bytes); verify with the IEEE-P1363 format.
    const ok = createVerify('SHA256')
      .update(`${h}.${p}`)
      .verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig, 'base64url'),
      );
    expect(ok).toBe(true);
  });

  it('throws on a malformed key (so apnsEnabled can reflect parse-validity)', () => {
    expect(() =>
      createApnsJwt({
        keyPem: 'not a pem',
        keyId: 'k',
        teamId: 't',
        now: () => 0,
      }),
    ).toThrow();
  });
});

describe('ApnsJwtSigner', () => {
  it('caches the token and refreshes after the TTL', () => {
    const { pem } = p8KeyPair();
    let t = 1_000_000;
    const signer = new ApnsJwtSigner({
      keyPem: pem,
      keyId: 'k',
      teamId: 't',
      now: () => t,
      ttlMs: 50 * 60_000, // 50 min
    });
    const a = signer.token();
    t += 10 * 60_000; // within TTL
    const b = signer.token();
    expect(b).toBe(a); // cached
    t += 50 * 60_000; // past TTL
    const c = signer.token();
    expect(c).not.toBe(a); // refreshed (new iat)
  });
});
