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
import { getRateLimitErrorDetails } from './rateLimit.js';

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
 * A resolved id is echoed verbatim onto the user-facing error line, which is
 * written to the terminal, the interactive error item, and JSON output. Fail
 * closed on anything outside a token allowlist so a hostile or compromised
 * gateway cannot smuggle ANSI/OSC escape sequences, newlines, or other
 * control characters onto that line. Mirrors the visible-ASCII
 * `X-Request-Id` policy in
 * docs/design/2026-09-27-managed-agent-session-query.md §4.5.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Deepest `error.cause` chain the resolver walks. A gateway error wrapped in
 * a local Error keeps its headers one cause down; the bound mirrors
 * MAX_COLLECT_DEPTH so a cause cycle terminates.
 */
const MAX_REQUEST_ID_CAUSE_DEPTH = 4;

/** Reads a string field, treating empty and whitespace-only as absent. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads the request id candidate off a single error level (no cause walk),
 * most specific source first. `StructuredError.requestId` and the SDK header
 * keep their original lead so the openai-node bodyless-400 path is unchanged;
 * the body-payload fallback (`getRateLimitErrorDetails`) deliberately ranks
 * last so it never outranks an explicit `.requestId`.
 */
function readRequestIdCandidate(error: object): string | undefined {
  const record = error as {
    requestId?: unknown;
    requestID?: unknown;
    request_id?: unknown;
    response_id?: unknown;
    response?: unknown;
  };
  return (
    nonBlank(record.requestId) ??
    nonBlank(getHeaderValue(error, REQUEST_ID_HEADER)) ??
    nonBlank(getHeaderValue(record.response, REQUEST_ID_HEADER)) ??
    nonBlank(record.requestID) ??
    nonBlank(record.request_id) ??
    nonBlank(record.response_id) ??
    nonBlank(getRateLimitErrorDetails(error).requestId)
  );
}

/**
 * Resolves a provider request id for an error, from the shapes one can
 * actually arrive in:
 *
 * 1. `StructuredError.requestId` — already resolved upstream while the
 *    original Error was still whole (turn.ts discards the Error when it
 *    builds the structured value).
 * 2. Response headers — openai-node stamps `x-request-id` onto every APIError
 *    as a real `Headers` instance (no own enumerable properties, so
 *    `getHeaderValue` rather than bracket access); Gaxios-shaped failures
 *    nest the same record under `error.response.headers`.
 * 3. Body spellings and payloads — `requestID` (openai-node's own property),
 *    `request_id`, `response_id`, then the provider payload parsed out of the
 *    message (SSE frames, JSON diagnostics). An `APIConnectionError` arrives
 *    without headers, but on the Anthropic path the id travels in the frame
 *    body, which this fallback recovers.
 * 4. `error.cause`, walked a bounded number of hops.
 *
 * Returns undefined when no usable id is found; an id outside
 * SAFE_REQUEST_ID is dropped rather than sanitized.
 */
export function resolveApiErrorRequestId(error: unknown): string | undefined {
  for (
    let current: unknown = error, depth = 0;
    typeof current === 'object' && current !== null;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    if (depth > MAX_REQUEST_ID_CAUSE_DEPTH) return undefined;
    const candidate = readRequestIdCandidate(current);
    if (candidate === undefined) continue;
    return SAFE_REQUEST_ID.test(candidate)
      ? candidate.substring(0, MAX_REQUEST_ID_LENGTH)
      : undefined;
  }
  return undefined;
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
    // Skip the suffix when the message already embeds this id in one of the
    // two forms that legitimately carry it: the " (request_id: …)" suffix
    // ResponsesHttpError appends on its opaque-body path, or the
    // "request_id":"<id>" pair inside the JSON diagnostic of its parsed-body
    // path. Matching those two rendered forms rather than the bare id keeps a
    // short id that merely appears inside the message text (e.g. "400" in
    // "400 status code (no body)") from silently suppressing the suffix this
    // formatter exists to add.
    const embedsRequestId =
      requestId !== undefined &&
      (message.includes(`(request_id: ${requestId})`) ||
        message.includes(`"request_id":"${requestId}"`));
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
