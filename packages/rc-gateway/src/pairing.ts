/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { RcScope } from './scopes.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface PendingCode {
  grantScopes: RcScope[];
  expiresAt: number;
  /** Whether this code's redemption may admit a browser Origin to the CORS allowlist. */
  allowOrigin: boolean;
}

/** In-memory, single-use, short-lived pairing codes. */
export class PairingService {
  private pending = new Map<string, PendingCode>();

  constructor(
    private readonly nowFn: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  mint(
    grantScopes: RcScope[],
    opts: { allowOrigin?: boolean } = {},
  ): { code: string; expiresAt: number } {
    const code = randomBytes(6).toString('base64url');
    const expiresAt = this.nowFn() + this.ttlMs;
    this.pending.set(code, {
      grantScopes: [...grantScopes],
      expiresAt,
      allowOrigin: opts.allowOrigin ?? false,
    });
    return { code, expiresAt };
  }

  /** Validate + consume a code.  Returns its grant scopes + allowOrigin flag, or null. */
  redeem(
    code: string,
  ): { grantScopes: RcScope[]; allowOrigin: boolean } | null {
    const entry = this.pending.get(code);
    if (!entry) return null;
    // Single-use regardless of outcome: remove before validating expiry.
    this.pending.delete(code);
    if (this.nowFn() > entry.expiresAt) return null;
    return { grantScopes: entry.grantScopes, allowOrigin: entry.allowOrigin };
  }
}
