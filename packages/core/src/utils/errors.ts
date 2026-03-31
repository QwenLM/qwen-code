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

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message} (cause: ${cause.message})`;
    }
    return error.message;
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
  };

  const value =
    err.status ?? err.statusCode ?? err.response?.status ?? err.error?.code;

  return typeof value === 'number' && value >= 100 && value <= 599
    ? value
    : undefined;
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
