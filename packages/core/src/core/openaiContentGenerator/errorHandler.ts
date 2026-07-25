/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  getErrorMessage,
  getErrorStatus,
  getErrorType,
} from '../../utils/errors.js';
import { getRateLimitErrorDetails } from '../../utils/rateLimit.js';
import { redactProxyError } from '../../utils/runtimeFetchOptions.js';
import type { ErrorHandler, RequestContext } from './types.js';

const debugLogger = createDebugLogger('OPENAI_ERROR');
export type { ErrorHandler } from './types.js';

interface ApiErrorDiagnostics {
  model: string;
  durationMs: number;
  errorType: string;
  statusCode?: number;
  providerCode?: string;
  providerMessage?: string;
  requestId?: string;
  transport?: 'http' | 'sse' | 'unknown';
}

export class EnhancedErrorHandler implements ErrorHandler {
  constructor(
    private shouldSuppressLogging: (
      error: unknown,
      request: GenerateContentParameters,
    ) => boolean = () => false,
  ) {}

  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never {
    const redactedError = redactProxyError(error);
    const isTimeoutError = this.isTimeoutError(redactedError);
    const errorMessage = this.buildErrorMessage(
      redactedError,
      context,
      isTimeoutError,
    );

    // Allow subclasses to suppress error logging for specific scenarios
    if (!this.shouldSuppressErrorLogging(redactedError, request)) {
      debugLogger.error(
        'OpenAI API Error:',
        errorMessage,
        this.buildDiagnostics(redactedError, context),
      );
    }

    // Provide helpful timeout-specific error message
    if (isTimeoutError) {
      throw new Error(
        `${errorMessage}\n\n${this.getTimeoutTroubleshootingTips()}`,
      );
    }

    throw redactedError;
  }

  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean {
    return this.shouldSuppressLogging(error, request);
  }

  private isTimeoutError(error: unknown): boolean {
    if (!error) return false;

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorCode = (error as any)?.code;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorType = (error as any)?.type;

    // Check for common timeout indicators
    return (
      errorMessage.includes('timeout') ||
      errorMessage.includes('timed out') ||
      errorMessage.includes('connection timeout') ||
      errorMessage.includes('request timeout') ||
      errorMessage.includes('read timeout') ||
      errorMessage.includes('etimedout') ||
      errorMessage.includes('esockettimedout') ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ESOCKETTIMEDOUT' ||
      errorType === 'timeout' ||
      errorMessage.includes('request timed out') ||
      errorMessage.includes('deadline exceeded')
    );
  }

  private buildErrorMessage(
    error: unknown,
    context: RequestContext,
    isTimeoutError: boolean,
  ): string {
    const durationSeconds = Math.round((Date.now() - context.startTime) / 1000);

    if (isTimeoutError) {
      return `Request timeout after ${durationSeconds}s. Try reducing input length or increasing timeout in config.`;
    }

    return error instanceof Error ? getErrorMessage(error) : String(error);
  }

  private buildDiagnostics(
    error: unknown,
    context: RequestContext,
  ): ApiErrorDiagnostics {
    const details = getRateLimitErrorDetails(error);
    const requestId = this.getRequestId(error) ?? details.requestId;
    const statusCode = getErrorStatus(error);
    return {
      model: context.model,
      durationMs: Date.now() - context.startTime,
      errorType: getErrorType(error),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(details.providerCode !== undefined
        ? { providerCode: details.providerCode }
        : {}),
      ...(details.providerMessage !== undefined
        ? { providerMessage: details.providerMessage }
        : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(details.transport !== 'unknown'
        ? { transport: details.transport }
        : {}),
    };
  }

  private getRequestId(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const source = error as {
      requestID?: unknown;
      request_id?: unknown;
      response_id?: unknown;
    };
    for (const value of [
      source.requestID,
      source.request_id,
      source.response_id,
    ]) {
      if (typeof value === 'string' && value) {
        return value;
      }
    }
    return undefined;
  }

  private getTimeoutTroubleshootingTips(): string {
    const tips = [
      '- Reduce input length or complexity',
      '- Increase timeout in config: contentGenerator.timeout',
      '- Check network connectivity',
    ];
    return `Troubleshooting tips:\n${tips.join('\n')}`;
  }
}
