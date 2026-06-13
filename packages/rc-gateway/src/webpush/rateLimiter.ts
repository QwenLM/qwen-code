/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default per-subscription push cap when a subscription sets no `maxPerHour`. */
export const DEFAULT_MAX_PER_HOUR = 30;

const HOUR_MS = 3_600_000;

interface SubWindow {
  /** Epoch-ms of each counted send within the rolling hour. */
  hits: number[];
  /** True while the subscription is currently at/over its cap (for firstDrop). */
  dropping: boolean;
}

/** Outcome of {@link PushRateLimiter.tryConsume}. */
export interface RateLimitResult {
  /** True if the send is under the cap (and was counted); false → caller drops. */
  allowed: boolean;
  /**
   * True ONLY on the transition INTO the rate-limited state (the first drop of a
   * burst). The caller audits `push_rate_limited` only when this is true, so a
   * 1000-event/sec storm produces ONE audit row, not 1000 — the rate limit must
   * not move the flood into the audit log.
   */
  firstDrop: boolean;
}

/**
 * Per-subscription rolling-window push rate limiter (anti-fatigue, NOT security).
 * In-memory only: a restart resets the counters, which is the FAIL-OPEN
 * direction (a limiter glitch must never SUPPRESS a notification — at worst a
 * small burst of extra pushes). Every method is pure/total (no I/O, never
 * throws), so the notifier's gate needs no try/catch to preserve fail-open.
 */
export class PushRateLimiter {
  private readonly subs = new Map<string, SubWindow>();

  /**
   * Record a send if the subscription is under `maxPerHour` within the rolling
   * hour ending at `nowMs`. Returns `{ allowed, firstDrop }`: `allowed` false
   * means the caller should DROP this push; `firstDrop` is true only on the
   * transition into the at-cap state (audit only then).
   */
  tryConsume(
    subId: string,
    maxPerHour: number,
    nowMs: number,
  ): RateLimitResult {
    const cutoff = nowMs - HOUR_MS;
    const entry = this.subs.get(subId) ?? { hits: [], dropping: false };
    // Prune instants that have aged out of the rolling window.
    entry.hits = entry.hits.filter((t) => t > cutoff);

    if (entry.hits.length >= maxPerHour) {
      const firstDrop = !entry.dropping;
      entry.dropping = true;
      this.subs.set(subId, entry);
      return { allowed: false, firstDrop };
    }

    entry.hits.push(nowMs);
    entry.dropping = false;
    this.subs.set(subId, entry);
    return { allowed: true, firstDrop: false };
  }

  /**
   * Read-only count of how many more events fit under `maxPerHour` within the
   * rolling hour ending at `nowMs`, WITHOUT consuming a slot. Used by the idle
   * `/suggest status` endpoint to report `remainingThisHour`. Pure (clamped to
   * `[0, maxPerHour]`; prunes a local copy so it never mutates the window).
   */
  remaining(subId: string, maxPerHour: number, nowMs: number): number {
    const cutoff = nowMs - HOUR_MS;
    const entry = this.subs.get(subId);
    const live = entry ? entry.hits.filter((t) => t > cutoff).length : 0;
    return Math.max(0, maxPerHour - live);
  }

  /** Forget a subscription's window (e.g. on unsubscribe). */
  forget(subId: string): void {
    this.subs.delete(subId);
  }
}
