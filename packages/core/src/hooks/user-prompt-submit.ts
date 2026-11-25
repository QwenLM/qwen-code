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
  requireVerdict?: true,
): Promise<UserPromptSubmitDecision | undefined> {
  if (
    config.getDisableAllHooks?.() ||
    !config.hasHooksForEvent?.('UserPromptSubmit')
  ) {
    return undefined;
  }
  const messageBus = config.getMessageBus?.();
  if (!messageBus) {
    if (requireVerdict)
      throw new Error('UserPromptSubmit hook bus unavailable');
    return undefined;
  }
  const hookController = requireVerdict ? new AbortController() : undefined;
  const hookSignal = hookController
    ? signal
      ? AbortSignal.any([signal, hookController.signal])
      : hookController.signal
    : signal;
  const request: Omit<HookExecutionRequest, 'correlationId'> = {
    type: MessageBusType.HOOK_EXECUTION_REQUEST,
    owner: owner ?? captureHookExecutionOwner(config),
    eventName: 'UserPromptSubmit',
    input: {
      prompt,
      ...(submittedPrompt !== undefined
        ? { submitted_prompt: submittedPrompt }
        : {}),
    },
    ...(hookSignal ? { signal: hookSignal } : {}),
    ...(requireVerdict ? { requirePromptVerdict: true } : {}),
  };
  const response = requireVerdict
    ? await messageBus
        .request<
          HookExecutionRequest,
          HookExecutionResponse
        >(request, MessageBusType.HOOK_EXECUTION_RESPONSE, undefined, hookSignal)
        .catch((error: unknown) => {
          hookController?.abort(error);
          throw error;
        })
    : await messageBus.request<HookExecutionRequest, HookExecutionResponse>(
        request,
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
  if (requireVerdict && response.success !== true) {
    const error =
      response.error ?? new Error('UserPromptSubmit hook execution failed');
    hookController?.abort(error);
    throw error;
  }
  const output = response.output
    ? createHookOutput('UserPromptSubmit', response.output)
    : undefined;
  if (output?.isBlockingDecision() || output?.shouldStopExecution()) {
    return { blockReason: output.getEffectiveReason() };
  }
  return { additionalContext: output?.getAdditionalContext() };
}
