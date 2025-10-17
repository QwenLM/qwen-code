/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { logFlashFallback, FlashFallbackEvent } from '../telemetry/index.js';

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

  // Applicability Checks
  if (authType !== AuthType.LOGIN_WITH_GOOGLE) return null;

  const fallbackModel = DEFAULT_GEMINI_FLASH_MODEL;

  if (failedModel === fallbackModel) return null;

  // Consult UI Handler for Intent
  const fallbackModelHandler = config.fallbackModelHandler;
  if (typeof fallbackModelHandler !== 'function') return null;

  try {
    // Pass the specific failed model to the UI handler.
    const intent = await fallbackModelHandler(
      failedModel,
      fallbackModel,
      error,
    );

    // Process Intent and Update State
    switch (intent) {
      case 'retry':
        // Activate fallback mode. The NEXT retry attempt will pick this up.
        activateFallbackMode(config, authType);
        return true; // Signal retryWithBackoff to continue.

      case 'stop':
        activateFallbackMode(config, authType);
        return false;

      case 'auth':
        return false;

      default:
        throw new Error(
          `Unexpected fallback intent received from fallbackModelHandler: "${intent}"`,
        );
    }
  } catch (handlerError) {
    console.error('Fallback UI handler failed:', handlerError);
    return null;
  }
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

function activateFallbackMode(config: Config, authType: string | undefined) {
  if (!config.isInFallbackMode()) {
    config.setFallbackMode(true);
    if (authType) {
      logFlashFallback(config, new FlashFallbackEvent(authType));
    }
  }
}
