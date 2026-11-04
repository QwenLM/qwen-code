/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionOAuthError } from './subscription-oauth-client.js';
import {
  logSubscriptionGatewayResponse,
  subscriptionErrorMessage,
  subscriptionHttpError,
} from './subscription-errors.js';

const log = vi.hoisted(() => vi.fn());
vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => ({ debug: log }),
}));

beforeEach(() => log.mockClear());

describe('subscription request errors', () => {
  it('retains quota display context alongside readable English', () => {
    const error = subscriptionHttpError(402, {
      error: { code: 'insufficient_quota', quota: { member_type: 'plus' } },
    });
    expect(error).toMatchObject({
      status: 402,
      code: 'insufficient_quota',
      subscriptionQuota: { type: 'subscription_quota', memberType: 'plus' },
    });
    expect(subscriptionErrorMessage(error)).toContain('/upgrade');
  });
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
    { code: 'invalid_token', message: 'Unsupported top-level message' },
    { error: { code: 403, message: { private: 'private-test-token' } } },
  ])('does not interpret unconfirmed response fields: %j', (body) => {
    const error = subscriptionHttpError(403, body);
    expect(error).toMatchObject({ code: 'request_failed', status: 403 });
    expect(error.description).toBeUndefined();
    expect(subscriptionErrorMessage(error)).toBe(
      'Qwen request failed (HTTP 403).',
    );
  });

  it('preserves the nested gateway public message, code and diagnostic request ID', () => {
    const message = ' 余额不足，请充值后重试。\n ';
    const error = subscriptionHttpError(
      402,
      {
        error: {
          code: 'PROXY_ENTITLEMENT_INSUFFICIENT_CREDITS',
          message,
          request_id: 'body-request',
          error_detail: 'private-test-token',
        },
        error_description: 'Legacy message',
      },
      '30',
    );
    expect(error).toMatchObject({
      code: 'PROXY_ENTITLEMENT_INSUFFICIENT_CREDITS',
      status: 402,
      retryAfterMs: 30_000,
    });
    expect(subscriptionErrorMessage(error)).toBe(message);
    expect(log).toHaveBeenCalledWith('Gateway request failed', {
      status: 402,
      code: 'PROXY_ENTITLEMENT_INSUFFICIENT_CREDITS',
      requestId: 'body-request',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-test-token');
  });

  it.each([null, { error: null }, { error: { code: '', message: ' ' } }])(
    'uses the existing fallback for incomplete error bodies: %j',
    (body) => {
      expect(subscriptionErrorMessage(subscriptionHttpError(429, body))).toBe(
        'Too many requests. Please try again later.',
      );
    },
  );

  it('derives rejected credentials from HTTP 401 instead of a response business code', () => {
    const error = subscriptionHttpError(401, { error: 'access_denied' });
    expect(error).toMatchObject({ code: 'invalid_token', status: 401 });
    expect(subscriptionErrorMessage(error)).toContain(
      'credentials are no longer valid',
    );
  });

  it('keeps the rejected-credentials fallback when a gateway code has no public message', () => {
    const error = subscriptionHttpError(401, {
      error: { code: 'PROXY_TOKEN_INVALID' },
    });
    expect(error).toMatchObject({ code: 'PROXY_TOKEN_INVALID', status: 401 });
    expect(subscriptionErrorMessage(error)).toContain(
      'credentials are no longer valid',
    );
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
    ['invalid_grant', undefined, 'refresh', 'credentials are no longer valid'],
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

describe('subscription gateway diagnostics', () => {
  it('logs both response IDs without reading the body or unrelated headers', async () => {
    const response = new Response('original body', {
      status: 503,
      headers: {
        'x-request-id': 'caller-request',
        'x-gateway-request-id': 'gateway-request',
        'set-cookie': 'private-test-token',
      },
    });
    logSubscriptionGatewayResponse(response);
    expect(log).toHaveBeenCalledWith('Gateway response', {
      status: 503,
      requestId: 'caller-request',
      gatewayRequestId: 'gateway-request',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-test-token');
    expect(await response.text()).toBe('original body');
  });

  it('does not invent diagnostic IDs when the response has none', () => {
    logSubscriptionGatewayResponse(new Response());
    expect(log).not.toHaveBeenCalled();
  });
});
