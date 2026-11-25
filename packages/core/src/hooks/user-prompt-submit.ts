/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import {
  captureHookExecutionOwner,
  type HookExecutionOwner,
} from './hook-execution-context.js';
import { createHookOutput } from './types.js';

export interface UserPromptSubmitDecision {
  blockReason?: string;
  additionalContext?: string;
}

export async function runUserPromptSubmit(
  config: Config,
  prompt: string,
  submittedPrompt: string | undefined,
  signal?: AbortSignal,
  owner?: HookExecutionOwner,
): Promise<UserPromptSubmitDecision | undefined> {
  if (
    config.getDisableAllHooks?.() ||
    !config.hasHooksForEvent?.('UserPromptSubmit')
  ) {
    return undefined;
  }
  const messageBus = config.getMessageBus?.();
  if (!messageBus) return undefined;
  const response = await messageBus.request<
    HookExecutionRequest,
    HookExecutionResponse
  >(
    {
      type: MessageBusType.HOOK_EXECUTION_REQUEST,
      owner: owner ?? captureHookExecutionOwner(config),
      eventName: 'UserPromptSubmit',
      input: {
        prompt,
        ...(submittedPrompt !== undefined
          ? { submitted_prompt: submittedPrompt }
          : {}),
      },
      ...(signal ? { signal } : {}),
    },
    MessageBusType.HOOK_EXECUTION_RESPONSE,
  );
  const output = response.output
    ? createHookOutput('UserPromptSubmit', response.output)
    : undefined;
  if (output?.isBlockingDecision() || output?.shouldStopExecution()) {
    return { blockReason: output.getEffectiveReason() };
  }
  return { additionalContext: output?.getAdditionalContext() };
}
