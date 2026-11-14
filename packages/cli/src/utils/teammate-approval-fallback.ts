/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { TeammateApprovalRequestEvent } from '@qwen-code/qwen-code-core/agents/team/team-events.js';

/** Host-specific wording for the cases where the host cannot prompt. */
export interface TeammateApprovalHostCopy {
  /** Where approvals cannot be prompted, e.g. "non-stream-json mode". */
  surface: string;
  /** What to do when a request needs an explicit approval surface. */
  explicitApprovalHint: string;
  /** What to do to let teammate tool calls through. */
  allowHint: string;
}

export type TeammateApprovalFallbackDecision =
  | { action: 'proceed' }
  | { action: 'cancel'; reason: string };

/**
 * Decide a teammate tool approval for a host with no interactive surface:
 * YOLO lets it through unless the request demands explicit host approval,
 * everything else is cancelled with a reason the leader can read.
 */
export function decideTeammateApprovalFallback(
  event: Pick<
    TeammateApprovalRequestEvent,
    'teammateName' | 'toolName' | 'confirmationDetails'
  >,
  mode: ApprovalMode,
  host: TeammateApprovalHostCopy,
): TeammateApprovalFallbackDecision {
  const confirmationDetails = event.confirmationDetails;
  const requiresExplicitHostApproval =
    confirmationDetails !== undefined &&
    (confirmationDetails.type === 'ask_user_question' ||
      (confirmationDetails.type !== 'plan' &&
        'hideAlwaysAllow' in confirmationDetails &&
        confirmationDetails.hideAlwaysAllow === true));
  if (mode === ApprovalMode.YOLO && !requiresExplicitHostApproval) {
    return { action: 'proceed' };
  }
  const prefix = `Auto-cancelling tool ${event.toolName} requested by teammate "${event.teammateName}":`;
  const reason = requiresExplicitHostApproval
    ? mode === ApprovalMode.YOLO
      ? `${prefix} this request requires an explicit interactive approval surface and cannot be bypassed by YOLO mode.`
      : `${prefix} this request requires an explicit interactive approval surface, which is unavailable in ${host.surface} with the current approval mode (${mode}). ${host.explicitApprovalHint}`
    : `${prefix} this session does not provide a teammate approval route in ${host.surface} with the current approval mode (${mode}). ${host.allowHint}`;
  return { action: 'cancel', reason };
}
