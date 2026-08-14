/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

/**
 * Markers embedded in tool `functionResponse` error text that distinguish
 * synthesized terminal notices (cancellation, policy denial) from genuine
 * tool failures. Producers (`coreToolScheduler`) and consumers
 * (`experience-signals`, the UI completion loops) must share these constants:
 * a reworded notice would otherwise silently desynchronize classification.
 */

/** Prefix of the synthesized error text reported for a cancelled tool call. */
export const OPERATION_CANCELLED_PREFIX = '[Operation Cancelled]';

export function operationCancelledErrorMessage(reason: string): string {
  return `${OPERATION_CANCELLED_PREFIX} Reason: ${reason}`;
}

// The cancellation notice handed to the model depends on whether the tool's
// work actually finished. Claiming a tool "already completed" when it was
// interrupted mid-flight makes the model skip work that never happened; the
// converse makes it redo work whose side effects already landed.
export const TOOL_CANCELLED_BEFORE_COMPLETION_MESSAGE =
  'User cancelled tool execution.';
export const TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE =
  'The tool had already completed; its output was discarded.';

/**
 * Prefix of the policy-denial error text for a tool call that was never
 * executed (permission declined, legacy deny-list, non-interactive
 * auto-deny).
 */
export const PERMISSION_DECLINED_MESSAGE_PREFIX =
  'Qwen Code requires permission to use';

/**
 * Whether a settled tool call counts as completed work for the skill-review
 * window. A call does NOT count when it never ran (`not_started` — policy
 * denials, pre-execution cancellations) or when it was cancelled before its
 * work finished. An after-completion cancellation DOES count: the tool's
 * side effects already landed before its output was discarded, so e.g. a
 * cancelled-after-completion skill write must still flip
 * `skillsModifiedInSession`.
 */
export function didToolCallProduceWork(outcome: {
  status?: 'success' | 'error' | 'cancelled';
  executionStatus?: string;
  responseParts?: readonly Part[];
}): boolean {
  if (outcome.executionStatus === 'not_started') {
    return false;
  }
  if (outcome.status !== 'cancelled') {
    return true;
  }
  for (const part of outcome.responseParts ?? []) {
    const error = part.functionResponse?.response?.['error'];
    if (typeof error === 'string') {
      return error.includes(TOOL_CANCELLED_AFTER_COMPLETION_MESSAGE);
    }
  }
  return false;
}
