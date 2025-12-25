/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';

export async function handleFallback(
  config: Config,
  failedModel: string,
  authType?: string,
  error?: unknown,
): Promise<string | boolean | null> {
  // Handle different auth types
  if (authType === AuthType.QWEN_OAUTH) {
    return handleQwenOAuthError(error);
  }

  return null;
}

/**
 * Handles Qwen OAuth authentication errors and rate limiting
 */
async function handleQwenOAuthError(error?: unknown): Promise<string | null> {
  if (!error) {
    return null;
  }

  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const errorCode =
    (error as { status?: number; code?: number })?.status ||
    (error as { status?: number; code?: number })?.code;

  // Check if this is an authentication/authorization error
  const isAuthError =
    errorCode === 401 ||
    errorCode === 403 ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('invalid api key') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('access denied') ||
    (errorMessage.includes('token') && errorMessage.includes('expired'));

  // Check if this is a rate limiting error
  const isRateLimitError =
    errorCode === 429 ||
    errorMessage.includes('429') ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('too many requests');

  if (isAuthError) {
    console.warn('Qwen OAuth authentication error detected:', errorMessage);
    // The QwenContentGenerator should automatically handle token refresh
    // If it still fails, it likely means the refresh token is also expired
    console.log(
      'Note: If this persists, you may need to re-authenticate with Qwen OAuth',
    );
    return null;
  }

  if (isRateLimitError) {
    console.warn('Qwen API rate limit encountered:', errorMessage);
    // For rate limiting, we don't need to do anything special
    // The retry mechanism will handle the backoff
    return null;
  }

  // For other errors, don't handle them specially
  return null;
}
