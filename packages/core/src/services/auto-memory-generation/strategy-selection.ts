/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type AutoMemoryGenerationSelection =
  | { kind: 'existing' }
  | { kind: 'fork_full_context' }
  | { kind: 'independent_model_incremental'; model: string };

/** Freezes one strategy decision for the lifetime of a CLI session. */
export class AutoMemoryGenerationStrategySession {
  private selection?: AutoMemoryGenerationSelection;

  resolve(sdkControlled: boolean): AutoMemoryGenerationSelection {
    return (this.selection ??= resolveAutoMemoryGenerationSelection(
      sdkControlled,
    ));
  }
}

/**
 * Selects only the execution strategy. Turn Complete enablement and cadence are
 * evaluated by AutoMemoryExtractionService before this function is called.
 *
 * Generation is on by default and runs in the parent context; SDK callers keep
 * their own generation orchestration.
 */
export function resolveAutoMemoryGenerationSelection(
  sdkControlled: boolean,
): AutoMemoryGenerationSelection {
  if (sdkControlled) return { kind: 'existing' };
  return { kind: 'fork_full_context' };
}
