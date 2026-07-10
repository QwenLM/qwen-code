/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default rolling window for the per-sub-actor write limit (60 s). */
export const SUB_ACTOR_WINDOW_MS = 60_000;
/** Default cap: writes allowed per sub-actor within the window. */
export const DEFAULT_SUB_ACTOR_CAP = 30;
/** Rolling window for the per-token cardinality cap (24 h). */
export const CARDINALITY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default max distinct sub-actors per bridge token in 24 h. */
export const DEFAULT_CARDINALITY_CAP = 200;

interface Window {
  /** Epoch-ms of each counted write within the rolling window. */
  hits: number[];
  /** True while the sub-actor is currently at/over cap (for firstDrop). */
  dropping: boolean;
}

/**
 * Per-token sub-actor cardinality tracker: records the epoch-ms of the FIRST
 * seen event for each distinct sub-actor within a 24 h rolling window. When
 * the count of distinct sub-actors whose first-seen timestamp falls within the
 * window reaches the cap, new (unseen) sub-actors are rejected.
 */
interface CardinalityEntry {
  /** sub-actor id → epoch-ms of first observation within the 24 h window. */
  firstSeen: Map<string, number>;
}

export interface SubActorLimitResult {
  /** True if the write is under cap (and was counted); false → caller 429s. */
  allowed: boolean;
  /** True ONLY on the transition into the limited state (audit once per burst). */
  firstDrop: boolean;
}

export interface CardinalityResult {
  /** True if the sub-actor is allowed (either already-seen or under cap). */
  allowed: boolean;
}

/**
 * Per-sub-actor rolling-window write limiter (`add-bridge-protocol`): a bridge
 * fans in N external humans, so one rude chat user must not saturate the
 * per-session FIFO with prompts/votes. Keyed by the asserted sub-actor id
 * (`telegram:alice`), independent of the bridge token. In-memory; a restart
 * resets counters (FAIL-OPEN — a glitch must never WEDGE a real user, at worst
 * it lets a small burst through). Pure/total (no I/O, never throws). Mirrors the
 * push rate limiter's rolling-window + firstDrop shape, in the bridge domain.
 *
 * Also enforces a per-token sub-actor CARDINALITY cap: each distinct sub-actor
 * is admitted once its first-seen epoch falls within the 24 h rolling window.
 * When the number of distinct sub-actors in the window reaches `cardinalityCap`,
 * any NEW (never-before-seen within the window) sub-actor is rejected with
 * `allowed: false`. Already-seen sub-actors are always served regardless of cap.
 */
export class SubActorRateLimiter {
  private readonly windowMs: number;
  private readonly cardinalityWindowMs: number;
  private readonly cardinalityCap: number;
  private readonly subs = new Map<string, Window>();
  /** tokenId → cardinality tracking entry. */
  private readonly cardinality = new Map<string, CardinalityEntry>();

  constructor(
    windowMs: number = SUB_ACTOR_WINDOW_MS,
    cardinalityWindowMs: number = CARDINALITY_WINDOW_MS,
    cardinalityCap: number = DEFAULT_CARDINALITY_CAP,
  ) {
    this.windowMs = windowMs;
    this.cardinalityWindowMs = cardinalityWindowMs;
    this.cardinalityCap = cardinalityCap;
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

  /**
   * Check and record that `subActor` is active under `tokenId` at `nowMs`.
   * Already-seen sub-actors (whose first-seen epoch is within the 24 h window)
   * are always allowed. New sub-actors are allowed only when the count of
   * distinct sub-actors in the window is below `cardinalityCap`; otherwise
   * `{ allowed: false }` → caller should 429 with `sub_actor_cardinality_exceeded`.
   */
  checkCardinality(
    tokenId: string,
    subActor: string,
    nowMs: number,
  ): CardinalityResult {
    const cutoff = nowMs - this.cardinalityWindowMs;
    let entry = this.cardinality.get(tokenId);
    if (!entry) {
      entry = { firstSeen: new Map() };
      this.cardinality.set(tokenId, entry);
    }
    // Evict sub-actors whose first-seen has aged out of the 24 h window.
    for (const [sa, t] of entry.firstSeen) {
      if (t <= cutoff) entry.firstSeen.delete(sa);
    }
    // Already tracked within the window → always allow.
    if (entry.firstSeen.has(subActor)) {
      return { allowed: true };
    }
    // New sub-actor: admit only if still under cap.
    if (entry.firstSeen.size >= this.cardinalityCap) {
      return { allowed: false };
    }
    entry.firstSeen.set(subActor, nowMs);
    return { allowed: true };
  }

  /** Forget a sub-actor's window (e.g. on ban or cleanup). */
  forget(subActor: string): void {
    this.subs.delete(subActor);
  }
}
