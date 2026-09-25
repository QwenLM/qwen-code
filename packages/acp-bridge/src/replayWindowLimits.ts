/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_COMPACTED_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_COMPACTED_REPLAY_MAX_BYTES = 256 * 1024 * 1024;

export const DEFAULT_MAX_JOURNAL_EVENTS = 10_000;
export const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

/**
 * Per-session hard cap adaptive live-journal growth never exceeds,
 * regardless of the daemon-wide growth pool. Aligned with
 * `MAX_COMPACTED_REPLAY_MAX_BYTES` — both bound daemon heap retained for
 * one session's replay state.
 *
 * Memory-ceiling note: one in-flight turn retains TWO journals that share
 * these caps — the `full` journal plus the `summary` projection for
 * summary-mode loads — so a session's live-journal heap is bounded by
 * twice the effective cap (2x the baseline, or 2x the grown cap under
 * adaptive growth), not one. Operators sizing daemon memory from
 * `maxJournalBytes x live sessions` must double the journal term.
 */
export const JOURNAL_GROWTH_HARD_CAP_BYTES = 256 * 1024 * 1024;

/**
 * One live session's contribution to growth-pool accounting: its current
 * journal byte cap plus the cap it started at. Growth beyond the session's
 * OWN baseline is the accounted resource, so sessions on bridges with
 * different baselines are each charged from their own starting cap.
 */
export interface JournalGrowthSessionLimit {
  /** The session's current journal byte cap. */
  limitBytes: number;
  /** The journal byte cap the session started at. */
  baselineBytes: number;
}

export function normalizeCompactedReplayMaxBytes(
  value: number | undefined,
): number {
  if (value === undefined) return DEFAULT_COMPACTED_REPLAY_MAX_BYTES;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_COMPACTED_REPLAY_MAX_BYTES
  ) {
    throw new TypeError(
      `Invalid compactedReplayMaxBytes: ${value}. ` +
        `Must be a positive safe integer in [1, ${MAX_COMPACTED_REPLAY_MAX_BYTES}].`,
    );
  }
  return value;
}

export function normalizeMaxJournalEvents(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_JOURNAL_EVENTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid maxJournalEvents: ${value}. ` +
        'Must be a positive safe integer.',
    );
  }
  return value;
}

export function normalizeMaxJournalBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_JOURNAL_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid maxJournalBytes: ${value}. ` +
        'Must be a positive safe integer.',
    );
  }
  return value;
}

/**
 * `undefined` disables adaptive journal growth (the policy is only wired
 * when a pool is configured — `runQwenServe` derives one from the daemon
 * memory budget unless the operator pinned the journal flags).
 */
export function normalizeJournalGrowthPoolBytes(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid journalGrowthPoolBytes: ${value}. ` +
        'Must be a positive safe integer.',
    );
  }
  return value;
}
