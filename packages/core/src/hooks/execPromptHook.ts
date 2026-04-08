/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type {
  HookConfig,
  HookEventName,
  HookExecutionResult,
  PromptHookConfig,
} from './types.js';
import { PROMPT_HOOK_RESPONSE_SCHEMA } from './types.js';
import {
  substituteArguments,
  validatePromptHookResponse,
} from './hookHelpers.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('PROMPT_HOOK');

/**
 * System prompt for prompt hook evaluation.
 */
const PROMPT_HOOK_SYSTEM_PROMPT =
  `You are evaluating a hook in Qwen Code.\n\n` +
  `Your response must be a JSON object matching one of the following schemas:\n` +
  `1. If the condition is met, return: {"ok": true}\n` +
  `2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`;

/**
 * Default model for prompt hooks.
 * Priority: hook.model > config.getModel() > DEFAULT_PROMPT_HOOK_MODEL
 *
 * Note: If Config adds getFastModel() in the future, the priority should be:
 * hook.model > config.getFastModel() > config.getModel() > DEFAULT_PROMPT_HOOK_MODEL
 */
const DEFAULT_PROMPT_HOOK_MODEL = 'qwen-turbo';

/**
 * Runner for executing prompt hooks using LLM evaluation.
 */
export class PromptHookRunner {
  constructor(private readonly config: Config) {}

  /**
   * Execute a prompt hook by calling LLM with the hook's prompt template.
   *
   * @param hook - The prompt hook configuration
   * @param eventName - The hook event name
   * @param input - The hook input data (will be serialized as JSON)
   * @param signal - AbortSignal for cancellation
   * @returns HookExecutionResult with LLM evaluation result
   */
  async execute(
    hook: PromptHookConfig,
    eventName: HookEventName,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookId = hook.name || 'anonymous-prompt-hook';

    debugLogger.debug(
      `Executing prompt hook "${hookId}" for event "${eventName}"`,
    );

    try {
      // Check if already aborted
      if (signal.aborted) {
        return {
          hookConfig: hook,
          eventName,
          success: false,
          error: new Error(`Prompt hook cancelled (aborted): ${hookId}`),
          duration: 0,
        };
      }

      // 1. Serialize input as JSON for $ARGUMENTS replacement
      const jsonInput = JSON.stringify(input, null, 2);

      // 2. Substitute placeholders in prompt template
      const processedPrompt = substituteArguments(hook.prompt, jsonInput, true);

      debugLogger.debug(
        `Prompt hook "${hookId}" processed prompt: ${processedPrompt.slice(0, 200)}...`,
      );

      // 3. Build contents for LLM call
      const contents: Content[] = [
        {
          role: 'user',
          parts: [{ text: processedPrompt }],
        },
      ];

      // 4. Get model to use (prefer hook-specific model, then fast model, then default)
      const model = this.getModel(hook);

      // 5. Get LLM client and call generateJson
      const llmClient = this.config.getBaseLlmClient();

      const response = await llmClient.generateJson({
        model,
        contents,
        schema: PROMPT_HOOK_RESPONSE_SCHEMA,
        systemInstruction: PROMPT_HOOK_SYSTEM_PROMPT,
        abortSignal: signal,
        maxAttempts: 3,
      });

      // 6. Validate and parse response
      const parsed = validatePromptHookResponse(response);

      // 7. Build result
      const duration = Date.now() - startTime;
      const decision = parsed.ok ? 'allow' : 'deny';

      debugLogger.debug(
        `Prompt hook "${hookId}" completed in ${duration}ms with decision: ${decision}`,
      );

      return {
        hookConfig: hook,
        eventName,
        success: parsed.ok,
        duration,
        exitCode: parsed.ok ? 0 : 2, // 0 = success, 2 = blocking error
        output: {
          decision,
          reason: parsed.reason,
          hookSpecificOutput: {
            hookEventName: eventName,
            ok: parsed.ok,
            reason: parsed.reason,
          },
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      debugLogger.warn(
        `Prompt hook "${hookId}" failed with error: ${errorMessage}`,
      );

      // Determine if this is a blocking error
      // Timeout and API errors are blocking (treat as deny for safety)
      const isBlocking =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('Timeout') ||
          errorMessage.includes('API'));

      return {
        hookConfig: hook,
        eventName,
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
        duration,
        exitCode: isBlocking ? 2 : 1, // 2 = blocking, 1 = non-blocking
        output: {
          decision: isBlocking ? 'deny' : 'allow',
          reason: errorMessage,
          hookSpecificOutput: {
            hookEventName: eventName,
            ok: false,
            reason: errorMessage,
            error: true,
          },
        },
      };
    }
  }

  /**
   * Get the model to use for this prompt hook.
   * Priority: hook.model > config.getModel() > DEFAULT_PROMPT_HOOK_MODEL
   *
   * Note: If Config adds getFastModel() in the future, it should be inserted
   * between hook.model and config.getModel() in the priority chain.
   */
  private getModel(hook: PromptHookConfig): string {
    // 1. Use hook-specific model if provided
    if (hook.model) {
      return hook.model;
    }

    // 2. Fall back to main model
    const mainModel = this.config.getModel();
    if (mainModel) {
      return mainModel;
    }

    // 3. Ultimate fallback
    return DEFAULT_PROMPT_HOOK_MODEL;
  }
}

/**
 * Type guard to check if a hook config is a prompt hook.
 */
export function isPromptHookConfig(
  hook: HookConfig | Record<string, unknown>,
): hook is PromptHookConfig {
  return hook.type === 'prompt';
}
