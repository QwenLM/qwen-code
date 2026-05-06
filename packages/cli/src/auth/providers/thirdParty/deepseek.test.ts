/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DEEPSEEK_API_KEY_PROVIDER } from './deepseek.js';

describe('DEEPSEEK_API_KEY_PROVIDER', () => {
  it('is a declarative API-key provider descriptor', () => {
    expect(DEEPSEEK_API_KEY_PROVIDER).toEqual({
      id: 'deepseek',
      option: 'DEEPSEEK_API_KEY',
      title: 'DeepSeek API Key',
      description:
        'Quick setup for DeepSeek (deepseek-v4-flash, deepseek-v4-pro)',
      envKey: 'DEEPSEEK_API_KEY',
      modelNamePrefix: 'DeepSeek',
      endpoint: 'https://api.deepseek.com',
      defaultModelIds: 'deepseek-v4-flash,deepseek-v4-pro',
      documentationUrl: 'https://api-docs.deepseek.com/zh-cn/',
    });
  });
});
