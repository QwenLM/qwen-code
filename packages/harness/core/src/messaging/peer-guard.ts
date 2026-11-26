/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drop reporting with rate limiting.
 *
 * A misbehaving or looping peer can generate drops as fast as it can write to a
 * socket. Logging each one unbounded would bury the log and cost more than the
 * drop itself, so identical (sender, reason) pairs are collapsed inside a time
 * window and the total number of reports per window is capped.
 */

import { runLogger } from '../utils/runLogger.js';

/** Suppression window for repeated reports. */
export const DROP_REPORT_WINDOW_MS = 60_000;

/** Maximum distinct reports emitted per window. */
export const MAX_DROP_REPORTS_PER_WINDOW = 20;

/** Bound on remembered (sender, reason) pairs. */
export const MAX_TRACKED_DROP_KEYS = 256;

export type PeerDropReason =
  | 'loop-detected'
  | 'self-echo'
  | 'invalid-envelope'
  | 'invalid-frame'
  | 'refused'
  | 'oversized'
  | 'unknown-session';

export interface PeerDrop {
  from: string;
  reason: PeerDropReason;
}

interface TrackedDrop {
  lastReportedAt: number;
  suppressed: number;
}

export interface PeerDropReporter {
  /**
   * @returns whether this drop was reported, or swallowed by the window.
   *
   * Callers use it to hang their own per-drop work off the same suppression —
   * reporting, in particular, which a looping peer could otherwise emit as fast
   * as it can write to a socket.
   */
  report(drop: PeerDrop, now?: number): boolean;
  reset(): void;
}

export function createPeerDropReporter(): PeerDropReporter {
  const seen = new Map<string, TrackedDrop>();
  let windowStart = 0;
  let reportsInWindow = 0;
  let globallySuppressed = 0;

  return {
    report(drop: PeerDrop, now: number = Date.now()): boolean {
      // U+0000 as an escape, not as a literal byte: a literal one makes git treat
      // this whole source file as binary, so it stops appearing in diffs, in blame
      // and in `git add -p`. The key itself is byte-for-byte unchanged.
      const key = `${drop.from}\u0000${drop.reason}`;
      const previous = seen.get(key);
      if (previous && now - previous.lastReportedAt < DROP_REPORT_WINDOW_MS) {
        previous.suppressed += 1;
        return false;
      }

      if (now - windowStart >= DROP_REPORT_WINDOW_MS) {
        if (globallySuppressed > 0) {
          runLogger.debug(
            `[peer-guard] ${globallySuppressed} further drop(s) suppressed in the previous window`,
          );
        }
        windowStart = now;
        reportsInWindow = 0;
        globallySuppressed = 0;
      }

      if (reportsInWindow >= MAX_DROP_REPORTS_PER_WINDOW) {
        globallySuppressed += 1;
        return false;
      }
      reportsInWindow += 1;

      // Cheap LRU: Map preserves insertion order, so the first key is oldest.
      if (seen.size >= MAX_TRACKED_DROP_KEYS) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      const suppressed = previous?.suppressed ?? 0;
      seen.set(key, { lastReportedAt: now, suppressed: 0 });

      const tail =
        suppressed > 0 ? ` (${suppressed} similar suppressed)` : '';
      runLogger.debug(
        `[peer-guard] Dropped message from ${drop.from}: ${drop.reason}${tail}`,
      );
      return true;
    },

    reset(): void {
      seen.clear();
      windowStart = 0;
      reportsInWindow = 0;
      globallySuppressed = 0;
    },
  };
}

/** Process-wide reporter used by the inbound path. */
export const peerDropReporter = createPeerDropReporter();
