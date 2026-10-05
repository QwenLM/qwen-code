/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';

import type { RetryErrorClassification } from '../utils/retryErrorClassification.js';

// Internal stream retry allow-list. Keep this outside llm-chat.ts because
// that file is re-exported from the package barrel, and this retry policy is
// not part of the public API.
export const RETRYABLE_STREAM_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isRetryableStreamTransportError(
  classification: RetryErrorClassification,
): boolean {
  return (
    classification.kind === 'transport' &&
    classification.transportCode !== undefined &&
    RETRYABLE_STREAM_TRANSPORT_CODES.has(classification.transportCode)
  );
}

/**
 * True when the provider traced a failure with its own request id but no HTTP
 * status survived — a gateway error frame pushed into an already-200 SSE
 * stream, which the OpenAI SDK surfaces with neither a status nor a socket
 * code. This needs its own predicate instead of a wider
 * `RETRYABLE_STREAM_TRANSPORT_CODES`: that set is socket-only by contract.
 * LlmChat's replay/continuation boundary admits this class alongside socket
 * cuts, and the Anthropic generator's deferred tool-call release gate reads
 * both predicates so a closed batch reaches LlmChat on the same footing on
 * either provider.
 */
export function isRetryableStatuslessUpstreamError(
  classification: RetryErrorClassification,
): boolean {
  return classification.reason === 'upstream-error-without-status';
}

const flushedToolCallParks = new WeakMap<GenerateContentResponse, true>();

/**
 * Tag a parked tool-call finish that the pipeline's error-path flush released.
 *
 * The flush decides whether to release from the pipeline's own view of what it
 * yielded, and that view counts chunks LlmChat's protocol-tag suppression can
 * still withhold — a first chunk of leading JSON, for one. When the two
 * disagree the release hands LlmChat a `functionCall` it delivered nothing for,
 * and receiving one flips the very delivered-flags that shut replay and
 * continuation, so a cut the replay arm could still have recovered instead
 * kills the turn on its first attempt. The tag lets the send loop — the only
 * place that knows what actually reached the caller — decline to count a
 * release that has no delivered content behind it.
 *
 * A WeakMap rather than a field on the response: these objects cross a package
 * boundary and their type is not this repo's to extend. The same channel shape
 * is already used for tool-call preparations, whose keys survive from the
 * converter to `processStreamResponse` unchanged.
 */
export function markFlushedToolCallPark(
  response: GenerateContentResponse,
): void {
  flushedToolCallParks.set(response, true);
}

export function isFlushedToolCallPark(
  response: GenerateContentResponse,
): boolean {
  return flushedToolCallParks.get(response) === true;
}
