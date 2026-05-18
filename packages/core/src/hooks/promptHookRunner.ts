/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  PromptHookConfig,
  LLMHookResponse,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookEventName,
} from './types.js';
import type { Config } from '../config/config.js';
import type { Content, GenerateContentResponse } from '@google/genai';

const debugLogger = createDebugLogger('PROMPT_HOOK_RUNNER');

/**
 * System prompt for LLM hook evaluation
 */
const LLM_HOOK_SYSTEM_PROMPT = `You are evaluating a hook in Qwen Code.
Your task is to analyze the provided context and make a decision.

You MUST respond with valid JSON in one of these formats:
- {"ok": true} - Allow the operation to proceed
- {"ok": true, "additionalContext": "..."} - Allow and provide context
- {"ok": false, "reason": "..."} - Block the operation with a reason
- {"ok": false, "reason": "...", "additionalContext": "..."} - Block with reason and context

The "reason" field is required when blocking and will be shown to the user.
The "additionalContext" field is optional and can provide useful information to the main conversation.

Do NOT output anything other than the JSON response. No explanations, no markdown formatting.`;

/**
 * Zod schema for validating LLM hook response
 */
const LLMHookResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  additionalContext: z.string().optional(),
});

/**
 * Prompt Hook Runner - executes prompt hooks using LLM evaluation
 */
export class PromptHookRunner {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Execute a prompt hook
   * @param hookConfig Prompt hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param signal Optional AbortSignal for cancellation
   */
  async execute(
    hookConfig: PromptHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookName = hookConfig.name || 'prompt-hook';

    // Check if already aborted
    if (signal?.aborted) {
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'cancelled',
        error: new Error(
          `Prompt hook execution cancelled (aborted): ${hookName}`,
        ),
        duration: 0,
      };
    }

    const timeoutMs = (hookConfig.timeout ?? 30) * 1000;

    try {
      debugLogger.debug(`Executing prompt hook: ${hookName}`);

      // Prepare input JSON
      const jsonInput = JSON.stringify(input, null, 2);

      // Replace $ARGUMENTS placeholder with JSON input
      const processedPrompt = this.replaceArgumentsPlaceholder(
        hookConfig.prompt,
        jsonInput,
      );
      debugLogger.debug(`Prompt hook full prompt:\n${processedPrompt}`);

      // Get model to use (user's current model)
      const model = hookConfig.model ?? this.getModel();
      debugLogger.debug(`Prompt hook using model: ${model}`);

      // Execute with timeout
      const result = await this.executeWithTimeout(
        processedPrompt,
        model,
        timeoutMs,
        signal,
      );

      const duration = Date.now() - startTime;
      debugLogger.debug(
        `Prompt hook ${hookName} completed in ${duration}ms with result: ${result.ok}`,
      );

      // Process result
      debugLogger.debug(
        `Prompt hook result: ok=${result.ok}, reason=${result.reason}`,
      );
      return this.processResult(hookConfig, eventName, result, duration);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check for timeout/abort errors
      if (
        errorMessage.includes('timed out') ||
        errorMessage.includes('aborted')
      ) {
        debugLogger.warn(`Prompt hook ${hookName} cancelled: ${errorMessage}`);
        return {
          hookConfig,
          eventName,
          success: false,
          outcome: 'cancelled',
          error: error instanceof Error ? error : new Error(errorMessage),
          duration,
        };
      }

      // Non-blocking error: Prompt hook failure should not block operations
      debugLogger.warn(
        `Prompt hook ${hookName} failed (non-blocking): ${errorMessage}`,
      );

      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'non_blocking_error',
        error: error instanceof Error ? error : new Error(errorMessage),
        duration,
        output: { continue: true }, // Non-blocking, allow continuation
      };
    }
  }

  /**
   * Get model to use for prompt hook evaluation
   * Priority: 1. User configured model in hook, 2. Main model from config
   * Uses the user's current model by default to ensure API compatibility
   */
  private getModel(): string {
    // Use user's current model (most reliable - user is already authenticated with this model)
    const mainModel = this.config.getModel();
    debugLogger.debug(`getModel() returned: ${mainModel}`);
    return mainModel;
  }

  /**
   * Replace $ARGUMENTS placeholder in prompt with JSON input
   */
  private replaceArgumentsPlaceholder(
    prompt: string,
    jsonInput: string,
  ): string {
    return prompt.replace(/\$ARGUMENTS/g, () => jsonInput);
  }

  /**
   * Check whether the current prompt hook model should be treated as a
   * reasoning model for request-shaping compatibility.
   */
  private isReasoningModel(model: string): boolean {
    const reasoningConfig = this.config.getContentGeneratorConfig().reasoning;
    if (reasoningConfig !== undefined && reasoningConfig !== false) {
      return true;
    }

    const normalizedModel = model.toLowerCase();
    return (
      normalizedModel.startsWith('o1') ||
      normalizedModel.startsWith('o3') ||
      normalizedModel.includes('reasoner')
    );
  }

  /**
   * Execute LLM query with timeout support
   */
  private async executeWithTimeout(
    prompt: string,
    model: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LLMHookResponse> {
    const generator = this.config.getContentGenerator();
    if (!generator) {
      const error = new Error(
        'ContentGenerator not available - make sure you are authenticated',
      );
      debugLogger.error(
        'Prompt hook failed: ContentGenerator not available',
        error,
      );
      throw error;
    }

    // Build contents array
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ];

    // Create internal AbortController to abort the request on timeout
    const internalAbortController = new AbortController();
    const internalSignal = internalAbortController.signal;

    // Chain external signal to internal abort controller
    if (signal) {
      if (signal.aborted) {
        internalAbortController.abort();
      } else {
        signal.addEventListener('abort', () => {
          internalAbortController.abort();
        });
      }
    }

    // Create timeout promise that also aborts the request
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        internalAbortController.abort();
        reject(new Error(`Prompt hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const isReasoningModel = this.isReasoningModel(model);
      const requestConfig = {
        abortSignal: internalSignal,
        systemInstruction: {
          parts: [{ text: LLM_HOOK_SYSTEM_PROMPT }],
        },
        ...(isReasoningModel
          ? {}
          : {
              // Deterministic allow/block decisions — same input must
              // produce the same gating outcome to keep security checks
              // reliable.
              temperature: 0,
            }),
        // Responses are tiny JSON objects; cap output to avoid
        // runaway generations on misbehaving models.
        maxOutputTokens: 500,
        // Explicitly disable inherited reasoning so providers do not spend
        // output budget on hidden thoughts for hook evaluation.
        reasoning: false,
        // Thoughts are filtered out post-hoc anyway; skip generating
        // them so we don't pay for reasoning tokens we discard.
        thinkingConfig: { includeThoughts: false },
      };

      // Race between LLM call and timeout
      const response = await Promise.race([
        generator.generateContent(
          {
            model,
            contents,
            config: requestConfig,
          },
          'prompt_hook',
        ),
        timeoutPromise,
      ]);

      const finishReason = (response as GenerateContentResponse).candidates?.[0]
        ?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        debugLogger.warn(
          'LLM response truncated at maxOutputTokens — treating as unreliable',
        );
        throw new Error('Response truncated due to token limit');
      }

      // Extract text from response
      const text = (
        response as GenerateContentResponse
      ).candidates?.[0]?.content?.parts
        ?.filter((p) => !(p as Record<string, unknown>)['thought'])
        .map((p) => p.text ?? '')
        .join('')
        .trim();

      if (!text) {
        throw new Error('Empty response from LLM');
      }

      // Parse response
      return this.parseResponse(text);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Parse LLM response text into structured LLMHookResponse
   */
  private parseResponse(text: string): LLMHookResponse {
    // Try to extract JSON (handle markdown code blocks)
    let jsonStr = text.trim();

    // Remove possible markdown code block wrapper
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(jsonStr);
      const validated = LLMHookResponseSchema.safeParse(parsed);

      if (!validated.success) {
        debugLogger.warn(
          `LLM response validation failed: ${validated.error.message}`,
        );
        // Validation failed, default to allow (fail-open)
        return {
          ok: true,
          reason: 'Response validation failed, defaulting to allow',
        };
      }

      return validated.data;
    } catch {
      debugLogger.warn(`Failed to parse LLM response as JSON: ${text}`);
      // Parse failed, default to allow (fail-open)
      return {
        ok: true,
        reason: 'Failed to parse LLM response, defaulting to allow',
      };
    }
  }

  /**
   * Process LLM response into HookExecutionResult
   */
  private processResult(
    hookConfig: PromptHookConfig,
    eventName: HookEventName,
    response: LLMHookResponse,
    duration: number,
  ): HookExecutionResult {
    const hookName = hookConfig.name || 'prompt-hook';

    if (!response.ok) {
      // Blocking decision
      const reason = response.reason || 'Blocked by prompt hook';
      debugLogger.info(`Prompt hook ${hookName} blocked: ${reason}`);

      const output: HookOutput = {
        continue: false,
        stopReason: reason,
        decision: 'block',
        reason,
        hookSpecificOutput: response.additionalContext
          ? { additionalContext: response.additionalContext }
          : undefined,
      };

      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'blocking',
        output,
        duration,
      };
    }

    // Success - allow operation
    const output: HookOutput = {
      continue: true,
      decision: 'allow',
      reason: response.reason,
      hookSpecificOutput: response.additionalContext
        ? { additionalContext: response.additionalContext }
        : undefined,
    };

    return {
      hookConfig,
      eventName,
      success: true,
      outcome: 'success',
      output,
      duration,
    };
  }
}

/**
 * Factory function to create PromptHookRunner
 */
export function createPromptHookRunner(config: Config): PromptHookRunner {
  return new PromptHookRunner(config);
}
