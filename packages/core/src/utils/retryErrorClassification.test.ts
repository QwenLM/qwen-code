/**
 * @license
 * Copyright 2025 Google LLC
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
      decision: 'retryable',
      statusCode: 429,
      reason: 'rate-limit',
    });
  });

  it('classifies HTTP 503 as retryable rate limiting to match stream retry semantics', () => {
    expect(
      classifyRetryError({ status: 503, message: 'Provider overloaded' }),
    ).toMatchObject({
      kind: 'http',
      decision: 'retryable',
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
      decision: 'retryable',
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
      decision: 'retryable',
      providerCode: '1305',
      providerMessage: 'IdealTalk rate limit',
      reason: 'rate-limit',
    });
  });

  it('classifies SSE-embedded non-quota 429 errors as retryable rate limiting', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.RateLimit","message":"Rate limit exceeded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      decision: 'retryable',
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
      decision: 'fail-fast',
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
      providerMessage: 'Allocated quota exceeded',
      requestId: 'req-1',
      reason: 'allocated-quota-exceeded',
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
      decision: 'fail-fast',
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
      decision: 'fail-fast',
      statusCode: 400,
      providerCode: 'invalid_request_error',
      reason: 'client-error',
    });
  });

  it('marks auth errors as fail-fast', () => {
    expect(
      classifyRetryError({ status: 401, message: 'Unauthorized' }),
    ).toMatchObject({
      kind: 'http',
      decision: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });
  });

  it('classifies 529 as fallback-eligible capacity overload', () => {
    expect(
      classifyRetryError({ status: 529, message: 'Overloaded' }),
    ).toMatchObject({
      kind: 'http',
      decision: 'fallback-eligible',
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
      decision: 'fallback-eligible',
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
      decision: 'retryable',
      statusCode: 500,
      reason: 'server-error',
    });
  });

  it('keeps non-error HTTP statuses and invalid status fields unknown', () => {
    expect(
      classifyRetryError({ status: 302, message: 'Redirect' }),
    ).toMatchObject({
      kind: 'http',
      decision: 'unknown',
      statusCode: 302,
      reason: 'http-status',
    });

    expect(
      classifyRetryError({ status: 700, message: 'Invalid status' }),
    ).toMatchObject({
      kind: 'unknown',
      decision: 'unknown',
      reason: 'unclassified',
    });
  });

  it('classifies transport timeout errors as retryable', () => {
    const error = Object.assign(new Error('socket timed out'), {
      code: 'ETIMEDOUT',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      decision: 'retryable',
      transportCode: 'ETIMEDOUT',
      reason: 'transport-error',
    });
  });

  it('does not treat generic SDK error codes as transport retry errors', () => {
    expect(
      classifyRetryError(
        Object.assign(new Error('invalid request'), {
          code: 'ERR_BAD_REQUEST',
        }),
      ),
    ).toMatchObject({
      kind: 'unknown',
      decision: 'unknown',
      reason: 'unclassified',
    });
  });

  it('marks abort errors as fail-fast', () => {
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'abort',
      decision: 'fail-fast',
      reason: 'aborted',
    });
  });
});
