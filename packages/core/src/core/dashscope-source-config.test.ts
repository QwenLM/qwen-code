/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildDashScopeSourceConfig,
  withDashScopeSourceConfig,
} from './dashscope-source-config.js';

const CN_PAYG =
  '{"channel":"qianwenai-inner-agents","source":"model","tags":{"t1":"qwen-code","t2":"payg"}}';
const INTL_PAYG =
  '{"channel":"qwencloud-inner-agents","source":"model","tags":{"t1":"qwen-code","t2":"payg"}}';
const CN_TOKEN_PLAN =
  '{"channel":"qianwenai-inner-agents","source":"model","tags":{"t1":"qwen-code"}}';
const INTL_TOKEN_PLAN =
  '{"channel":"qwencloud-inner-agents","source":"model","tags":{"t1":"qwen-code"}}';

describe('buildDashScopeSourceConfig', () => {
  it.each([
    ['https://maas.qianwenaiapi.com/compatible-mode/v1', CN_PAYG],
    ['https://maas.qwencloudapi.com/compatible-mode/v1', INTL_PAYG],
    [
      'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
      CN_TOKEN_PLAN,
    ],
    [
      'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
      INTL_TOKEN_PLAN,
    ],
    ['https://MAAS.QwenCloudAPI.com:443/compatible-mode/v1/', INTL_PAYG],
  ])('attributes %s', (baseUrl, expected) => {
    expect(buildDashScopeSourceConfig(baseUrl)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://api.openai.com/v1',
    'https://maas.qwencloudapi.com.evil.example/v1',
    'https://evil-maas.qwencloudapi.com/v1',
    'https://other.maas.qwencloudapi.com/v1',
    'https://proxy.example/maas.qwencloudapi.com/v1',
  ])('leaves %s unattributed', (baseUrl) => {
    expect(buildDashScopeSourceConfig(baseUrl)).toBeUndefined();
  });
});

describe('withDashScopeSourceConfig', () => {
  it('returns the same headers for an unattributed endpoint', () => {
    const headers = { 'X-DashScope-Source-Config': 'user' };
    expect(
      withDashScopeSourceConfig(headers, 'https://api.openai.com/v1'),
    ).toBe(headers);
  });

  it('replaces a user value in any casing with the first-party one', () => {
    expect(
      withDashScopeSourceConfig(
        { 'User-Agent': 'ua', 'x-dashscope-source-config': 'user' },
        'https://maas.qianwenaiapi.com/compatible-mode/v1',
      ),
    ).toEqual({ 'User-Agent': 'ua', 'X-DashScope-Source-Config': CN_PAYG });
  });
});
