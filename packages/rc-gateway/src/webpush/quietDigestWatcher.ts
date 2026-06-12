/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseTimeOfDay, isWithinTimeOfDay } from '../policy/conditions.js';

/** The minimal subscription shape the watcher reads. */
export interface QuietDigestRecord {
  id: string;
  quietHours?: { from: string; to: string; timezone: string };
}

/**
 * Edge-detects the moment each subscription LEAVES its quiet window, so the
 * notifier can flush a "while you were away" digest (webpush design D4).
 *
 * POLL-based, deliberately NOT a per-tz end-of-window `setTimeout`: each `tick`
 * re-evaluates `isWithinTimeOfDay` (the cycle-22 DST-correct Intl projection
 * already used by the quiet-hours gate) for every CURRENT subscription and fires
 * on the quiet -> not-quiet transition. This avoids fragile tz/DST end-instant
 * math AND the per-sub timer lifecycle (cancel/reschedule on every
 * PATCH-quietHours, cancel on unsubscribe): re-reading the live subscription list
 * each tick picks those up for free. Latency is bounded by the tick interval,
 * which is fine for a digest.
 *
 * State is initialized on a subscription's FIRST sighting, so a sub already
 * mid-quiet when the gateway starts does not spuriously fire on the first tick —
 * it only fires on a LATER exit. The state map is pruned of ids no longer present
 * so it stays bounded without any DELETE-path wiring.
 *
 * Pure/total: `parseTimeOfDay`/`isWithinTimeOfDay` are internally guarded and
 * never throw, so `tick` never throws.
 */
export class QuietDigestWatcher {
  /** subId -> whether the subscription was inside its quiet window last tick. */
  private readonly wasQuiet = new Map<string, boolean>();

  /**
   * Re-evaluate every record's quiet state at `now`. Invokes `fire(id)` exactly
   * once for each subscription that was quiet on the previous tick and is no
   * longer quiet now (the window just ended). First sighting only seeds state.
   */
  tick(
    records: QuietDigestRecord[],
    now: Date,
    fire: (id: string) => void,
  ): void {
    const seen = new Set<string>();
    for (const r of records) {
      seen.add(r.id);
      const window = r.quietHours ? parseTimeOfDay(r.quietHours) : null;
      const quietNow = window ? isWithinTimeOfDay(window, now) : false;
      const prev = this.wasQuiet.get(r.id);
      if (prev === true && quietNow === false) {
        fire(r.id);
      }
      this.wasQuiet.set(r.id, quietNow);
    }
    // Prune subscriptions that vanished (unsubscribed) so the map stays bounded.
    for (const id of [...this.wasQuiet.keys()]) {
      if (!seen.has(id)) this.wasQuiet.delete(id);
    }
  }

  /** Drop a subscription's edge state (not required — prune-on-tick covers it). */
  forget(id: string): void {
    this.wasQuiet.delete(id);
  }
}
