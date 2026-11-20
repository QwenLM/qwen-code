/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SubscriptionOAuthError,
  retryAfterMs,
} from './subscription-oauth-client.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  formatSubscriptionQuotaDisplay,
  subscriptionQuotaDisplay,
} from '../utils/subscription-quota.js';

const debugLogger = createDebugLogger('QWEN_SUBSCRIPTION');

export const SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE =
  'Your login credentials are no longer valid. Run /auth to sign in again.';

export function isSubscriptionSessionExpired(
  error: unknown,
): error is SubscriptionOAuthError {
  return (
    error instanceof SubscriptionOAuthError &&
    (error.code === 'session_changed' ||
      (error.stage === 'refresh' && error.code === 'invalid_grant') ||
      (error.stage === 'userinfo' &&
        (error.status === 401 || error.code === 'invalid_token')))
  );
}

export function logSubscriptionGatewayResponse(response: Response): void {
  const requestId = response.headers.get('x-request-id');
  const gatewayRequestId = response.headers.get('x-gateway-request-id');
  if (requestId || gatewayRequestId) {
    debugLogger.debug('Gateway response', {
      status: response.status,
      requestId,
      gatewayRequestId,
    });
  }
}

export function subscriptionHttpError(
  status: number,
  value: unknown,
  retryAfter?: string | null,
): SubscriptionOAuthError {
  const body =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const detail =
    body['error'] && typeof body['error'] === 'object'
      ? (body['error'] as Record<string, unknown>)
      : {};
  const code =
    typeof detail['code'] === 'string' && detail['code'].trim()
      ? detail['code']
      : status === 401
        ? 'invalid_token'
        : 'request_failed';
  const quota = subscriptionQuotaDisplay(status, detail);
  const description =
    formatSubscriptionQuotaDisplay(quota) ??
    (typeof detail['message'] === 'string' && detail['message'].trim()
      ? detail['message']
      : body['error_description']);
  debugLogger.debug('Gateway request failed', {
    status,
    code,
    requestId:
      typeof detail['request_id'] === 'string'
        ? detail['request_id']
        : undefined,
  });
  return Object.assign(
    new SubscriptionOAuthError(
      code,
      status,
      typeof description === 'string' && description.trim()
        ? description
        : undefined,
      retryAfterMs(retryAfter ?? null),
    ),
    quota ? { subscriptionQuota: quota } : {},
  );
}

export function subscriptionErrorMessage(
  error: SubscriptionOAuthError,
): string {
  const { description } = error;
  if (
    error.status &&
    error.status >= 400 &&
    description &&
    !isSubscriptionSessionExpired(error)
  )
    return description;
  if (
    error.code === 'session_changed' ||
    (error.stage === 'refresh' && error.code === 'invalid_grant') ||
    error.code === 'invalid_token' ||
    error.status === 401
  )
    return SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE;
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
