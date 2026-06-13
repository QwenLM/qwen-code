/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session idle-suggestion overrides (`add-idle-suggestions` spec: "Per-session
 * toggle ... applies for the lifetime of that session only"). PURE in-memory
 * bookkeeping — the override lives for the process lifetime, which upper-bounds
 * "the session lifetime" (a session that ends just leaves a harmless stale entry;
 * bounded by the small number of live sessions). Every method is total.
 *
 * SEMANTICS (fork deviation, deliberate): an override of `false` DISABLES idle
 * suggestions for that session; an override of `true` means "follow the global
 * default" — it does NOT force egress on when the global switch is off. The
 * global `enabled` flag (idle.yaml, OFF by default) remains the SOLE egress gate,
 * because Option B ships transcript content off-box: a write-scoped remote client
 * must never be able to start that egress on a workstation whose operator hasn't
 * opted in. So the toggle can only NARROW (turn a session off), never widen.
 */
export class IdleSessionToggles {
  private readonly overrides = new Map<string, boolean>();

  /** Record a session's explicit enable/disable intent. */
  set(sessionId: string, enabled: boolean): void {
    this.overrides.set(sessionId, enabled);
  }

  /** The session's override, or `undefined` when it has never been toggled. */
  get(sessionId: string): boolean | undefined {
    return this.overrides.get(sessionId);
  }
}
