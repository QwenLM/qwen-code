/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHookOutput, HookEventName } from './types.js';
import type {
  HookInput,
  HookOutput,
  PreToolUseInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from './types.js';

/**
 * Apply hook output to modify input for the next hook in sequential execution
 */
export function applyHookOutputToInput(
  originalInput: HookInput,
  hookOutput: HookOutput,
  eventName: HookEventName,
): HookInput {
  // Create a copy of the original input
  const modifiedInput = { ...originalInput };

  // Apply modifications based on hook output and event type
  if (hookOutput.hookSpecificOutput) {
    switch (eventName) {
      case HookEventName.UserPromptSubmit:
        {
          const additionalContext =
            hookOutput.hookSpecificOutput['additionalContext'];
          if (
            typeof additionalContext === 'string' &&
            additionalContext &&
            'prompt' in modifiedInput
          ) {
            (modifiedInput as UserPromptSubmitInput).prompt +=
              '\n\n' + additionalContext;
          }
        }
        break;

      case HookEventName.UserPromptExpansion:
        {
          const additionalContext = createHookOutput(
            eventName,
            hookOutput,
          ).getAdditionalContext();
          if (additionalContext && 'prompt' in modifiedInput) {
            (modifiedInput as UserPromptExpansionInput).prompt +=
              '\n\n' + additionalContext;
          }
        }
        break;

      case HookEventName.PreToolUse:
        if ('tool_input' in hookOutput.hookSpecificOutput) {
          const newToolInput = hookOutput.hookSpecificOutput[
            'tool_input'
          ] as Record<string, unknown>;
          if (newToolInput && 'tool_input' in modifiedInput) {
            (modifiedInput as PreToolUseInput).tool_input = {
              ...(modifiedInput as PreToolUseInput).tool_input,
              ...newToolInput,
            };
          }
        }
        break;

      default:
        // For other events, no special input modification is needed
        break;
    }
  }

  return modifiedInput;
}
