/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Pipeline-state cleanup after compression completes.
 *
 * This is the pipeline half of post-compact cleanup. It covers state reachable
 * from the compression context:
 *   - query-scoped consecutiveFailures counter (auto-compact back-off)
 *   - MemoryContextManager.refresh() so nested-memory / AGENTS.md pick up
 *     file changes that happened during the compressed-away turns
 *
 * UI notification (scrollback row for "Conversation compacted") is NOT done
 * here — it is handled by `applyPostCompact`'s `onCompactionPersisted`
 * callback, which fires atomically with the transcript write so the banner
 * only appears when the compaction is actually on disk. Scoping via that
 * callback also prevents subagent pipelines (which don't pass it) from
 * leaking compactions into the parent's scrollback.
 *
 * The *attachment-context* half of cleanup lives in post-compact-recovery.ts
 * — it needs the AttachmentToolUseContext owned by QueryEngine, which is not
 * reachable from this pipeline stage. See that file's docblock for the
 * list of delta fields reset there and the recovery attachments built.
 *
 * Together these two files implement the single runPostCompactCleanup()
 * pattern, split along the pipeline vs. engine ownership boundary.
 */

import { CompressionStatus } from '../core/turn-events.js';
import { isBlockingCompactionFailureReason } from './types.js';
import type {
  CompressionPipelineResult,
  CompressionStageContext,
} from './types.js';

export async function runCompressionCleanup(
  result: CompressionPipelineResult,
  context: CompressionStageContext,
): Promise<void> {
  const { compressionStatus } = result.info;
  const tracking = context.input.autoCompactTracking;

  if (
    compressionStatus === CompressionStatus.COMPRESSED ||
    compressionStatus === CompressionStatus.CONTENT_TRUNCATED
  ) {
    tracking.consecutiveFailures = 0;
    delete tracking.lastFailureReason;
    delete tracking.blockedReason;
    if (compressionStatus === CompressionStatus.COMPRESSED) {
      // Refresh memory context so post-compact state picks up any
      // file changes that occurred during the compressed-away turns.
      // The compact refresh resets hook dedup inside the manager's queued
      // transaction so it cannot race with another in-flight refresh.
      const mcm = context.input.config.getMemoryContextManager?.();
      if (mcm) {
        await mcm.refresh('compact');
      }
    }
    return;
  }

  // Manual and reactive compaction may clear the breaker on success, but their
  // failures must never consume the automatic retry budget.
  if (context.input.trigger !== 'auto') {
    return;
  }

  if (
    context.input.abortSignal?.aborted ||
    result.info.failureReason === 'cancelled' ||
    // The request runner already bounded access waiting/retries. This failure
    // says nothing about the model's ability to summarize after access recovers.
    result.info.failureReason === 'provider_access'
  ) {
    return;
  }

  const failureReason =
    result.info.failureReason ??
    CompressionStatus[compressionStatus].toLowerCase();

  if (
    compressionStatus === CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR
  ) {
    tracking.blockedReason = 'local_error';
    tracking.lastFailureReason = failureReason;
    return;
  }

  if (
    compressionStatus === CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST
  ) {
    // Blocking reasons (retrying can't repair them) short-circuit the breaker.
    // Membership is enforced against the shared union by the type guard, so
    // adding a blocking reason is a compile error at its table, not a silently
    // mis-counted breaker strike here.
    const reason = result.info.failureReason;
    if (isBlockingCompactionFailureReason(reason)) {
      tracking.blockedReason = reason;
      tracking.lastFailureReason = reason;
      return;
    }
  }

  if (
    compressionStatus ===
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT ||
    compressionStatus === CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY ||
    compressionStatus === CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST
  ) {
    tracking.consecutiveFailures += 1;
    tracking.lastFailureReason = failureReason;
  }
}
