/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isApiError, isStructuredError } from './quotaErrorDetection.js';
import { AuthType } from '../core/contentGenerator.js';

const RATE_LIMIT_MESSAGE_BY_AUTH = {
  [AuthType.USE_GEMINI]:
    '\nPlease wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method',
  [AuthType.USE_VERTEX_AI]:
    '\nPlease wait and try again later. To increase your limits, request a quota increase through Vertex, or switch to another /auth method',
  default:
    '\nPossible quota limitations in place or slow response times detected. Please wait and try again later.',
} as const;

const RATE_LIMIT_SUFFIXES = Object.values(RATE_LIMIT_MESSAGE_BY_AUTH);

function getRateLimitMessage(authType?: AuthType): string {
  if (authType === AuthType.USE_GEMINI) {
    return RATE_LIMIT_MESSAGE_BY_AUTH[AuthType.USE_GEMINI];
  }

  if (authType === AuthType.USE_VERTEX_AI) {
    return RATE_LIMIT_MESSAGE_BY_AUTH[AuthType.USE_VERTEX_AI];
  }

  return RATE_LIMIT_MESSAGE_BY_AUTH.default;
}

const API_ERROR_PREFIX = '[API Error: ';

/**
 * Returns true when `value` already looks like the output of
 * parseAndFormatApiError.
 *
 * Accepts:
 * 1) base format: "[API Error: ...]"
 * 2) 429 format: "[API Error: ...]" followed by one of the known quota
 *    guidance suffixes.
 *
 * Used as an idempotency guard: when an upstream caller has already passed an
 * Error through parseAndFormatApiError, stuffed the formatted string into
 * Error.message, and the message reaches us a second time, we should return it
 * unchanged rather than producing "[API Error: [API Error: ...]]".
 */
function isAlreadyFormatted(value: string): boolean {
  const trimmed = value.trimEnd();
  if (!trimmed.startsWith(API_ERROR_PREFIX)) {
    return false;
  }

  if (trimmed.endsWith(']')) {
    return true;
  }

  return RATE_LIMIT_SUFFIXES.some((suffix) => trimmed.includes(`]${suffix}`));
}

export function parseAndFormatApiError(
  error: unknown,
  authType?: AuthType,
): string {
  if (isStructuredError(error)) {
    // Qwen OAuth quota errors have their own user-friendly message; don't wrap them
    if (
      error.message.startsWith('Qwen OAuth quota exceeded:') ||
      error.message.startsWith('Qwen OAuth free tier has been discontinued')
    ) {
      return error.message;
    }

    // If a previous pass through this function already wrapped this message
    // and stuffed it into Error.message, return it unchanged. Avoids the
    // "[API Error: [API Error: ...]]" double-wrap reported in non-interactive
    // mode when a 4xx flows through both the stream handler and handleError.
    if (isAlreadyFormatted(error.message)) {
      return error.message;
    }

    let text = `[API Error: ${error.message}]`;
    if (error.status === 429) {
      text += getRateLimitMessage(authType);
    }
    return text;
  }

  // The error message might be a string containing a JSON object.
  if (typeof error === 'string') {
    // Same idempotency guard for the plain-string path.
    if (isAlreadyFormatted(error)) {
      return error;
    }

    const jsonStart = error.indexOf('{');
    if (jsonStart === -1) {
      return `[API Error: ${error}]`; // Not a JSON error, return as is.
    }

    const jsonString = error.substring(jsonStart);

    try {
      const parsedError = JSON.parse(jsonString) as unknown;
      if (isApiError(parsedError)) {
        let finalMessage = parsedError.error.message;
        try {
          // See if the message is a stringified JSON with another error
          const nestedError = JSON.parse(finalMessage) as unknown;
          if (isApiError(nestedError)) {
            finalMessage = nestedError.error.message;
          }
        } catch (_e) {
          // It's not a nested JSON error, so we just use the message as is.
        }
        const statusText = parsedError.error.status
          ? ` (Status: ${parsedError.error.status})`
          : '';
        let text = `[API Error: ${finalMessage}${statusText}]`;
        if (parsedError.error.code === 429) {
          text += getRateLimitMessage(authType);
        }
        return text;
      }
    } catch (_e) {
      // Not a valid JSON, fall through and return the original message.
    }
    return `[API Error: ${error}]`;
  }

  return '[API Error: An unknown error occurred.]';
}
