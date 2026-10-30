/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SubscriptionOAuthError,
  retryAfterMs,
} from './subscription-oauth-client.js';

export function subscriptionHttpError(
  status: number,
  value: unknown,
  retryAfter?: string | null,
): SubscriptionOAuthError {
  const description =
    value && typeof value === 'object' && 'error_description' in value
      ? value.error_description
      : undefined;
  return new SubscriptionOAuthError(
    status === 401 ? 'invalid_token' : 'request_failed',
    status,
    typeof description === 'string' && description.trim()
      ? description
      : undefined,
    retryAfterMs(retryAfter ?? null),
  );
}

export function subscriptionErrorMessage(
  error: SubscriptionOAuthError,
): string {
  if (error.status && error.status >= 400 && error.description)
    return error.description;
  if (
    error.code === 'session_changed' ||
    (error.stage === 'refresh' && error.code === 'invalid_grant') ||
    error.code === 'invalid_token'
  )
    return 'Your Qwen session has expired. Run /auth to sign in again.';
  if (error.status === 429) return 'Too many requests. Please try again later.';
  if (error.stage === 'credentials' || error.stage === 'cleanup')
    return 'Could not read or save Qwen credentials. Check local file permissions and disk space.';
  if (error.code === 'network_error' || error.code === 'request_timeout')
    return error.stage === 'refresh'
      ? 'Could not refresh your Qwen session. The network request failed or timed out.'
      : 'The network request failed or timed out.';
  return error.stage === 'refresh'
    ? 'Could not refresh your Qwen session. Please try again.'
    : `Qwen request failed${error.status ? ` (HTTP ${error.status})` : ''}.`;
}
