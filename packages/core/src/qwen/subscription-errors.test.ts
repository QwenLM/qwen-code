/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SubscriptionOAuthError } from './subscription-oauth-client.js';
import {
  subscriptionErrorMessage,
  subscriptionHttpError,
} from './subscription-errors.js';

describe('subscription request errors', () => {
  it.each(['access_denied', 'invalid_token', 'invalid_grant'])(
    'uses HTTP 403 and error_description regardless of the returned error string (%s)',
    (code) => {
      const body = {
        error: code,
        error_description: 'Permission denied by the service.',
      };
      const error = subscriptionHttpError(403, body, '30');
      expect(error).toMatchObject({
        code: 'request_failed',
        status: 403,
        retryAfterMs: 30_000,
      });
      expect(subscriptionErrorMessage(error)).toBe(
        'Permission denied by the service.',
      );
    },
  );

  it.each([
    { error: { code: 'invalid_token', message: 'Unsupported nested message' } },
    { code: 'invalid_token', message: 'Unsupported top-level message' },
  ])('does not interpret unconfirmed response fields: %j', (body) => {
    const error = subscriptionHttpError(403, body);
    expect(error).toMatchObject({ code: 'request_failed', status: 403 });
    expect(error.description).toBeUndefined();
    expect(subscriptionErrorMessage(error)).toBe(
      'Qwen request failed (HTTP 403).',
    );
  });

  it('derives rejected credentials from HTTP 401 instead of a response business code', () => {
    const error = subscriptionHttpError(401, { error: 'access_denied' });
    expect(error).toMatchObject({ code: 'invalid_token', status: 401 });
    expect(subscriptionErrorMessage(error)).toContain('session has expired');
  });

  it('keeps HTTP status when the response has no business error', () => {
    const error = subscriptionHttpError(403, '<html>private-test-token</html>');
    expect(subscriptionErrorMessage(error)).toBe(
      'Qwen request failed (HTTP 403).',
    );
  });

  it('preserves the backend error_description verbatim', () => {
    const description = ' 账号权限不足，请联系管理员。\n请稍后重试。 ';
    const error = subscriptionHttpError(403, {
      error: 'access_denied',
      error_description: description,
    });
    expect(error.description).toBe(description);
    expect(subscriptionErrorMessage(error)).toBe(description);
  });

  it.each([
    ['invalid_grant', undefined, 'refresh', 'session has expired'],
    ['request_failed', 429, undefined, 'Too many requests'],
    ['network_error', undefined, 'refresh', 'network request failed'],
    ['credentials_error', undefined, 'credentials', 'file permissions'],
  ] as const)(
    'classifies %s without exposing local exception text',
    (code, status, stage, message) => {
      const error = new SubscriptionOAuthError(
        code,
        status,
        status ? undefined : 'private-test-token',
        undefined,
        stage,
      );
      expect(subscriptionErrorMessage(error)).toContain(message);
      expect(subscriptionErrorMessage(error)).not.toContain(
        'private-test-token',
      );
    },
  );
});
