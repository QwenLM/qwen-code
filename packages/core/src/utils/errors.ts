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

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    // Handle Node.js errno errors (EACCES, ENOENT, etc.)
    if ('code' in error && 'syscall' in error && 'path' in error) {
      const err = error as { code: string; syscall: string; path: string; errno?: number };
      return `${err.code}: ${err.syscall} failed for ${err.path}`;
    }
    // Handle objects with message property
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
    // Fall back to JSON serialization for other objects
    try {
      return JSON.stringify(error);
    } catch {
      return '[Error object could not be serialized]';
    }
  }
  try {
    return String(error);
  } catch {
    return 'Failed to get error details';
  }
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
