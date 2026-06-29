/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface GaxiosError {
  response?: {
    data?: unknown;
  };
}

const MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH = 1000;

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Check if the error is an abort error (user cancellation).
 * This handles both DOMException-style AbortError and Node.js abort errors.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  // Check for AbortError by name (standard DOMException and custom AbortError)
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  // Check for Node.js abort error code
  if (isNodeError(error) && error.code === 'ABORT_ERR') {
    return true;
  }

  return false;
}

/**
 * Best-effort one-line description of an error's `cause`, used to surface the
 * underlying syscall behind opaque wrappers like undici's `TypeError: fetch
 * failed` (whose own message carries nothing). Returns `undefined` when there
 * is no useful detail.
 *
 * Handles three shapes:
 *   - `AggregateError` (undici retries multiple addresses, e.g. IPv6 `::1` then
 *     IPv4 `127.0.0.1`): its own `message` is empty, so unwrap `.errors[]`.
 *   - a plain `Error` with a Node `code` (e.g. `ECONNREFUSED`) but possibly an
 *     empty message — prefer `code`, combine with message when both add signal.
 *   - any other value — stringify.
 */
function describeErrorCause(cause: unknown): string | undefined {
  if (cause == null) return undefined;
  if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
    const inner = cause.errors
      .map((e) => describeSingleError(e))
      .filter((s): s is string => Boolean(s));
    if (inner.length > 0) {
      return [...new Set(inner)].join('; ');
    }
  }
  return describeSingleError(cause);
}

function describeSingleError(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codeStr = typeof code === 'string' ? code : undefined;
    const msg = err.message?.trim();
    if (msg && codeStr && !msg.includes(codeStr)) {
      return `${codeStr}: ${msg}`;
    }
    return msg || codeStr || (err.name !== 'Error' ? err.name : undefined);
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  const str = String(err);
  return str && str !== '[object Object]' ? str : undefined;
}

function truncateStringifiedErrorMessage(message: string): string {
  if (message.length <= MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_STRINGIFIED_ERROR_MESSAGE_LENGTH - 3)}...`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const detail = describeErrorCause(error.cause);
    if (detail && detail !== error.message) {
      return `${error.message} (cause: ${detail})`;
    }
    return error.message;
  }
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
    try {
      const serialized = JSON.stringify(error);
      return serialized
        ? truncateStringifiedErrorMessage(serialized)
        : String(error);
    } catch {
      return String(error);
    }
  }
  try {
    return String(error);
  } catch {
    return 'Failed to get error details';
  }
}

/**
 * Extracts the HTTP status code from an error object.
 *
 * Checks the following properties in order of priority:
 * 1. `error.status` - OpenAI, Anthropic, Gemini SDK errors
 * 2. `error.statusCode` - Some HTTP client libraries
 * 3. `error.response.status` - Axios-style errors
 * 4. `error.error.code` - Nested error objects
 * 5. `HTTP_STATUS/NNN` pattern in `error.message` - SSE-embedded streaming
 *    errors where the SDK never sees a real HTTP status because the stream
 *    opened with 200 OK and the provider signaled the error mid-stream.
 *    DashScope uses `:HTTP_STATUS/429` as an SSE comment on throttling.
 *
 * @returns The HTTP status code (100-599), or undefined if not found.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    error?: { code?: unknown };
    message?: unknown;
  };

  const value =
    err.status ?? err.statusCode ?? err.response?.status ?? err.error?.code;

  if (typeof value === 'number' && value >= 100 && value <= 599) {
    return value;
  }

  if (typeof err.message === 'string') {
    const match = err.message.match(/HTTP_STATUS\/(\d{3})\b/);
    if (match) {
      const parsed = Number(match[1]);
      if (parsed >= 100 && parsed <= 599) {
        return parsed;
      }
    }
  }

  return undefined;
}

/**
 * Extracts a descriptive error type string from an error object.
 *
 * Uses the error's constructor name (e.g. "APIConnectionError",
 * "APIConnectionTimeoutError") which is more specific than the generic
 * `.type` field. Falls back to `.type` for SDK errors that set it,
 * then to `error.name`, then "unknown".
 *
 * For network errors, appends the cause code (e.g. "ECONNREFUSED")
 * when available.
 *
 * @returns A string identifying the error type.
 */
export function getErrorType(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }

  // Prefer the constructor name — SDK subclasses like APIConnectionError,
  // RateLimitError etc. have meaningful names.
  const constructorName =
    error instanceof Error && error.constructor.name !== 'Error'
      ? error.constructor.name
      : undefined;

  // .type is set by OpenAI SDK (e.g. "invalid_request_error")
  const sdkType = (error as { type?: string }).type;

  const baseType =
    constructorName ??
    sdkType ??
    (error instanceof Error ? error.name : 'unknown');

  // For network errors, append the cause code (e.g. ECONNREFUSED, ETIMEDOUT)
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? (cause as { code?: string }).code
      : undefined;

  return causeCode ? `${baseType}:${causeCode}` : baseType;
}

export class FatalError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export class FatalAuthenticationError extends FatalError {
  constructor(message: string) {
    super(message, 41);
  }
}
export class FatalInputError extends FatalError {
  constructor(message: string) {
    super(message, 42);
  }
}
export class FatalSandboxError extends FatalError {
  constructor(message: string) {
    super(message, 44);
  }
}
export class FatalConfigError extends FatalError {
  constructor(message: string) {
    super(message, 52);
  }
}
export class FatalTurnLimitedError extends FatalError {
  constructor(message: string) {
    super(message, 53);
  }
}
export class FatalToolExecutionError extends FatalError {
  constructor(message: string) {
    super(message, 54);
  }
}
/**
 * Raised when a headless / unattended run exceeds a configured budget
 * (`--max-wall-time`, `--max-tool-calls`). Distinct exit code from
 * `FatalTurnLimitedError` (53) so CI scripts can branch on
 * "run exhausted its budget" vs. "run hit the turn cap." See issue
 * QwenLM/qwen-code#4103.
 */
export class FatalBudgetExceededError extends FatalError {
  constructor(message: string) {
    super(message, 55);
  }
}
export class FatalCancellationError extends FatalError {
  constructor(message: string) {
    super(message, 130); // Standard exit code for SIGINT
  }
}

export class ForbiddenError extends Error {}
export class UnauthorizedError extends Error {}
export class BadRequestError extends Error {}

interface ResponseData {
  error?: {
    code?: number;
    message?: string;
  };
}

export function toFriendlyError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'response' in error) {
    const gaxiosError = error as GaxiosError;
    const data = parseResponseData(gaxiosError);
    if (data.error && data.error.message && data.error.code) {
      switch (data.error.code) {
        case 400:
          return new BadRequestError(data.error.message);
        case 401:
          return new UnauthorizedError(data.error.message);
        case 403:
          // It's import to pass the message here since it might
          // explain the cause like "the cloud project you're
          // using doesn't have code assist enabled".
          return new ForbiddenError(data.error.message);
        default:
      }
    }
  }
  return error;
}

function parseResponseData(error: GaxiosError): ResponseData {
  // Inexplicably, Gaxios sometimes doesn't JSONify the response data.
  if (typeof error.response?.data === 'string') {
    return JSON.parse(error.response?.data) as ResponseData;
  }
  return error.response?.data as ResponseData;
}
