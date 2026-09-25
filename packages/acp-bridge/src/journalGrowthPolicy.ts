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
 * the sum of growth granted across every live session sharing the pool
 * stays within the pool (derived once from the daemon memory budget), and
 * never past a per-session hard cap.
 *
 * A multi-workspace daemon runs one bridge per workspace but only ONE pool:
 * `runQwenServe` hands every bridge the same pool and a provider that
 * reports every sharing session's current cap, so each bridge's advisor
 * accounts against the same aggregate. The accounting is stateless on
 * purpose: the caller reports every sharing session's CURRENT journal byte
 * cap and its own starting baseline on each request, so there is no grant
 * ledger to reconcile when sessions are reaped. Growth beyond the baseline
 * is the accounted resource; baseline caps are not charged against the
 * pool. One journal's growth is charged per session, but a session retains
 * TWO journals (full plus summary projection) under the granted cap, so its
 * retained heap can reach ~2x the charged growth — an accepted over-commit
 * documented at JOURNAL_GROWTH_HARD_CAP_BYTES. Baselines are per-session,
 * so bridges sharing one pool may run different baselines without
 * mischarging each other's untouched sessions.
 */

import type { JournalGrowthSessionLimit } from './replayWindowLimits.js';

export interface JournalGrowthPolicyOptions {
  /** The per-session journal entry cap every session starts at. */
  baselineEvents: number;
  /** The per-session journal byte cap every session starts at. */
  baselineBytes: number;
  /**
   * Pool, in bytes, available for growth BEYOND the per-session baselines.
   * Derived once from the daemon memory budget by `runQwenServe` and shared
   * by every bridge it constructs; each bridge accounts every sharing
   * session's live cap against it.
   */
  poolBytes: number;
  /** Per-session hard cap the granted byte cap never exceeds. */
  hardCapBytes: number;
}

export interface JournalGrowthRequest {
  currentMaxEvents: number;
  currentMaxBytes: number;
  /**
   * Current journal byte caps of all live sessions sharing the pool,
   * INCLUDING the requester's pre-growth cap, each with the baseline cap
   * that session started at.
   */
  allSessionLimits: readonly JournalGrowthSessionLimit[];
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
  // N× the entry cap too (defaults: 10 000 entries / 8 MiB → 320 000
  // entries at the 256 MiB hard cap). The proportional product can exceed
  // the safe-integer range even when every input is a valid safe integer
  // (a tiny baseline byte cap with a huge entry cap); clamping keeps the
  // grant acceptable to the engine, which rejects unsafe caps whole.
  const hardCapEvents = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(
      opts.baselineEvents,
      Math.ceil((opts.hardCapBytes / opts.baselineBytes) * opts.baselineEvents),
    ),
  );
  return {
    grant(request: JournalGrowthRequest): JournalGrowthGrant | undefined {
      if (request.currentMaxBytes >= opts.hardCapBytes) return undefined;
      const extraGranted = request.allSessionLimits.reduce(
        (sum, session) =>
          sum + Math.max(0, session.limitBytes - session.baselineBytes),
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
