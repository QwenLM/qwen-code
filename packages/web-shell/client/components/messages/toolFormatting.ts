/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool formatting helpers moved to `@qwen-code/chat-panel`; re-exported so
 * existing web-shell imports keep resolving. (`formatTokenCount` stays internal
 * to the package — web-shell's token formatter lives in `utils/formatTokenCount`.)
 */
export {
  TOOL_DISPLAY_NAMES,
  formatToolDisplayName,
  localizeToolDisplayName,
  isAskUserQuestionToolName,
  truncateText,
  getToolDescription,
  extractText,
  getToolResultSummary,
  isShellToolName,
  toolContainsCallId,
  getTaskExecutionRecord,
  getAgentCancellationReason,
  getAgentDisplayStatus,
  getAgentType,
  getAgentDescription,
  getAgentCurrentToolHint,
} from '@qwen-code/chat-panel';
