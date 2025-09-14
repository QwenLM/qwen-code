/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interface for a Gaxios error object.
 */
interface GaxiosError {
  response?: {
    data?: unknown;
  };
}

/**
 * Type guard to check if an error is a NodeJS.ErrnoException.
 * @param error The error to check.
 * @returns True if the error is a NodeJS.ErrnoException, false otherwise.
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Gets the message from an error object.
 * @param error The error to get the message from.
 * @returns The error message as a string.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return 'Failed to get error details';
  }
}

/**
 * Custom error for 403 Forbidden responses.
 */
export class ForbiddenError extends Error {}
/**
 * Custom error for 401 Unauthorized responses.
 */
export class UnauthorizedError extends Error {}
/**
 * Custom error for 400 Bad Request responses.
 */
export class BadRequestError extends Error {}

/**
 * Interface for the data object in a response.
 */
interface ResponseData {
  error?: {
    code?: number;
    message?: string;
  };
}

/**
 * Converts a Gaxios error to a more specific, friendly error type.
 * @param error The error to convert.
 * @returns The converted error, or the original error if it's not a Gaxios error.
 */
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

/**
 * Parses the response data from a Gaxios error.
 * @param error The Gaxios error to parse.
 * @returns The parsed response data.
 */
function parseResponseData(error: GaxiosError): ResponseData {
  // Inexplicably, Gaxios sometimes doesn't JSONify the response data.
  if (typeof error.response?.data === 'string') {
    return JSON.parse(error.response?.data) as ResponseData;
  }
  return error.response?.data as ResponseData;
}
