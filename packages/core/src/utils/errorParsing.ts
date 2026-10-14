/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isApiError,
  isStructuredError,
  QUOTA_EXHAUSTED_PREFIX,
} from './quotaErrorDetection.js';
import { AuthType } from './auth-type.js';
import { getErrorMessage } from './errors.js';
import { getHeaderValue } from './retryPolicy.js';
import type { StructuredError } from '../core/turn.js';

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

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Upper bound on a provider-supplied request id. Real ids are UUIDs; the bound
 * only keeps a misconfigured or hostile `x-request-id` from spilling an
 * arbitrary-length string into the user-facing error line. Same idea as the
 * bounded body excerpt in responses-http-error.ts.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Resolves a provider request id for an error, from either shape it arrives in:
 *
 * 1. `StructuredError.requestId` — already resolved upstream while the original
 *    Error was still whole. This is the only shape the interactive and
 *    non-interactive formatters ever see, because turn.ts discards the Error
 *    when it builds the structured value.
 * 2. a live SDK error carrying response headers — openai-node stamps
 *    `x-request-id` onto every APIError. `getHeaderValue` is used rather than
 *    bracket access because `APIError.headers` is a real `Headers` instance,
 *    which has no own enumerable properties.
 *
 * Returns undefined when no id is available; `APIConnectionError` genuinely
 * arrives without headers, so there is nothing to recover on that path.
 */
export function resolveApiErrorRequestId(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const resolved = (error as StructuredError & { requestId?: unknown })
    .requestId;
  const requestId =
    typeof resolved === 'string' && resolved.trim()
      ? resolved.trim()
      : getHeaderValue(error, REQUEST_ID_HEADER)?.trim();

  return requestId ? requestId.substring(0, MAX_REQUEST_ID_LENGTH) : undefined;
}

/**
 * Returns true when `value` is already in final user-facing form and must not
 * be re-wrapped by parseAndFormatApiError.
 *
 * Accepts:
 * 1) base format: "[API Error: ...]"
 * 2) 429 format: "[API Error: ...]" followed by one of the known quota
 *    guidance suffixes.
 * 3) friendly quota-exhaustion messages ("Quota exhausted: ...") built by
 *    formatQuotaExhaustedMessage — these live here rather than in the
 *    Qwen-OAuth prefix list because they also arrive via the plain-string
 *    path (a StreamContentError whose .message is the formatted text).
 *
 * Used as an idempotency guard: when an upstream caller has already passed an
 * Error through parseAndFormatApiError, stuffed the formatted string into
 * Error.message, and the message reaches us a second time, we should return it
 * unchanged rather than producing "[API Error: [API Error: ...]]".
 */
function isAlreadyFormatted(value: string): boolean {
  const trimmed = value.trimEnd();

  // Friendly quota-exhaustion messages built by formatQuotaExhaustedMessage
  // are already in final form — surface them verbatim, do not wrap.
  if (trimmed.startsWith(QUOTA_EXHAUSTED_PREFIX)) {
    return true;
  }

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

    const message =
      error instanceof Error ? getErrorMessage(error) : error.message;
    // The request id goes INSIDE the closing bracket on purpose: the
    // isAlreadyFormatted() idempotency guard below keys off `endsWith(']')`, so
    // a suffix after the bracket would make a second pass re-wrap the line into
    // "[API Error: [API Error: ...]]".
    const requestId = resolveApiErrorRequestId(error);
    // Skip the suffix when the message already embeds this id: ResponsesHttpError
    // puts it in its own message (as the " (request_id: …)" suffix on the
    // opaque-body path, or inside the JSON diagnostic when the body parses), so
    // appending it again would print the same id twice.
    const embedsRequestId =
      requestId !== undefined && message.includes(requestId);
    let text =
      requestId && !embedsRequestId
        ? `[API Error: ${message} (request_id: ${requestId})]`
        : `[API Error: ${message}]`;
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
