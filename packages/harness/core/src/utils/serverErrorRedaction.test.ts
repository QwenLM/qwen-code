/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { format } from 'node:util';
import { buildApiErrorDetails } from '../protocol/provider/qoder-api-error.js';
import { redactServerErrorText } from './serverErrorRedaction.js';

describe('服务端错误在元数据及日志入口脱敏', () => {
  const secrets = ['sk-live-1234567890abcdef', 'tk-abc', 'tk-def', 'ak-xyz'];
  const body = JSON.stringify({
    code: 'CREDENTIAL_LEAK',
    message: 'Invalid token sk-live-1234567890abcdef in request',
    details: {
      api_key: secrets[0],
      tokens: secrets.slice(1, 3),
      nested: {
        secret: JSON.stringify({ token: secrets[0], api_key: secrets[3] }),
      },
      encoded: JSON.stringify({ api_key: secrets[3] }),
      rows: [{ password: 'synthetic-password' }],
    },
  });

  it('错误元数据及对象格式化输出不含原凭据', () => {
    const details = buildApiErrorDetails({ statusCode: 400, body });
    expect(details.code).toBe('CREDENTIAL_LEAK');
    const output = format(
      Object.assign(new Error('request failed'), { qoderApiError: details }),
    );
    for (const secret of [...secrets, 'synthetic-password']) {
      expect(details.message).not.toContain(secret);
      expect(details.body).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
    expect(JSON.parse(details.body!).details.tokens).toBe('[redacted]');
  });

  it('普通业务 JSON 保留原始格式', () => {
    const message = ' { "code": 401, "msg": "令牌已过期", "success": false } ';
    expect(redactServerErrorText(message)).toBe(message);
  });

  it('多次编码与过深内容不会泄漏凭据', () => {
    let value = JSON.stringify({ token: 'synthetic-secret' });
    for (let i = 0; i < 3; i++) value = JSON.stringify(value);
    expect(redactServerErrorText(value)).not.toContain('synthetic-secret');
    let nested: unknown = { token: 'synthetic-secret' };
    for (let i = 0; i < 20; i++) nested = { child: nested };
    expect(redactServerErrorText(JSON.stringify(nested))).not.toContain(
      'synthetic-secret',
    );
  });
});
