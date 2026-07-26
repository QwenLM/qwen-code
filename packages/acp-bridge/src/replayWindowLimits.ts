/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_COMPACTED_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_COMPACTED_REPLAY_MAX_BYTES = 256 * 1024 * 1024;

export const DEFAULT_MAX_JOURNAL_EVENTS = 10_000;
export const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

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
