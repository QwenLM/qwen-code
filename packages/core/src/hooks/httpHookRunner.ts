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
 * Maximum output length (10,000 characters as per Claude Code spec)
 */
const MAX_OUTPUT_LENGTH = 10000;

/**
 * Callback for displaying status messages during hook execution
 */
export type StatusMessageCallback = (message: string) => void;

/**
 * HTTP Hook Runner - executes HTTP hooks by sending POST requests
 */
export class HttpHookRunner {
  private urlValidator: UrlValidator;
  private readonly executedOnceHooks: Set<string> = new Set();
  private statusMessageCallback?: StatusMessageCallback;

  constructor(allowedUrls?: string[]) {
    this.urlValidator = new UrlValidator(allowedUrls);
  }

  /**
   * Set callback for displaying status messages
   */
  setStatusMessageCallback(callback: StatusMessageCallback): void {
    this.statusMessageCallback = callback;
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

    // Display status message if configured
    if (hookConfig.statusMessage && this.statusMessageCallback) {
      this.statusMessageCallback(hookConfig.statusMessage);
    }

    try {
      // Interpolate URL with allowed env vars
      const url = interpolateUrl(
        hookConfig.url,
        hookConfig.allowedEnvVars || [],
      );

      // Validate URL with DNS rebinding protection
      const validation = await this.urlValidator.validateWithDnsCheck(url);
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

        // Per Claude Code spec: Non-2xx status is a non-blocking error
        // Execution continues, but we log a warning
        if (!response.ok) {
          debugLogger.warn(
            `HTTP hook ${hookId} returned non-2xx status ${response.status} (non-blocking)`,
          );
          // Return success: true with continue: true for non-blocking error
          return {
            hookConfig,
            eventName,
            success: true,
            output: { continue: true },
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

        const duration = Date.now() - startTime;

        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          // Timeout is a non-blocking error per Claude Code spec
          debugLogger.warn(
            `HTTP hook ${hookId} timed out after ${timeout}ms (non-blocking)`,
          );
          return {
            hookConfig,
            eventName,
            success: true,
            output: { continue: true },
            duration,
          };
        }

        // Connection failure is a non-blocking error per Claude Code spec
        debugLogger.warn(
          `HTTP hook ${hookId} connection failed (non-blocking): ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        );
        return {
          hookConfig,
          eventName,
          success: true,
          output: { continue: true },
          duration,
        };
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

    // For plain text responses, add as context (truncated if needed)
    const text = await response.text();
    if (text.trim()) {
      return {
        continue: true,
        systemMessage: this.truncateOutput(text.trim()),
      };
    }

    // For empty responses, return success with continue
    return { continue: true };
  }

  /**
   * Truncate output to MAX_OUTPUT_LENGTH characters
   * Per Claude Code spec: output is capped at 10,000 characters
   */
  private truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_LENGTH) {
      return output;
    }
    const truncated = output.substring(0, MAX_OUTPUT_LENGTH);
    debugLogger.debug(
      `Output truncated from ${output.length} to ${MAX_OUTPUT_LENGTH} characters`,
    );
    return `${truncated}\n... [truncated, ${output.length - MAX_OUTPUT_LENGTH} more characters]`;
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
      output.stopReason = this.truncateOutput(json['stopReason']);
    }
    if (
      'suppressOutput' in json &&
      typeof json['suppressOutput'] === 'boolean'
    ) {
      output.suppressOutput = json['suppressOutput'];
    }
    if ('systemMessage' in json && typeof json['systemMessage'] === 'string') {
      // Apply output length limit per Claude Code spec
      output.systemMessage = this.truncateOutput(json['systemMessage']);
    }
    if ('decision' in json && typeof json['decision'] === 'string') {
      output.decision = json['decision'] as HookOutput['decision'];
    }
    if ('reason' in json && typeof json['reason'] === 'string') {
      output.reason = this.truncateOutput(json['reason']);
    }

    // Handle hookSpecificOutput
    if (
      'hookSpecificOutput' in json &&
      typeof json['hookSpecificOutput'] === 'object' &&
      json['hookSpecificOutput'] !== null
    ) {
      const hookOutput = json['hookSpecificOutput'] as Record<string, unknown>;
      // Truncate additionalContext if present
      if (
        'additionalContext' in hookOutput &&
        typeof hookOutput['additionalContext'] === 'string'
      ) {
        hookOutput['additionalContext'] = this.truncateOutput(
          hookOutput['additionalContext'],
        );
      }
      output.hookSpecificOutput = hookOutput;
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
