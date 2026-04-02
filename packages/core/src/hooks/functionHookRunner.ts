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
   * Execute callback with timeout support
   */
  private async executeWithTimeout(
    callback: FunctionHookConfig['callback'],
    input: HookInput,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<HookOutput | undefined> {
    return new Promise((resolve, reject) => {
      let aborted = false;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        aborted = true;
        reject(new Error(`Function hook timed out after ${timeout}ms`));
      }, timeout);

      // Set up abort handler
      const abortHandler = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        aborted = true;
        reject(new Error('Function hook execution aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler);
      }

      // Execute callback
      callback(input)
        .then((result) => {
          if (!aborted) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (signal) {
              signal.removeEventListener('abort', abortHandler);
            }
            resolve(result);
          }
        })
        .catch((error) => {
          if (!aborted) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (signal) {
              signal.removeEventListener('abort', abortHandler);
            }
            reject(error);
          }
        });
    });
  }
}
