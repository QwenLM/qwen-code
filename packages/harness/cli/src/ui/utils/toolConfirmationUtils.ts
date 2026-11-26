/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ASK_USER_TOOL_NAME,
  ASK_USER_DISPLAY_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { ToolCallStatus } from '../types.js';

/** Completed display statuses for which AskUser results should be fully shown. */
const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  ToolCallStatus.Success,
  ToolCallStatus.Error,
  ToolCallStatus.Canceled,
]);

/**
 * Returns true for tool types that render their own dialog chrome
 * (AskUserQuestion, ExitPlanMode) instead of using the standard
 * RadioButtonSelect confirmation UI.
 */
export function isOwnUITool(type: string): boolean {
  return type === ASK_USER_TOOL_NAME || type === EXIT_PLAN_MODE_TOOL_NAME;
}

/**
 * Returns the dialog title for a tool confirmation prompt.
 */
export function getConfirmationTitle(
  details: SerializableConfirmationDetails | undefined,
): string {
  if (details?.type === ASK_USER_TOOL_NAME) return 'Answer Questions';
  if (details?.type === EXIT_PLAN_MODE_TOOL_NAME)
    return 'Ready to start implementation?';
  if (details?.type === 'workflow') return 'Run a dynamic workflow?';
  return 'Permission Required';
}

/**
 * Returns true if the tool name and status correspond to a completed
 * AskUser tool call. Used to suppress the header description because the
 * result display already contains the question and answer content.
 */
export function isCompletedAskUserTool(name: string, status: string): boolean {
  return name === ASK_USER_DISPLAY_NAME && COMPLETED_STATUSES.has(status);
}
