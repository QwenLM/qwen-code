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
} from './types.js';

const debugLogger = createDebugLogger('FUNCTION_HOOK_RUNNER');

/**
 * Default timeout for function hook execution (60 seconds)
 */
const DEFAULT_FUNCTION_TIMEOUT = 60000;

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
   * @param signal Optional AbortSignal to cancel hook execution
   */
  async execute(
    hookConfig: FunctionHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookId = hookConfig.id || hookConfig.name || 'anonymous-function';

    // Check if already aborted
    if (signal?.aborted) {
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(
          `Function hook execution cancelled (aborted): ${hookId}`,
        ),
        duration: 0,
      };
    }

    try {
      const timeout = hookConfig.timeout ?? DEFAULT_FUNCTION_TIMEOUT;

      // Execute callback with timeout
      const output = await this.executeWithTimeout(
        hookConfig.callback,
        input,
        timeout,
        signal,
      );

      const duration = Date.now() - startTime;

      debugLogger.debug(
        `Function hook ${hookId} completed successfully in ${duration}ms`,
      );

      return {
        hookConfig,
        eventName,
        success: true,
        output: output || { continue: true },
        duration,
      };
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
        error: displayError,
        duration,
      };
    }
  }

  /**
   * Execute callback with timeout support using Promise.race for proper race condition handling
   */
  private async executeWithTimeout(
    callback: FunctionHookConfig['callback'],
    input: HookInput,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<HookOutput | undefined> {
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
      const promises: Array<Promise<HookOutput | undefined | never>> = [
        callback(input),
        timeoutPromise,
      ];

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
