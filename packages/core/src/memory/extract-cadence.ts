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
 * turn (`captureCacheSafeParams`), not the cursor's unprocessed slice. Named
 * once here so the capture site and the cadence gates cannot drift apart.
 */
export const EXTRACT_TAIL_ENTRIES = 40;

/**
 * A skip is safe only while every unprocessed entry stays inside the next
 * run's tail, so a skip needs at most half of it pending. The guard counts
 * raw entries, which are never fewer than curated ones, so it errs toward
 * running. It is checked at skip time only: a following turn that adds more
 * entries than the remaining room can still push a skipped turn out of the
 * next run's tail. The next extraction supplements its tail with the part of
 * that skipped slice the captured tail no longer holds, so skipped entries
 * remain visible — once, not twice.
 */
export const EXTRACT_CADENCE_MAX_PENDING_ENTRIES = EXTRACT_TAIL_ENTRIES / 2;

export function getExtractNoopSkipTurns(): number {
  const raw = process.env[EXTRACT_NOOP_SKIP_TURNS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_EXTRACT_NOOP_SKIP_TURNS);
}
