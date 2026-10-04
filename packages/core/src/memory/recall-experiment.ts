/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Internal experiment for #13003: skip the model selector when the published
 * fast result is one title/keyword match with no body in history. Structured only.
 * Off unless set to `1` or `true`; not a user setting until an ablation shows
 * recall quality is unchanged.
 *
 * The flag name and its predicate live here, in a module with no imports,
 * because they are read from both sides of a module cycle: `memory/recall.ts`
 * owns the experiment but already imports `../telemetry/index.js`, so
 * `telemetry/loggers.ts` cannot import the name back from it. A single
 * definition here means renaming the flag moves every reader at compile time
 * instead of leaving a hand-copied predicate silently testing the old name.
 */
export const RECALL_SKIP_SELECTOR_ON_UNIQUE_STRONG_HIT_ENV =
  'QWEN_CODE_MEMORY_RECALL_SKIP_SELECTOR_ON_UNIQUE_STRONG_HIT';

export function isSkipSelectorOnUniqueStrongHitEnabled(): boolean {
  const raw =
    process.env[
      RECALL_SKIP_SELECTOR_ON_UNIQUE_STRONG_HIT_ENV
    ]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
