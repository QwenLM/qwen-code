/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { classifyStopFailureError } from './stream-errors.js';
import { EMPTY_ASSISTANT_COMPLETION_CODE } from '../model-request/empty-assistant-completion.js';

describe('classifyStopFailureError', () => {
  it.each([
    'MALFORMED_TOOL_USE',
    'MALFORMED_TOOL_USE_EXHAUSTED',
    'POST_COMPACT_CONTEXT_LIMIT',
  ])('classifies %s as an invalid request', (code) => {
    const err = Object.assign(new Error('malformed tool use'), { code });
    expect(classifyStopFailureError(err)).toBe('invalid_request');
  });

  it('classifies a semantic-empty assistant completion separately from transport failures', () => {
    const err = Object.assign(new Error('model produced no answer'), {
      code: EMPTY_ASSISTANT_COMPLETION_CODE,
    });

    expect(classifyStopFailureError(err)).toBe('empty_response');
  });

  it.each([
    ['oauth_org_not_allowed', { code: 'oauth_org_not_allowed' }],
    ['overloaded', { code: 'overloaded', status: 529 }],
    ['model_not_found', { name: 'ModelNotFoundError', code: 404 }],
    ['rate_limit', { code: 'rate_limit_error', status: 429 }],
    ['authentication_failed', { code: 'authentication_error', status: 401 }],
    ['authentication_failed', { status: 403 }],
    ['billing_error', { code: 'billing_error', status: 402 }],
    ['max_output_tokens', { code: 'max_output_tokens' }],
    ['invalid_request', { code: 'invalid_request_error', status: 400 }],
    ['server_error', { code: 'server_error', status: 503 }],
  ] as const)(
    'classifies structured provider failures as %s',
    (expected, fields) => {
      const err = Object.assign(new Error('provider request failed'), fields);
      expect(classifyStopFailureError(err)).toBe(expected);
    },
  );

  it('classifies HTTP 529 as overloaded before generic server errors', () => {
    const err = Object.assign(new Error('request failed'), { status: 529 });
    expect(classifyStopFailureError(err)).toBe('overloaded');
  });

  it('returns unknown when no supported category matches', () => {
    expect(classifyStopFailureError(new Error('socket closed'))).toBe(
      'unknown',
    );
  });
  it.each([
    [502, 'server_error'],
    [400, 'invalid_request'],
    [401, 'authentication_failed'],
    [403, 'authentication_failed'],
    [429, 'rate_limit'],
    [529, 'overloaded'],
  ] as const)('结构化状态 %s 不被内层错误文本覆盖', (status, expected) => {
    const err = Object.assign(
      new Error('{"code":401,"message":"authentication 429 overloaded 400"}'),
      {
        status,
        qoderApiError: { code: 'OUTER_BUSINESS_SSE' },
      },
    );
    expect(classifyStopFailureError(err)).toBe(expected);
  });

  it('明确认证类型优先于通用服务端状态', () => {
    const err = Object.assign(new Error('server error'), {
      code: 'authentication_error',
      status: 502,
    });
    expect(classifyStopFailureError(err)).toBe('authentication_failed');
  });

  it('登录过期业务码仍归类为认证失败', () => {
    const err = Object.assign(new Error('expired'), {
      qoderApiError: { code: '105' },
    });
    expect(classifyStopFailureError(err)).toBe('authentication_failed');
  });

  it('未知业务码不从任意说明猜测认证失败', () => {
    const err = Object.assign(new Error('nested 401 authentication'), {
      qoderApiError: { code: 'CUSTOM_ERROR' },
    });
    expect(classifyStopFailureError(err)).toBe('unknown');
  });

  it('无结构化信息时兼容旧文本分类', () => {
    expect(classifyStopFailureError(new Error('request failed: 401'))).toBe(
      'authentication_failed',
    );
  });
});
