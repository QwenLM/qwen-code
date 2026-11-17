/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import { logAuth } from '@qwen-code/qwen-code-core/telemetry/loggers.js';
import { AuthEvent } from '@qwen-code/qwen-code-core/telemetry/types.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import {
  isSubscriptionSessionExpired,
  subscriptionErrorMessage,
} from '@qwen-code/qwen-code-core/qwen/subscription-errors.js';
import { t } from '../i18n/index.js';

/**
 * Handles the initial authentication flow.
 * @param config The application config.
 * @param authType The selected auth type.
 * @param subscriptionFallbackModel A saved user model eligible for startup fallback.
 * @param allowUnlistedSubscriptionModel Whether to defer model availability to the inference gateway.
 * @returns An error message if authentication fails, otherwise null.
 */
export async function performInitialAuth(
  config: Config,
  authType: AuthType | undefined,
  subscriptionFallbackModel?: string,
  allowUnlistedSubscriptionModel?: boolean,
): Promise<string | null> {
  if (!authType) {
    return null;
  }
  if (
    authType === AuthType.QWEN_SUBSCRIPTION &&
    !new QwenSubscriptionSession().isSignedIn()
  )
    return null;

  try {
    await config.refreshAuth(
      authType,
      true,
      subscriptionFallbackModel,
      allowUnlistedSubscriptionModel,
    );
    // The console.log is intentionally left out here.
    // We can add a dedicated startup message later if needed.

    // Log authentication success
    const authEvent = new AuthEvent(authType, 'auto', 'success');
    logAuth(config, authEvent);
  } catch (e) {
    if (
      authType === AuthType.QWEN_SUBSCRIPTION &&
      isSubscriptionSessionExpired(e)
    )
      return null;
    const errorMessage =
      e instanceof SubscriptionOAuthError
        ? t(subscriptionErrorMessage(e))
        : `Failed to login. Message: ${getErrorMessage(e)}`;

    // Log authentication failure
    const authEvent = new AuthEvent(authType, 'auto', 'error', errorMessage);
    logAuth(config, authEvent);

    return errorMessage;
  }

  return null;
}
