/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Internal experiment for #13004: after an extraction that read memory and
 * saved nothing, skip up to N following turns. Off (0) unless set; not a user
 * setting until paired runs show no missed or late memories.
 *
 * Like recall-experiment.ts, this module has no imports so the flag name has
 * exactly one definition.
 */
export const EXTRACT_NOOP_SKIP_TURNS_ENV =
  'QWEN_CODE_MEMORY_EXTRACT_NOOP_SKIP_TURNS';

export const MAX_EXTRACT_NOOP_SKIP_TURNS = 3;

/**
 * The extractor reads the last 40 curated history entries captured after the
 * turn (`captureCacheSafeParams`), not the cursor's unprocessed slice. A skip
 * is safe only while every unprocessed entry stays inside the next run's tail,
 * so skips stop at half of it. The guard counts raw entries, which are never
 * fewer than curated ones, so it errs toward running.
 */
export const EXTRACT_CADENCE_MAX_PENDING_ENTRIES = 20;

/** Upper bound for a pending-turn flush at a session or compaction boundary. */
export const EXTRACT_FLUSH_TIMEOUT_MS = 60_000;

export function getExtractNoopSkipTurns(): number {
  const raw = process.env[EXTRACT_NOOP_SKIP_TURNS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_EXTRACT_NOOP_SKIP_TURNS);
}
