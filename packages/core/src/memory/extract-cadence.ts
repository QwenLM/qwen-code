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
 * so a skip needs at most half of it pending. The guard counts raw entries,
 * which are never fewer than curated ones, so it errs toward running. It is
 * checked at skip time only: a following turn that adds more entries than the
 * remaining room can still push a skipped turn out of the next run's tail.
 * That is a known limit of this experiment, not a guarantee.
 */
export const EXTRACT_CADENCE_MAX_PENDING_ENTRIES = 20;

/** Default bound for the pending-turn flush at an ACP session close. */
export const EXTRACT_FLUSH_TIMEOUT_MS = 60_000;

export function getExtractNoopSkipTurns(): number {
  const raw = process.env[EXTRACT_NOOP_SKIP_TURNS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_EXTRACT_NOOP_SKIP_TURNS);
}
