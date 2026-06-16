/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Owner-managed bans of individual chat users (`add-bridge-protocol`): an owner
 * can block one `subActor` (e.g. `telegram:alice`) WITHOUT revoking the bridge's
 * token — every other user on that bridge keeps working. A banned sub-actor's
 * writes (prompts/votes) are rejected 403.
 *
 * Keyed by the sub-actor id alone. Because sub-actor ids are service-namespaced
 * (`telegram:alice`, `discord:123`), the id is already effectively bridge-scoped,
 * so a single key honors the spec's "from a specific bridge" intent without
 * threading a token→bridge-id lookup into the hot write path. The ban ROUTE
 * still takes the bridge `:id` for audit context.
 *
 * In-memory (mirrors the bridge registry; a gateway restart clears bans — every
 * ban/lift is audited, so prior bans are visible in the log and re-appliable).
 * Every method is total.
 */
export class SubActorBanStore {
  private readonly banned = new Set<string>();

  /** Ban a sub-actor. Idempotent. */
  ban(subActor: string): void {
    this.banned.add(subActor);
  }

  /** Lift a ban; returns true if one existed. */
  lift(subActor: string): boolean {
    return this.banned.delete(subActor);
  }

  /** Is this sub-actor currently banned? */
  isBanned(subActor: string): boolean {
    return this.banned.has(subActor);
  }

  /** All currently-banned sub-actor ids. */
  list(): string[] {
    return [...this.banned];
  }
}
