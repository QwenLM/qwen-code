/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ListenerIdentity } from './listener-identity.js';

export interface DesktopRelayCredentialClaim {
  acpPath: string;
  sessionId: string;
}

/**
 * What the auth middleware needs from a credential source. Kept separate from
 * {@link CredentialStore} so `auth.ts` can depend on the shape by type alone
 * and keep its single-token fallback without importing the class at runtime.
 */
export interface ListenerScopedCredentials {
  isOpen(listener: ListenerIdentity): boolean;
  verify(credentials: string, listener: ListenerIdentity): boolean;
  consumeDesktopRelayCredential?(
    credential: string,
    acpPath: string,
  ): DesktopRelayCredentialClaim | undefined;
}

/**
 * The daemon's accepted bearer credentials, scoped per listener.
 *
 * Before Local Control moved in-daemon, `bearerAuth` pre-hashed exactly one
 * token. That is why the CLI path handed the LAN the daemon token itself:
 * with a single credential there was nothing else to hand out, so a paired
 * phone held full-strength access revocable only by restart.
 *
 * The store replaces that single hash with a small set plus a scoping rule:
 *
 * | credential    | primary listener | local-control listener |
 * | ------------- | ---------------- | ---------------------- |
 * | runtime token | accepted         | **rejected**           |
 * | pairing token | **rejected**     | accepted               |
 * | Web Shell device token | accepted | **rejected**           |
 *
 * Both rejections matter. Rejecting the runtime token on the LAN is the
 * invariant the Rust proxy enforced explicitly. Rejecting the pairing token on
 * loopback keeps a leaked pairing credential from being replayed against the
 * operator's own surface, and means revocation has exactly one place to happen.
 */
export class CredentialStore implements ListenerScopedCredentials {
  #runtime: Buffer | undefined;
  /** Pairing id → sha256 of the pairing secret. */
  readonly #pairing = new Map<string, Buffer>();
  readonly #webShell = new Set<Buffer>();
  readonly #desktopRelay = new Map<
    string,
    DesktopRelayCredentialClaim & { expiresAt: number }
  >();

  constructor(runtimeToken?: string) {
    this.#runtime = hashToken(runtimeToken);
  }

  addPairingToken(id: string, token: string): void {
    this.#pairing.set(id, createHash('sha256').update(token, 'utf8').digest());
  }

  revokePairingToken(id: string): boolean {
    return this.#pairing.delete(id);
  }

  addWebShellToken(token: string): boolean {
    if (this.#webShell.size >= 128) return false;
    this.#webShell.add(createHash('sha256').update(token, 'utf8').digest());
    return true;
  }

  createDesktopRelayCredential(
    claim: DesktopRelayCredentialClaim,
  ): string | undefined {
    const now = Date.now();
    for (const [digest, entry] of this.#desktopRelay) {
      if (entry.expiresAt <= now) this.#desktopRelay.delete(digest);
    }
    if (this.#desktopRelay.size >= 128) return undefined;

    const credential = randomBytes(32).toString('base64url');
    this.#desktopRelay.set(digestToken(credential), {
      ...claim,
      expiresAt: now + 120_000,
    });
    return credential;
  }

  consumeDesktopRelayCredential(
    credential: string,
    acpPath: string,
  ): DesktopRelayCredentialClaim | undefined {
    const digest = digestToken(credential);
    const claim = this.#desktopRelay.get(digest);
    if (!claim) return undefined;
    this.#desktopRelay.delete(digest);
    if (claim.expiresAt <= Date.now() || claim.acpPath !== acpPath) {
      return undefined;
    }
    return { acpPath: claim.acpPath, sessionId: claim.sessionId };
  }

  /**
   * Is the gate open — i.e. may an unauthenticated request through?
   *
   * Only ever true on the primary listener of a no-token loopback daemon,
   * preserving today's developer default. The LAN listener is never open: it
   * exists only while a pairing token does, and it must not inherit the
   * "operator chose the surface area" reasoning that governs `--hostname`.
   */
  isOpen(listener: ListenerIdentity): boolean {
    if (listener.kind === 'local-control') return false;
    return this.#runtime === undefined;
  }

  /**
   * Constant-time check of a presented credential against those valid for
   * `listener`. Every candidate in scope is compared even after a match so the
   * work is independent of which credential matched — with a handful of
   * pairing tokens the cost is negligible and the timing signal is not worth
   * reasoning about separately.
   */
  verify(credentials: string, listener: ListenerIdentity): boolean {
    const candidate = createHash('sha256').update(credentials, 'utf8').digest();
    let matched = false;
    if (listener.kind === 'local-control') {
      for (const expected of this.#pairing.values()) {
        if (equalDigest(candidate, expected)) matched = true;
      }
      return matched;
    }
    if (this.#runtime !== undefined && equalDigest(candidate, this.#runtime)) {
      matched = true;
    }
    for (const expected of this.#webShell) {
      if (equalDigest(candidate, expected)) matched = true;
    }
    return matched;
  }
}

/**
 * Back-compat source for callers that still pass a bare token: one credential,
 * accepted on the primary listener, gate open when the token is absent.
 *
 * A bare token never authenticates on the LAN listener — a caller holding only
 * a single token has no pairing credential to offer, so a Local Control
 * session cannot be reached through this shape at all. That is the intended
 * failure direction: it degrades to "unreachable", not to "the runtime token
 * works over the LAN", which is exactly the behavior being retired.
 */
export function singleTokenCredentials(
  token: string | undefined,
): ListenerScopedCredentials {
  const expected = hashToken(token);
  return {
    isOpen: (listener) =>
      expected === undefined && listener.kind !== 'local-control',
    verify: (candidate, listener) => {
      if (expected === undefined || listener.kind === 'local-control') {
        return false;
      }
      return equalDigest(
        createHash('sha256').update(candidate, 'utf8').digest(),
        expected,
      );
    },
  };
}

function hashToken(token: string | undefined): Buffer | undefined {
  return token === undefined || token === ''
    ? undefined
    : createHash('sha256').update(token, 'utf8').digest();
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Digests are always 32 bytes here, but `timingSafeEqual` throws on a length
 * mismatch rather than returning false — guard so a future non-sha256 entry
 * can't turn an auth check into a 500.
 */
function equalDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
