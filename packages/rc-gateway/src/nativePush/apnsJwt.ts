/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * APNs provider-authentication JWT (add-native-mobile-shells "APNs delivery
 * pipeline"): an ES256 token signed with the operator's P-8 key, header
 * `{alg:ES256, kid:<keyId>}`, claims `{iss:<teamId>, iat:<now>}`. Apple accepts a
 * token for up to ~1h, so {@link ApnsJwtSigner} caches and refreshes it.
 *
 * Unlike the live HTTP/2 send, this is fully VERIFIABLE: we sign with Node crypto
 * and the test verifies the signature against the public key. The signature is
 * raw R||S (IEEE-P1363), which is what JWT ES256 requires.
 */

import { createSign, type KeyObject, createPrivateKey } from 'node:crypto';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface ApnsJwtInput {
  keyPem: string;
  keyId: string;
  teamId: string;
  now: () => number;
}

/**
 * Sign a one-shot APNs JWT. Throws if `keyPem` is not a valid EC private key —
 * callers (e.g. the capability's `apnsEnabled`) can use that to reflect
 * parse-validity, not just file presence.
 */
export function createApnsJwt(input: ApnsJwtInput): string {
  const key: KeyObject = createPrivateKey(input.keyPem); // throws on malformed PEM
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }));
  const iat = Math.floor(input.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: input.teamId, iat }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

export interface ApnsJwtSignerOptions extends ApnsJwtInput {
  /** Refresh interval in ms (Apple max ~1h; default 50 min). */
  ttlMs?: number;
}

/** Caches the APNs JWT and refreshes it once `ttlMs` has elapsed. */
export class ApnsJwtSigner {
  private cached: { token: string; at: number } | undefined;
  private readonly ttlMs: number;

  constructor(private readonly opts: ApnsJwtSignerOptions) {
    this.ttlMs = opts.ttlMs ?? 50 * 60_000;
  }

  token(): string {
    const now = this.opts.now();
    if (!this.cached || now - this.cached.at >= this.ttlMs) {
      this.cached = { token: createApnsJwt(this.opts), at: now };
    }
    return this.cached.token;
  }
}
