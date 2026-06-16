/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default rolling window for the per-sub-actor write limit (60 s). */
export const SUB_ACTOR_WINDOW_MS = 60_000;
/** Default cap: writes allowed per sub-actor within the window. */
export const DEFAULT_SUB_ACTOR_CAP = 30;

interface Window {
  /** Epoch-ms of each counted write within the rolling window. */
  hits: number[];
  /** True while the sub-actor is currently at/over cap (for firstDrop). */
  dropping: boolean;
}

export interface SubActorLimitResult {
  /** True if the write is under cap (and was counted); false → caller 429s. */
  allowed: boolean;
  /** True ONLY on the transition into the limited state (audit once per burst). */
  firstDrop: boolean;
}

/**
 * Per-sub-actor rolling-window write limiter (`add-bridge-protocol`): a bridge
 * fans in N external humans, so one rude chat user must not saturate the
 * per-session FIFO with prompts/votes. Keyed by the asserted sub-actor id
 * (`telegram:alice`), independent of the bridge token. In-memory; a restart
 * resets counters (FAIL-OPEN — a glitch must never WEDGE a real user, at worst
 * it lets a small burst through). Pure/total (no I/O, never throws). Mirrors the
 * push rate limiter's rolling-window + firstDrop shape, in the bridge domain.
 */
export class SubActorRateLimiter {
  private readonly windowMs: number;
  private readonly subs = new Map<string, Window>();

  constructor(windowMs: number = SUB_ACTOR_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Record a write for `subActor` if under `cap` within the rolling window
   * ending at `nowMs`. `allowed:false` → caller should 429; `firstDrop` true
   * only on the transition into the at-cap state (audit only then).
   */
  tryConsume(
    subActor: string,
    cap: number,
    nowMs: number,
  ): SubActorLimitResult {
    const cutoff = nowMs - this.windowMs;
    const entry = this.subs.get(subActor) ?? { hits: [], dropping: false };
    entry.hits = entry.hits.filter((t) => t > cutoff);
    if (entry.hits.length >= cap) {
      const firstDrop = !entry.dropping;
      entry.dropping = true;
      this.subs.set(subActor, entry);
      return { allowed: false, firstDrop };
    }
    entry.hits.push(nowMs);
    entry.dropping = false;
    this.subs.set(subActor, entry);
    return { allowed: true, firstDrop: false };
  }

  /** Forget a sub-actor's window (e.g. on ban or cleanup). */
  forget(subActor: string): void {
    this.subs.delete(subActor);
  }
}
