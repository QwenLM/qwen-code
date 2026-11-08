/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import {
  projectToolResultHistory,
  settleToolResultHistory,
} from '@qwen-code/qwen-code-core/services/tool-result-history.js';
import type { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

const debugLogger = createDebugLogger('TOOL_RESULT_HISTORY');

export const UNSENT_TOOL_RESULT =
  'The tool had already completed; its output was discarded.';

export function hasToolResultPromptHook(config: Config): boolean {
  return (
    !config.getDisableAllHooks?.() &&
    Boolean(config.getMessageBus?.()) &&
    config.hasHooksForEvent?.('UserPromptSubmit') === true
  );
}

/** Keeps the terminal outcome when the completed batch cannot be admitted. */
export async function settleTerminalToolResultHistory(
  recorder: Pick<ChatRecordingService, 'recordToolResultAdmission'> | undefined,
  message: Content,
  toolOutput: readonly Part[],
  withheldReason?: string,
  onRejected?: () => Content,
): Promise<Content> {
  try {
    return await settleToolResultHistory(
      recorder,
      message,
      toolOutput,
      withheldReason,
    );
  } catch (error) {
    if (!toolOutput.some((part) => part.functionResponse)) throw error;
    debugLogger.warn('Failed to settle terminal tool results', error);
    return projectToolResultHistory(
      onRejected?.() ?? message,
      toolOutput,
      [],
      withheldReason ?? UNSENT_TOOL_RESULT,
    );
  }
}
