/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { classifyRetryError } from './retryErrorClassification.js';

describe('classifyRetryError', () => {
  it('classifies HTTP 429 as retryable rate limiting', () => {
    expect(
      classifyRetryError({ status: 429, message: 'Too Many Requests' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 429,
      reason: 'rate-limit',
    });
  });

  it('classifies HTTP 503 as retryable rate limiting to match stream retry semantics', () => {
    expect(
      classifyRetryError({ status: 503, message: 'Provider overloaded' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 503,
      reason: 'rate-limit',
    });
  });

  it('classifies provider rate-limit codes as retryable rate limiting', () => {
    expect(
      classifyRetryError(
        new Error(
          '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
        ),
      ),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '1302',
      providerMessage: '您的账户已达到速率限制，请您控制请求频率',
      reason: 'rate-limit',
    });

    expect(
      classifyRetryError({
        error: { code: 1305, message: 'IdealTalk rate limit' },
      }),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '1305',
      providerMessage: 'IdealTalk rate limit',
      reason: 'rate-limit',
    });
  });

  it('honors caller-provided extra rate-limit codes in diagnostics', () => {
    expect(
      classifyRetryError(
        { error: { code: 4999, message: 'Provider-specific throttle' } },
        { extraRetryErrorCodes: [4999] },
      ),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '4999',
      providerMessage: 'Provider-specific throttle',
      reason: 'rate-limit',
    });
  });

  it('honors extra rate-limit codes on Error instances with status properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });

    expect(
      classifyRetryError(error, {
        authType: AuthType.USE_OPENAI,
        extraRetryErrorCodes: [4999],
      }),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'rate-limit',
    });
  });

  it('classifies SSE-embedded non-quota 429 errors as retryable rate limiting', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.RateLimit","message":"Rate limit exceeded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 429,
      providerCode: 'Throttling.RateLimit',
      providerMessage: 'Rate limit exceeded',
      requestId: 'req-1',
      reason: 'rate-limit',
    });
  });

  it('classifies SSE-embedded allocation quota errors as provider business failures', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
      providerMessage: 'Allocated quota exceeded',
      requestId: 'req-1',
      reason: 'allocated-quota-exceeded',
    });
  });

  it('does not treat allocation quota text without the structured provider code as fail-fast', () => {
    expect(
      classifyRetryError(new Error('previously allocated quota exceeded')),
    ).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('marks Qwen OAuth free-tier quota errors as fail-fast', () => {
    expect(
      classifyRetryError(
        {
          status: 429,
          code: 'insufficient_quota',
          message: 'Free allocated quota exceeded',
        },
        { authType: AuthType.QWEN_OAUTH },
      ),
    ).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      statusCode: 429,
      providerCode: 'insufficient_quota',
      reason: 'qwen-oauth-free-tier-quota',
    });
  });

  it('marks request validation errors as fail-fast', () => {
    expect(
      classifyRetryError({
        status: 400,
        code: 'invalid_request_error',
        message: 'Invalid messages in payload',
      }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      providerCode: 'invalid_request_error',
      reason: 'client-error',
    });
  });

  it('pins 408 and 425 as current client-error fail-fast classifications', () => {
    expect(
      classifyRetryError({ status: 408, message: 'Request Timeout' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 408,
      reason: 'client-error',
    });

    expect(
      classifyRetryError({ status: 425, message: 'Too Early' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 425,
      reason: 'client-error',
    });
  });

  it('marks auth errors as fail-fast', () => {
    expect(
      classifyRetryError({ status: 401, message: 'Unauthorized' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });

    expect(
      classifyRetryError({ status: 403, message: 'Forbidden' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 403,
      reason: 'auth-error',
    });
  });

  it('classifies 529 as retryable capacity overload', () => {
    expect(
      classifyRetryError({ status: 529, message: 'Overloaded' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 529,
      reason: 'capacity-overload',
    });
  });

  it('preserves SSE transport when classifying 529 capacity overload', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/529\ndata:{"request_id":"req-1","code":"Overloaded","message":"Provider overloaded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 529,
      providerCode: 'Overloaded',
      providerMessage: 'Provider overloaded',
      requestId: 'req-1',
      reason: 'capacity-overload',
    });
  });

  it('classifies non-rate-limit 5xx errors as retryable server errors', () => {
    expect(
      classifyRetryError({ status: 500, message: 'Internal error' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 500,
      reason: 'server-error',
    });
  });

  it('keeps non-error HTTP statuses and invalid status fields unknown', () => {
    expect(
      classifyRetryError({ status: 302, message: 'Redirect' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'unknown',
      statusCode: 302,
      reason: 'http-status',
    });

    expect(
      classifyRetryError({ status: 700, message: 'Invalid status' }),
    ).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('classifies transport timeout errors as retryable', () => {
    const error = Object.assign(new Error('socket timed out'), {
      code: 'ETIMEDOUT',
    });

    const classification = classifyRetryError(error);

    expect(classification).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ETIMEDOUT',
      reason: 'transport-error',
    });
    expect(classification).not.toHaveProperty('providerCode');
  });

  it('classifies transport codes from Error causes as retryable', () => {
    const error = new Error('request failed', {
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ECONNRESET',
      reason: 'transport-error',
    });
  });

  it('prefers a transport cause over an HTTP status when both are present', () => {
    // An SDK error can surface an HTTP status while its underlying cause is a
    // socket-level failure. The transport cause is the more fundamental
    // classification and wins, with the HTTP status reported as secondary.
    const error = Object.assign(new Error('upstream failed'), {
      status: 500,
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ECONNRESET',
      statusCode: 500,
      reason: 'transport-error',
    });
  });

  it('keeps a definitive 4xx status authoritative over a transport cause', () => {
    // A 401 that also carries a socket-level cause must stay fail-fast: the
    // server reached a verdict, so a transient cause must not relabel it
    // retryable.
    const error = Object.assign(new Error('unauthorized'), {
      status: 401,
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });
  });

  it('classifies allocated-quota errors from direct properties as fail-fast', () => {
    expect(
      classifyRetryError({
        status: 429,
        code: 'Throttling.AllocationQuota',
        message: 'Allocated quota exceeded',
      }),
    ).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      reason: 'allocated-quota-exceeded',
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
    });
  });

  it('does not echo a numeric HTTP-status code as providerCode', () => {
    // `{ status: 429, code: 429 }` is just the HTTP status repeated; it must not
    // surface as a provider-specific code.
    const classification = classifyRetryError({
      status: 429,
      code: 429,
      message: 'Too Many Requests',
    });

    expect(classification.statusCode).toBe(429);
    expect(classification).not.toHaveProperty('providerCode');
  });

  it('does not treat generic SDK error codes as transport retry errors', () => {
    const classification = classifyRetryError(
      Object.assign(new Error('invalid request'), {
        code: 'ERR_BAD_REQUEST',
      }),
    );

    expect(classification).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
    expect(classification).not.toHaveProperty('providerCode');
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('extracts provider fields from Error instances with direct SDK properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      code: 'Throttling.Custom',
      request_id: 'req-direct-error',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      providerCode: 'Throttling.Custom',
      providerMessage: 'Provider-specific throttle',
      requestId: 'req-direct-error',
      reason: 'unclassified',
    });
  });

  it('does not copy unparsed SSE frames into providerMessage', () => {
    const classification = classifyRetryError(
      new Error('id:1\nevent:error\n:HTTP_STATUS/429\ndata:not-json'),
    );

    expect(classification).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 429,
      reason: 'rate-limit',
    });
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('marks abort errors as fail-fast', () => {
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'abort',
      diagnosis: 'fail-fast',
      reason: 'aborted',
    });
  });

  it('marks axios-style canceled errors as fail-fast aborts', () => {
    const error = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ECONNABORTED',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'abort',
      diagnosis: 'fail-fast',
      reason: 'aborted',
    });
  });
});
