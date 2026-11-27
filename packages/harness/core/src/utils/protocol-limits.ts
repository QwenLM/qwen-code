/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Keep HTTP response-header handling aligned with undici's normal default. */
export const MAX_HTTP_RESPONSE_HEADER_BYTES = 16 * 1024;
/** Bound an unfinished physical SSE line without limiting the whole stream. */
export const MAX_SSE_LINE_BYTES = 16 * 1024 * 1024;
/** Bound one logical model-stream event/message without limiting the stream. */
export const MAX_MODEL_STREAM_EVENT_BYTES = 32 * 1024 * 1024;

export const PROTOCOL_LIMIT_ERROR_CODE = 'protocol_limit';

export type ProtocolLimitKind =
  | 'http_response_headers'
  | 'http_informational_responses'
  | 'http_chunk_size_line'
  | 'sse_line'
  | 'sse_event'
  | 'grpc_message';

/**
 * A local resource guard rejected a peer response or protocol message.
 *
 * This is deliberately distinct from a transport failure: retrying another IP
 * cannot make the same protocol payload smaller and must not affect route
 * health or circuit-breaker state.
 */
export class ProtocolLimitError extends RangeError {
  readonly code = PROTOCOL_LIMIT_ERROR_CODE;
  readonly phase = 'protocol';

  constructor(
    message: string,
    readonly limitKind: ProtocolLimitKind,
    readonly limitBytes: number,
    readonly actualBytes?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProtocolLimitError';
  }
}

/** Recognize a protocol limit anywhere in a wrapped error chain. */
export function isProtocolLimitError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === PROTOCOL_LIMIT_ERROR_CODE ||
      candidate.name === 'ProtocolLimitError'
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
