/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';

/**
 * One-time, short-lived bridge invite tokens (`add-bridge-protocol` /
 * add-{telegram,discord,matrix}-bridge "operator-issued invite binds <surface>").
 *
 * An operator mints an invite for a `{kind, sessionId}` pair (the gateway analog
 * of the spec's `qwen rc bridges invite --kind <kind> --session <id>` CLI — the
 * daemon→gateway move is the standing fork architecture deviation). The bridge
 * redeems it via `POST /rc/bridges/:id/invite/redeem`, learning the sessionId to
 * bind WITHOUT a chat user ever naming a session id directly. That is the whole
 * point: the OPERATOR decides which chat→session bindings exist.
 *
 * Mirrors {@link PairingService}: in-memory + single-use + TTL. A gateway restart
 * drops unredeemed invites (the operator re-mints) — the same ephemerality as the
 * pairing codes and the bridge registry. Tokens are 16 random bytes (vs pairing's
 * 6): an invite is chat-relayed (copy-paste/forward), not human-typed, so there's
 * no length pressure and the extra entropy removes any brute-force question.
 */

/** Default invite lifetime: longer than a pairing code because the human relay
 * (operator messages a user → they open a client → run the attach command) is
 * slower than scanning a code on the same screen. */
const DEFAULT_TTL_MS = 20 * 60 * 1000;

interface PendingInvite {
  /** Advisory bridge kind (telegram|discord|matrix). Recorded, NOT gated on at
   * redeem — see {@link InviteStore.redeem}. */
  kind: string;
  sessionId: string;
  expiresAt: number;
}

/** The data a successful redeem yields. */
export interface RedeemedInvite {
  kind: string;
  sessionId: string;
}

export class InviteStore {
  private pending = new Map<string, PendingInvite>();

  constructor(
    private readonly nowFn: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Mint a one-time invite for a `{kind, sessionId}`. Returns the token + expiry. */
  mint(kind: string, sessionId: string): { token: string; expiresAt: number } {
    const token = `inv_${randomBytes(16).toString('base64url')}`;
    const expiresAt = this.nowFn() + this.ttlMs;
    this.pending.set(token, { kind, sessionId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Validate + consume an invite token. Returns its `{kind, sessionId}` or null
   * (unknown OR expired). Single-use regardless of outcome: the token is removed
   * before the expiry check, so a redeem attempt always burns it.
   *
   * `kind` is returned for audit but deliberately NOT matched against the
   * redeeming bridge — gating on it would force either id==kind brittleness or a
   * registration-schema coupling, and the only threat it closes (operator hands a
   * token to the wrong bridge type) is low-severity; the bridge-scope token + the
   * one-time invite are the real controls.
   */
  redeem(token: string): RedeemedInvite | null {
    const entry = this.pending.get(token);
    if (!entry) return null;
    this.pending.delete(token);
    if (this.nowFn() > entry.expiresAt) return null;
    return { kind: entry.kind, sessionId: entry.sessionId };
  }
}
