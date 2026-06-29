/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for the RuntimeModelSnapshot ID prefix.
 *
 * Kept dependency-free (no imports) so it can be consumed from any layer —
 * including `modelsConfig.ts`, which sits in an import cycle with `modelId.ts`
 * via `contentGenerator.ts` and would crash on init if it imported the prefix
 * from there.
 */

/** Runtime model snapshot ID prefix; format `$runtime|${authType}|${modelId}`. */
export const RUNTIME_SNAPSHOT_PREFIX = '$runtime|';

/**
 * Recover the bare model ID from a (possibly runtime-prefixed) model string.
 * Strips every layer so nested prefixes self-heal; bare IDs pass through.
 */
export function stripRuntimeSnapshotPrefix(modelId: string): string {
  let id = modelId;
  while (id.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
    const stripped = id.split('|').slice(2).join('|');
    if (!stripped) break; // malformed prefix — don't destroy the value
    id = stripped;
  }
  return id;
}
