/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import { createHookOutput, type DefaultHookOutput } from '../hooks/types.js';
import { partToString } from '../utils/partUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_TRIGGERS');

/**
 * Fires the UserPromptSubmit hook and returns the hook output.
 * This should be called before processing a user prompt.
 *
 * The caller can use the returned DefaultHookOutput methods:
 * - isBlockingDecision() / shouldStopExecution() to check if blocked
 * - getEffectiveReason() to get the blocking reason
 * - getAdditionalContext() to get additional context to add
 *
 * @param messageBus The message bus to use for hook communication
 * @param request The user's request (prompt)
 * @returns The hook output, or undefined if no hook was executed or on error
 */
export async function fireUserPromptSubmitHook(
  messageBus: MessageBus,
  request: PartListUnion,
): Promise<DefaultHookOutput | undefined> {
  try {
    const promptText = partToString(request);

    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'UserPromptSubmit',
        input: {
          prompt: promptText,
        },
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    return response.output
      ? createHookOutput('UserPromptSubmit', response.output)
      : undefined;
  } catch (error) {
    debugLogger.warn(`UserPromptSubmit hook failed: ${error}`);
    return undefined;
  }
}

/**
 * Fires the Stop hook and returns the hook output.
 * This should be called after the agent has generated a response.
 *
 * The caller can use the returned DefaultHookOutput methods:
 * - isBlockingDecision() / shouldStopExecution() to check if continuation is requested
 * - getEffectiveReason() to get the continuation reason
 *
 * @param messageBus The message bus to use for hook communication
 * @param request The original user's request (prompt)
 * @param responseText The agent's response text
 * @returns The hook output, or undefined if no hook was executed or on error
 */
export async function fireStopHook(
  messageBus: MessageBus,
  request: PartListUnion,
  responseText: string,
): Promise<DefaultHookOutput | undefined> {
  try {
    const promptText = partToString(request);

    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'Stop',
        input: {
          prompt: promptText,
          prompt_response: responseText,
          stop_hook_active: false,
        },
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    return response.output
      ? createHookOutput('Stop', response.output)
      : undefined;
  } catch (error) {
    debugLogger.warn(`Stop hook failed: ${error}`);
    return undefined;
  }
}
