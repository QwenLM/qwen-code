/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const AUTH_ERROR_PATTERNS = [
  'Authentication required', // Standard authentication request message
  '(code: -32000)', // RPC error code -32000 indicates authentication failure
  'Unauthorized', // HTTP unauthorized error
  'Invalid token', // Invalid token
  'Session expired', // Session expired
];

/**
 * Determines if the given error is authentication-related
 */
export const isAuthenticationRequiredError = (error: unknown): boolean => {
  // Null check to avoid unnecessary processing
  if (!error) {
    return false;
  }

  // Extract error message text
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);

  // Match authentication-related errors using predefined patterns
  return AUTH_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
};
