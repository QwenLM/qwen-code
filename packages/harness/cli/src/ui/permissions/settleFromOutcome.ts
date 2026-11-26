/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * From a dialog button to a settled prompt.
 *
 * The confirmation dialog speaks `ToolConfirmationOutcome` — five values that mix
 * two separate questions together: *may it run*, and *how long do you mean it for*.
 * The module only asks the first; the second decides what to remember. So the
 * translation here is a split, not a rename: the scope half is handed to the
 * store's `onRemember`, which maps it onto the prompt's full suggestion list the
 * same way the other channels do.
 */

import {
  runLogger,
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
} from '@qwen-code/core';
import type { QueuedPermissionPrompt } from './permissionQueueStore.js';

/** Which approval scope a dialog outcome means. */
function scopeOf(
  outcome: ToolConfirmationOutcome,
): 'once' | 'session' | 'persist' | 'cancel' {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedSession:
      return 'session';
    case ToolConfirmationOutcome.ProceedPersist:
      return 'persist';
    case ToolConfirmationOutcome.Cancel:
      return 'cancel';
    default:
      // ProceedOnce, and ModifyWithEditor — the edit is applied to the call
      // itself, so as far as remembering goes it grants nothing.
      return 'once';
  }
}

/** The feedback a user typed when refusing, when they refused with a message. */
function cancelFeedbackOf(
  payload: ToolConfirmationPayload | undefined,
): string | undefined {
  return payload && 'cancelFeedback' in payload
    ? payload.cancelFeedback
    : undefined;
}

export function settlePromptFromOutcome(
  prompt: QueuedPermissionPrompt,
  outcome: ToolConfirmationOutcome,
  payload?: ToolConfirmationPayload,
): void {
  const payloadKeys =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload).join(',')
      : '';
  runLogger.log(
    `[permission-ask] dialog tool=${prompt.toolName} id=${prompt.toolUseId} ` +
      `outcome=${outcome} payloadKeys=[${payloadKeys}]`,
  );

  // A user pressing "no" in the dialog is a refusal, not an unanswered prompt.
  // Aborts come from elsewhere — escape, or the turn being interrupted. The
  // message they typed on the way out rides into the settlement, so it reaches
  // the model as the denial message instead of being dropped.
  if (outcome === ToolConfirmationOutcome.Cancel) {
    prompt.reject(cancelFeedbackOf(payload));
    return;
  }

  const scope = scopeOf(outcome);

  // An AskUserQuestion answer arrives as the payload and *is* an amendment of the
  // call. The module re-checks the amended input before the approval stands.
  const answered =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as unknown as Record<string, unknown>)
      : undefined;

  prompt.approve({
    ...(scope === 'session' || scope === 'persist' ? { scope } : {}),
    ...(answered ? { input: { ...prompt.input, ...answered } } : {}),
  });
}
