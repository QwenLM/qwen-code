/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared streaming-state utilities used by the TUI projection layer and other
 * consumers.
 */

import { CoreToolCallStatus, ROOT_TOOL_CALL_SCOPE_ID } from '@qwen-code/core';
import { StreamingState } from '../types.js';
import type {
  TrackedToolCall,
  TrackedCompletedToolCall,
  TrackedCancelledToolCall,
} from './useToolScheduler.js';

/**
 * Calculates the current streaming state based on tool call status and responding flag.
 */
export function calculateStreamingState(
  isResponding: boolean,
  toolCalls: TrackedToolCall[],
): StreamingState {
  // Any tool awaiting approval (including sub-scheduler tools) needs user attention.
  if (
    toolCalls.some((tc) => tc.status === CoreToolCallStatus.AwaitingApproval)
  ) {
    return StreamingState.WaitingForConfirmation;
  }

  // For active processing checks, only consider root-level tool calls.
  // Sub-scheduler tool calls (from within agents) have their own lifecycle
  // managed by the agent's scheduler, and their responseSubmittedToModel
  // flag is never set — so they would incorrectly keep the state as Responding.
  const rootToolCalls = toolCalls.filter(
    (tc) => !tc.toolCallScopeId || tc.toolCallScopeId === ROOT_TOOL_CALL_SCOPE_ID,
  );

  const isAnyToolActive = rootToolCalls.some((tc) => {
    // These statuses indicate active processing
    if (
      tc.status === CoreToolCallStatus.Executing ||
      tc.status === CoreToolCallStatus.Scheduled ||
      tc.status === CoreToolCallStatus.Validating
    ) {
      return true;
    }

    // Terminal statuses (success, error, cancelled) still count as "Responding"
    // if the result hasn't been submitted back to the model yet.
    // HOWEVER, if we're no longer responding (model loop ended/cancelled),
    // cancelled tools will never have their results submitted — don't block.
    if (
      tc.status === CoreToolCallStatus.Success ||
      tc.status === CoreToolCallStatus.Error ||
      tc.status === CoreToolCallStatus.Cancelled
    ) {
      // When the model is no longer responding, cancelled tool calls should
      // not keep the streaming state as "Responding" — they will never be
      // submitted to the model. This prevents the UI from getting stuck
      // after ESC cancellation.
      if (!isResponding && tc.status === CoreToolCallStatus.Cancelled) {
        return false;
      }
      return !(tc as TrackedCompletedToolCall | TrackedCancelledToolCall)
        .responseSubmittedToAssistant;
    }

    return false;
  });

  if (isResponding || isAnyToolActive) {
    return StreamingState.Responding;
  }

  return StreamingState.Idle;
}

/**
 * The overall turn may remain Responding while a local command or tool runs.
 * A model-owned turn and explicit local-command progress are the only sources
 * allowed to show the loading indicator. Model ownership remains active while
 * tools execute between provider requests.
 */
export function shouldShowLoadingIndicator(
  streamingState: StreamingState,
  isModelTurnActive: boolean,
  isCommandProgressActive: boolean,
  hasPendingActionRequired: boolean,
): boolean {
  return (
    streamingState === StreamingState.Responding &&
    (isModelTurnActive || isCommandProgressActive) &&
    !hasPendingActionRequired
  );
}
