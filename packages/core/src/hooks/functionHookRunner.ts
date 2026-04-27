/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  FunctionHookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookEventName,
  FunctionHookContext,
  HookExecutionOutcome,
} from './types.js';

const debugLogger = createDebugLogger('FUNCTION_HOOK_RUNNER');

/**
 * Default timeout for function hook execution (5 seconds)
 * Function hooks are intended for quick validation checks
 */
const DEFAULT_FUNCTION_TIMEOUT = 5000;

/**
 * Function Hook Runner - executes function hooks (callbacks)
 * Used primarily for Session Hooks registered via SDK
 */
export class FunctionHookRunner {
  /**
   * Execute a function hook
   * @param hookConfig Function hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param context Optional context (messages, toolUseID, signal)
   */
  async execute(
    hookConfig: FunctionHookConfig,
    eventName: HookEventName,
    input: HookInput,
    context?: FunctionHookContext,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookId = hookConfig.id || hookConfig.name || 'anonymous-function';
    const signal = context?.signal;

    // Check if already aborted
    if (signal?.aborted) {
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'cancelled',
        error: new Error(
          `Function hook execution cancelled (aborted): ${hookId}`,
        ),
        duration: 0,
      };
    }

    try {
      const timeout = hookConfig.timeout ?? DEFAULT_FUNCTION_TIMEOUT;

      // Execute callback with timeout and context
      const result = await this.executeWithTimeout(
        hookConfig.callback,
        input,
        context,
        timeout,
        signal,
      );

      const duration = Date.now() - startTime;

      debugLogger.debug(
        `Function hook ${hookId} completed successfully in ${duration}ms`,
      );

      // Process the callback result
      const executionResult = this.processHookResult(
        hookConfig,
        eventName,
        result,
        duration,
      );

      // Invoke success callback if provided
      if (executionResult.success && hookConfig.onHookSuccess) {
        try {
          hookConfig.onHookSuccess(executionResult);
        } catch (error) {
          debugLogger.warn(
            `onHookSuccess callback failed for ${hookId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return executionResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      debugLogger.warn(`Function hook ${hookId} failed: ${errorMessage}`);

      // Use configured error message if available
      const displayError = hookConfig.errorMessage
        ? new Error(`${hookConfig.errorMessage}: ${errorMessage}`)
        : error instanceof Error
          ? error
          : new Error(errorMessage);

      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'non_blocking_error',
        error: displayError,
        duration,
      };
    }
  }

  /**
   * Process hook result and convert to execution result
   */
  private processHookResult(
    hookConfig: FunctionHookConfig,
    eventName: HookEventName,
    result: HookOutput | boolean | undefined,
    duration: number,
  ): HookExecutionResult {
    // Boolean semantics: true=success, false=blocking
    if (typeof result === 'boolean') {
      if (result) {
        return {
          hookConfig,
          eventName,
          success: true,
          outcome: 'success',
          output: { continue: true },
          duration,
        };
      } else {
        return {
          hookConfig,
          eventName,
          success: false,
          outcome: 'blocking',
          output: {
            continue: false,
            stopReason: hookConfig.errorMessage || 'Blocked by function hook',
            decision: 'block',
            reason: hookConfig.errorMessage || 'Blocked by function hook',
          },
          duration,
        };
      }
    }

    // HookOutput semantics (advanced)
    const output = result || { continue: true };
    const outcome: HookExecutionOutcome = this.determineOutcome(output);

    return {
      hookConfig,
      eventName,
      success: outcome === 'success',
      outcome,
      output,
      duration,
    };
  }

  /**
   * Determine outcome from HookOutput
   */
  private determineOutcome(output: HookOutput): HookExecutionOutcome {
    if (output.decision === 'block' || output.decision === 'deny') {
      return 'blocking';
    }
    if (output.continue === false) {
      return 'blocking';
    }
    return 'success';
  }

  /**
   * Execute callback with timeout support using Promise.race for proper race condition handling
   */
  private async executeWithTimeout(
    callback: FunctionHookConfig['callback'],
    input: HookInput,
    context: FunctionHookContext | undefined,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<HookOutput | boolean | undefined> {
    // Validate callback
    if (typeof callback !== 'function') {
      throw new Error('Invalid callback: expected a function');
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    // Cleanup function to ensure all resources are released
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Function hook timed out after ${timeout}ms`));
        }, timeout);
      });

      // Create abort promise
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(new Error('Function hook execution aborted'));
            return;
          }
          abortHandler = () => {
            reject(new Error('Function hook execution aborted'));
          };
          signal.addEventListener('abort', abortHandler);
        }
      });

      // Race between callback execution, timeout, and abort
      const promises: Array<Promise<HookOutput | boolean | undefined | never>> =
        [callback(input, context), timeoutPromise];

      if (signal) {
        promises.push(abortPromise);
      }

      const result = await Promise.race(promises);
      cleanup();
      return result;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
