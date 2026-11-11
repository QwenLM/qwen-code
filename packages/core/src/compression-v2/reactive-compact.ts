/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reactive compact — triggered by a real API prompt-too-long error.
 *
 * Unlike auto-compact (which fires proactively before sending the request),
 * reactive compact fires *after* the API returns a genuine context-overflow
 * error.  It compresses the current history and signals the agent loop to
 * retry the API call with the compacted history.
 *
 * Design:
 *  - Single-shot per query iteration: the agent-loop guards the call site
 *    with `!state.hasAttemptedReactiveCompact` to prevent infinite retry loops.
 *  - Delegates to `CompressionPipeline.compress({ force: true, trigger: 'reactive' })`
 *    so the same fork-compact path are reused.
 *  - Does NOT fire the PreCompact hook (the hook was not designed for
 *    error-recovery scenarios; it is already fired by the pipeline internally).
 */

import type { CompressionPipeline, CompressOptions } from './pipeline.js';
import type { Message } from './message-types.js';
import type { CompressionPipelineResult } from './types.js';
import { CompressionStatus } from '../core/turn-events.js';
import { isCancellationError } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import { isModelPaidConfirmationRequired } from '../protocol/provider/qoder-api-error.js';

export interface ReactiveCompactParams {
  /** Current message history (full, including boundary markers). */
  history: readonly Message[];
  /** The pipeline to delegate compression to. */
  compressionPipeline: CompressionPipeline;
  /** Base compress options (minus `force`/`trigger`, which are overridden). */
  compressOptions: Omit<CompressOptions, 'force' | 'trigger'>;
}

/**
 * Attempt reactive compaction after a prompt-too-long API error.
 *
 * Returns the pipeline result when compaction succeeded, or `null` when
 * the pipeline produced no new history (NOOP or failure).
 *
 * Callers are responsible for ensuring this is only called once per query
 * iteration (guard with `!state.hasAttemptedReactiveCompact`).
 */
export async function tryReactiveCompact(
  params: ReactiveCompactParams,
): Promise<CompressionPipelineResult | null> {
  const { history, compressionPipeline, compressOptions } = params;

  runLogger.debug(
    '[reactive-compact] API returned prompt-too-long — triggering forced compaction',
  );

  let result: CompressionPipelineResult;
  try {
    result = await compressionPipeline.compress(history, {
      ...compressOptions,
      force: true,
      trigger: 'reactive',
    });
  } catch (err) {
    if (
      isCancellationError(err, compressOptions.abortSignal) ||
      isModelPaidConfirmationRequired(err)
    ) {
      throw err;
    }
    runLogger.error('[reactive-compact] compress() threw:', err);
    return null;
  }

  if (
    result.newHistory === null ||
    result.info.compressionStatus !== CompressionStatus.COMPRESSED
  ) {
    runLogger.debug(
      '[reactive-compact] compression did not produce a new history — status:',
      result.info.compressionStatus,
    );
    return null;
  }

  runLogger.debug(
    `[reactive-compact] compacted: ${result.info.originalTokenCount} → ${result.info.newTokenCount} tokens`,
  );
  return result;
}
