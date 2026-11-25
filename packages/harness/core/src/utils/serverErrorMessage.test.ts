/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getServerErrorMessage } from './serverErrorMessage.js';
import { normalizeSdkErrorResult } from './errorPresentation.js';
import { buildApiErrorDetails } from '../protocol/provider/qoder-api-error.js';

describe('服务端原始错误说明', () => {
  it.each(['qoderApiError', 'providerError'])(
    '保留 %s 说明，展示包装不改变原文',
    (key) => {
      const message =
        '  [quota] 当前模型暂不可用，请切换模型。\nRetry later.  ';
      const error = new Error('Localized CLI text', {
        cause: { [key]: { message } },
      });
      const result = normalizeSdkErrorResult(
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          error_code: 101400,
          errors: ['Localized CLI text'],
        },
        error,
      );
      expect(result).toEqual({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error_code: 101400,
        errors: ['Localized CLI text'],
        error_message: message,
      });
      expect(normalizeSdkErrorResult(result)).toEqual(result);
    },
  );

  it('提取服务端解析后的 message，不携带响应 body', () => {
    const provider = buildApiErrorDetails({
      statusCode: 400,
      body: JSON.stringify({
        code: 101400,
        message: 'Business rejection',
        diagnostic: 'private detail',
      }),
    });
    expect(getServerErrorMessage({ qoderApiError: provider })).toBe(
      'Business rejection',
    );
  });

  it.each([
    new Error('local error /private/workspace'),
    { message: 'local error' },
    { qoderApiError: { message: '' } },
    { qoderApiError: { message: '   ' } },
    { qoderApiError: { message: { secret: 'private' } } },
    { qoderApiError: { body: '{"message":"body only"}' } },
  ])('缺少可透传的结构化说明时省略字段：%j', (error) => {
    expect(getServerErrorMessage(error)).toBeUndefined();
    expect(
      normalizeSdkErrorResult(
        {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['CLI text'],
        },
        error,
      ),
    ).not.toHaveProperty('error_message');
  });

  it('脱敏凭据，保留业务文字', () => {
    const message =
      'Denied: Bearer example-token; token=private-token; "password":"private-password"; "passkey":"private-passkey"\nCookie: session=private-cookie';
    const actual = getServerErrorMessage({ providerError: { message } });
    expect(actual).toContain('Denied:');
    for (const secret of [
      'example-token',
      'private-token',
      'private-password',
      'private-passkey',
      'private-cookie',
    ]) {
      expect(actual).not.toContain(secret);
    }
  });

  it('取消和循环 cause 不泄漏说明或阻塞', () => {
    const error = Object.assign(new Error('Operation aborted'), {
      name: 'AbortError',
      providerError: { message: 'stale failure' },
    });
    expect(getServerErrorMessage(error)).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(getServerErrorMessage(cyclic)).toBeUndefined();
  });
});

it('JSON 说明保持原文，嵌套对象及编码字符串中的凭据递归脱敏', () => {
  const original =
    ' {"code":401, "msg":"令牌已过期或验证不正确", "success":false} ';
  expect(getServerErrorMessage({ providerError: { message: original } })).toBe(
    original,
  );
  const message = JSON.stringify({
    code: 401,
    token: 'private-token',
    nested: [
      { password: 'private-password' },
      JSON.stringify({ refresh_token: 'private-refresh' }),
    ],
  });
  const clean = getServerErrorMessage({ providerError: { message } })!;
  expect(JSON.parse(clean)).toEqual({
    code: 401,
    token: '[redacted]',
    nested: [
      { password: '[redacted]' },
      JSON.stringify({ refresh_token: '[redacted]' }),
    ],
  });
});


it('多次 JSON 编码的说明仍脱敏凭据', () => {
  const message = JSON.stringify(JSON.stringify({ token: 'private-token', code: 401 }));
  const clean = getServerErrorMessage({ providerError: { message } })!;
  expect(JSON.parse(JSON.parse(clean))).toEqual({ token: '[redacted]', code: 401 });
});
