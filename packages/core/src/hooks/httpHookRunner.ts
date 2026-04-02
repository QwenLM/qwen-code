/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { interpolateHeaders, interpolateUrl } from './envInterpolator.js';
import { UrlValidator } from './urlValidator.js';
import type {
  HttpHookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookEventName,
} from './types.js';

const debugLogger = createDebugLogger('HTTP_HOOK_RUNNER');

/**
 * Default timeout for HTTP hook execution (30 seconds)
 */
const DEFAULT_HTTP_TIMEOUT = 30000;

/**
 * HTTP Hook Runner - executes HTTP hooks by sending POST requests
 */
export class HttpHookRunner {
  private urlValidator: UrlValidator;
  private readonly executedOnceHooks: Set<string> = new Set();

  constructor(allowedUrls?: string[]) {
    this.urlValidator = new UrlValidator(allowedUrls);
  }

  /**
   * Execute an HTTP hook
   * @param hookConfig HTTP hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param signal Optional AbortSignal to cancel hook execution
   */
  async execute(
    hookConfig: HttpHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookId = hookConfig.name || hookConfig.url;

    // Check if already aborted
    if (signal?.aborted) {
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(`HTTP hook execution cancelled (aborted): ${hookId}`),
        duration: 0,
      };
    }

    // Check once flag
    if (hookConfig.once) {
      const onceKey = `${hookConfig.url}:${eventName}`;
      if (this.executedOnceHooks.has(onceKey)) {
        debugLogger.debug(
          `Skipping once hook ${hookId} - already executed for ${eventName}`,
        );
        return {
          hookConfig,
          eventName,
          success: true,
          duration: 0,
          output: { continue: true },
        };
      }
      this.executedOnceHooks.add(onceKey);
    }

    try {
      // Interpolate URL with allowed env vars
      const url = interpolateUrl(
        hookConfig.url,
        hookConfig.allowedEnvVars || [],
      );

      // Validate URL
      const validation = this.urlValidator.validate(url);
      if (!validation.allowed) {
        return {
          hookConfig,
          eventName,
          success: false,
          error: new Error(`URL validation failed: ${validation.reason}`),
          duration: Date.now() - startTime,
        };
      }

      // Interpolate headers with allowed env vars
      const headers = hookConfig.headers
        ? interpolateHeaders(
            hookConfig.headers,
            hookConfig.allowedEnvVars || [],
          )
        : {};

      // Prepare request body
      const body = JSON.stringify({
        ...input,
        hook_event_name: eventName,
      });

      // Set up timeout
      const timeout = hookConfig.timeout ?? DEFAULT_HTTP_TIMEOUT;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Combine with external signal
      if (signal) {
        signal.addEventListener('abort', () => controller.abort());
      }

      try {
        debugLogger.debug(`Executing HTTP hook: ${hookId} -> ${url}`);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const duration = Date.now() - startTime;

        if (!response.ok) {
          debugLogger.warn(
            `HTTP hook ${hookId} returned status ${response.status}`,
          );
          return {
            hookConfig,
            eventName,
            success: false,
            error: new Error(
              `HTTP hook returned status ${response.status}: ${response.statusText}`,
            ),
            duration,
          };
        }

        // Parse response
        const output = await this.parseResponse(response, eventName);

        debugLogger.debug(
          `HTTP hook ${hookId} completed successfully in ${duration}ms`,
        );

        return {
          hookConfig,
          eventName,
          success: true,
          output,
          duration,
        };
      } catch (fetchError) {
        clearTimeout(timeoutId);

        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          return {
            hookConfig,
            eventName,
            success: false,
            error: new Error(
              `HTTP hook ${hookId} timed out after ${timeout}ms`,
            ),
            duration: Date.now() - startTime,
          };
        }

        throw fetchError;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      debugLogger.warn(`HTTP hook ${hookId} failed: ${errorMessage}`);

      return {
        hookConfig,
        eventName,
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
        duration,
      };
    }
  }

  /**
   * Parse HTTP response into HookOutput
   */
  private async parseResponse(
    response: Response,
    eventName: HookEventName,
  ): Promise<HookOutput> {
    const contentType = response.headers.get('content-type') || '';

    // Try to parse as JSON
    if (contentType.includes('application/json')) {
      try {
        const json = await response.json();
        return this.normalizeOutput(json, eventName);
      } catch {
        debugLogger.warn('Failed to parse JSON response, using empty output');
        return { continue: true };
      }
    }

    // For non-JSON responses, return success with continue
    return { continue: true };
  }

  /**
   * Normalize response JSON into HookOutput format
   */
  private normalizeOutput(
    json: Record<string, unknown>,
    eventName: HookEventName,
  ): HookOutput {
    const output: HookOutput = {};

    // Map standard fields
    if ('continue' in json && typeof json['continue'] === 'boolean') {
      output.continue = json['continue'];
    }
    if ('stopReason' in json && typeof json['stopReason'] === 'string') {
      output.stopReason = json['stopReason'];
    }
    if (
      'suppressOutput' in json &&
      typeof json['suppressOutput'] === 'boolean'
    ) {
      output.suppressOutput = json['suppressOutput'];
    }
    if ('systemMessage' in json && typeof json['systemMessage'] === 'string') {
      output.systemMessage = json['systemMessage'];
    }
    if ('decision' in json && typeof json['decision'] === 'string') {
      output.decision = json['decision'] as HookOutput['decision'];
    }
    if ('reason' in json && typeof json['reason'] === 'string') {
      output.reason = json['reason'];
    }

    // Handle hookSpecificOutput
    if (
      'hookSpecificOutput' in json &&
      typeof json['hookSpecificOutput'] === 'object' &&
      json['hookSpecificOutput'] !== null
    ) {
      output.hookSpecificOutput = json['hookSpecificOutput'] as Record<
        string,
        unknown
      >;
      // Ensure hookEventName is set
      if (!('hookEventName' in output.hookSpecificOutput)) {
        output.hookSpecificOutput['hookEventName'] = eventName;
      }
    }

    return output;
  }

  /**
   * Reset once hooks tracking (useful for testing)
   */
  resetOnceHooks(): void {
    this.executedOnceHooks.clear();
  }

  /**
   * Update allowed URLs
   */
  updateAllowedUrls(allowedUrls: string[]): void {
    // Create new validator with updated patterns
    this.urlValidator = new UrlValidator(allowedUrls);
  }
}
