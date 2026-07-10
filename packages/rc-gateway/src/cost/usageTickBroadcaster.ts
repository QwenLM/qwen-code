/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session fan-out for `usage_tick` frames (`add-cost-tracking`: "`usage_tick`
 * SSE event" — subscribers receive the unmodified `session_update` AND a separate
 * `usage_tick`). The ingester (driven by the always-on session subscriber) writes
 * the row and pushes a coalesced tick here; each `/session/:id/events` relay
 * registers a writer for its session and forwards ticks onto its own SSE stream.
 *
 * This decouples ingestion (once per event, subscriber-independent) from delivery
 * (once per subscriber): the relay does NOT itself ingest, so rows are never
 * duplicated per-subscriber, and a session with zero subscribers still records
 * usage (the tick simply fans to nobody).
 *
 * `emit` is total — a throwing listener is swallowed so one wedged relay can never
 * break ingestion or the other relays.
 */

import type { UsageTick } from './ingester.js';

export class UsageTickBroadcaster {
  private readonly listeners = new Map<
    string,
    Set<(tick: UsageTick) => void>
  >();

  /** Register a per-session tick writer; returns an unregister function. */
  register(sessionId: string, write: (tick: UsageTick) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(write);
    return () => {
      const s = this.listeners.get(sessionId);
      if (!s) return;
      s.delete(write);
      if (s.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Fan a tick to every registered writer for its session. Never throws. */
  emit(tick: UsageTick): void {
    const set = this.listeners.get(tick.sessionId);
    if (!set) return;
    for (const write of set) {
      try {
        write(tick);
      } catch {
        // A wedged relay must not break ingestion or sibling subscribers.
      }
    }
  }

  /** Number of registered writers for a session (tests / introspection). */
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}
