/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionRequest } from '../adapters/types';
import { isAskUserQuestionToolName } from '../components/messages/toolFormatting';

/**
 * True when a pending permission is an AskUserQuestion prompt (it carries a
 * `questions` array, and either no tool name or the AskUserQuestion tool name)
 * rather than a normal tool-call approval. Shared by the single-session App and
 * the split-view ChatPane so the two never drift.
 */
export function isAskUserPermission(
  request: PermissionRequest | null,
): boolean {
  if (
    !request?.rawInput?.questions ||
    !Array.isArray(request.rawInput.questions)
  ) {
    return false;
  }
  if (!request.toolName) return true;
  return isAskUserQuestionToolName(request.toolName);
}
