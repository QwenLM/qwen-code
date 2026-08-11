/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-wide accounting for adaptive live-journal growth.
 *
 * Each session's compaction engine starts at the configured journal caps
 * (defaults: 10 000 entries / 8 MiB). When an in-flight turn outgrows them
 * — the canonical case is a single turn fanning out many concurrent
 * subagents, whose streamed events all land on the parent session's bus —
 * the engine asks its growth advisor before evicting. This module is that
 * advisor's accounting core: it grants doublings of a session's caps while
 * the sum of growth granted across all live sessions stays within a
 * daemon-wide pool derived from the daemon memory budget, and never past a
 * per-session hard cap.
 *
 * The accounting is stateless on purpose: the caller reports every live
 * session's CURRENT journal byte cap on each request, so there is no grant
 * ledger to reconcile when sessions are reaped. Growth beyond the baseline
 * is the accounted resource; baseline caps are not charged against the pool.
 */

export interface JournalGrowthPolicyOptions {
  /** The per-session journal entry cap every session starts at. */
  baselineEvents: number;
  /** The per-session journal byte cap every session starts at. */
  baselineBytes: number;
  /**
   * Daemon-wide pool, in bytes, available for growth BEYOND the per-session
   * baselines. Derived from the daemon memory budget by `runQwenServe`.
   */
  poolBytes: number;
  /** Per-session hard cap the granted byte cap never exceeds. */
  hardCapBytes: number;
}

export interface JournalGrowthRequest {
  currentMaxEvents: number;
  currentMaxBytes: number;
  /**
   * Current journal byte caps of all live sessions, INCLUDING the
   * requester's pre-growth cap.
   */
  allSessionLimitBytes: readonly number[];
}

export interface JournalGrowthGrant {
  maxEvents: number;
  maxBytes: number;
}

export interface JournalGrowthPolicy {
  grant(request: JournalGrowthRequest): JournalGrowthGrant | undefined;
}

export function createJournalGrowthPolicy(
  opts: JournalGrowthPolicyOptions,
): JournalGrowthPolicy {
  // Entries scale proportionally with bytes so a byte cap grown N× carries
  // N× the entry cap too (defaults: 10 000 entries / 8 MiB → 327 680
  // entries at the 256 MiB hard cap).
  const hardCapEvents = Math.max(
    opts.baselineEvents,
    Math.ceil((opts.hardCapBytes / opts.baselineBytes) * opts.baselineEvents),
  );
  return {
    grant(request: JournalGrowthRequest): JournalGrowthGrant | undefined {
      if (request.currentMaxBytes >= opts.hardCapBytes) return undefined;
      const extraGranted = request.allSessionLimitBytes.reduce(
        (sum, limit) => sum + Math.max(0, limit - opts.baselineBytes),
        0,
      );
      const available = opts.poolBytes - extraGranted;
      if (available <= 0) return undefined;
      // Double toward the hard cap, but never take more than the pool has
      // left — the granted headroom can be fully consumed by this session.
      const maxBytes = Math.min(
        request.currentMaxBytes * 2,
        request.currentMaxBytes + available,
        opts.hardCapBytes,
      );
      if (maxBytes <= request.currentMaxBytes) return undefined;
      const maxEvents = Math.min(
        Math.max(
          request.currentMaxEvents,
          Math.ceil((maxBytes / opts.baselineBytes) * opts.baselineEvents),
        ),
        hardCapEvents,
      );
      return { maxBytes, maxEvents };
    },
  };
}
