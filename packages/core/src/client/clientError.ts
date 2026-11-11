/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single error type raised by a client implementation.
 *
 * Every server operation in the api layer returns a non-nullable `Resp`, so a
 * failed call (transport error, non-2xx status, undecodable body, missing
 * credential) must surface as a thrown error rather than a `null` return. This
 * type carries the diagnostics a caller needs to react (which operation, the
 * HTTP status when there was one, and the server/client request id).
 */
export interface ClientErrorOptions {
  /** Stable machine-readable classification for callers that need recovery. */
  readonly code?: string;
  /** The api operation name, e.g. `chatLike.submit`. */
  readonly operation?: string;
  /** The HTTP status code, when the failure came from a server response. */
  readonly statusCode?: number;
  /** The server- or client-assigned request id, for cross-referencing logs. */
  readonly requestId?: string;
  /** The underlying cause, when this error wraps another. */
  readonly cause?: unknown;
  /**
   * The full body of a non-2xx response, set only for requests built with
   * `captureErrorBody()`. Not truncated: callers may parse it (e.g. a
   * business error code), so truncate when putting it into a message.
   */
  readonly responseBody?: string;
}

export class ClientError extends Error {
  readonly code?: string;
  readonly operation?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly responseBody?: string;

  constructor(message: string, options: ClientErrorOptions = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'ClientError';
    if (options.code !== undefined) this.code = options.code;
    if (options.operation !== undefined) this.operation = options.operation;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.responseBody !== undefined) {
      this.responseBody = options.responseBody;
    }
  }
}

/**
 * `code` of a ClientError raised because the server's response could not be
 * decoded (invalid JSON, a frame of unknown shape, an event out of sequence).
 */
export const MALFORMED_RESPONSE_CODE = 'malformed_response';

/**
 * `code` of a ClientError raised because the connection failed while sending
 * the request or reading the response (DNS, connect, reset, timeout).
 */
export const NETWORK_FAILURE_CODE = 'network_failure';

/**
 * `code` of a ClientError raised because the response body exceeded the byte
 * limit the caller set for it.
 */
export const RESPONSE_TOO_LARGE_CODE = 'response_too_large';

/**
 * Runtime (Node/undici/Bun) codes of connection and I/O failures, compared
 * upper-cased. Certificate validation failures are excluded: they are
 * configuration problems that every retry reproduces.
 */
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENODATA',
  'ENOTFOUND',
  'ESERVFAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_PROXY',
  'CONNECTIONREFUSED',
  'CONNECTIONCLOSED',
  'FAILEDTOOPENSOCKET',
]);

export interface ToClientErrorOptions {
  readonly operation: string;
  readonly requestId?: string;
  /** Once the caller has aborted, the failure is the cancellation itself. */
  readonly signal?: AbortSignal;
}

/**
 * Brings a failure raised while sending a request or reading its response
 * under the ClientError contract. ClientErrors and cancellations pass through
 * unchanged; anything else is wrapped with the original kept as `cause` and its
 * message kept verbatim, tagged {@link NETWORK_FAILURE_CODE} when a runtime
 * connection error code sits anywhere in its cause graph.
 */
export function toClientError(
  error: unknown,
  options: ToClientErrorOptions,
): unknown {
  if (
    error instanceof ClientError ||
    options.signal?.aborted ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return error;
  }
  return new ClientError(
    error instanceof Error ? error.message : String(error),
    {
      code: isNetworkFailure(error) ? NETWORK_FAILURE_CODE : undefined,
      operation: options.operation,
      requestId: options.requestId,
      cause: error,
    },
  );
}

/**
 * Walks `cause` and `AggregateError.errors` and trusts only machine-readable
 * markers: free-form text must never turn an arbitrary error into a network
 * failure. A `TimeoutError` reaching here is a transport deadline, since a
 * caller abort has already passed through.
 */
function isNetworkFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const { code, name, cause, errors } = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }
    if (name === 'TimeoutError') return true;
    if (cause !== undefined) pending.push(cause);
    if (Array.isArray(errors)) pending.push(...errors);
  }
  return false;
}
