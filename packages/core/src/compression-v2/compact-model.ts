/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import { createModelRequestGuard } from '../provider/session-model.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import type { CompactModelSource, CompressionPipelineInput } from './types.js';

/** Select only when a summary is needed, then keep that decision for retries. */
export function ensureCompactModelSelected(
  input: CompressionPipelineInput,
): Promise<ModelSelection> {
  return (input.compactModelSelection ??= (async () => {
    input.abortSignal?.throwIfAborted();
    const result: {
      selection: ModelSelection;
      policyLabels?: CompressionPipelineInput['policyLabels'];
      source?: CompactModelSource;
    } = input.resolveCompactSelection
      ? await raceWithAbortSignal(
          input.resolveCompactSelection(),
          input.abortSignal,
        )
      : await (async () => {
          const assertCurrent = createModelRequestGuard(
            input.config,
            input.abortSignal,
          );
          const workdirs =
            input.config.getWorkspaceContext?.().getDirectories() ?? [];
          const selection = await raceWithAbortSignal(
            input.modelProviderManager.select({
              purpose: 'compact',
              parentSelection: input.modelResolution,
              ...(workdirs.length > 0 ? { workdirs } : {}),
            }),
            input.abortSignal,
          );
          assertCurrent();
          return { selection };
        })();
    input.abortSignal?.throwIfAborted();
    const selected = result.selection;
    // The manager has already merged and clipped the final configuration.
    input.modelResolution = selected;
    input.policyLabels = result.policyLabels ?? input.policyLabels;
    input.compactModelSource = result.source;
    try {
      input.onCompactModelSelected?.(selected, result.source);
    } catch {
      // A selection observer must not affect model selection or execution.
    }
    return selected;
  })());
}
