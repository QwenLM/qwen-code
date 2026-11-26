/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
} from '@qwen-code/core';
function getToolConfirmationScope(
  outcome: ToolConfirmationOutcome,
): 'once' | 'session' | 'persist' | undefined {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedSession:
      return 'session';
    case ToolConfirmationOutcome.ProceedPersist:
      return 'persist';
    case ToolConfirmationOutcome.ProceedOnce:
    case ToolConfirmationOutcome.ModifyWithEditor:
      return 'once';
    case ToolConfirmationOutcome.Cancel:
      return undefined;
    default:
      return undefined;
  }
}

export function settleToolConfirmation(
  prompt: {
    toolName: string;
    input: Record<string, unknown>;
    approve(options?: {
      input?: Record<string, unknown>;
      scope?: 'session' | 'persist';
    }): void;
    reject(reason?: string): void;
    abort(): void;
  },
  answer: {
    outcome: ToolConfirmationOutcome;
    payload?: ToolConfirmationPayload;
    rejectSource?: 'human' | 'programmatic';
  },
): void {
  if (answer.outcome === ToolConfirmationOutcome.Cancel) {
    if (answer.rejectSource === 'programmatic') {
      prompt.abort();
    } else {
      // The message the controller typed on the way out rides into the
      // settlement, the same as the TUI dialog's refusal feedback.
      prompt.reject(
        answer.payload && 'cancelFeedback' in answer.payload
          ? answer.payload.cancelFeedback
          : undefined,
      );
    }
    return;
  }

  // An AskUserQuestion answer arrives as the payload and *is* the amendment: the
  // module re-checks the amended input before the approval stands.
  const answered = asRecord(answer.payload);
  const selectedScope = getToolConfirmationScope(answer.outcome);
  const scope = selectedScope === 'once' ? undefined : selectedScope;
  prompt.approve({
    ...(answered ? { input: { ...prompt.input, ...answered } } : {}),
    ...(scope ? { scope } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
