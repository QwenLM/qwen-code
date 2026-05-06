/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  API_KEY_PROVIDERS,
  createApiKeyLlmProvider,
  createApiKeyProviderInstallPlan,
} from './index.js';

describe('api key provider', () => {
  it('creates an install plan for a preset API key provider', () => {
    const provider = API_KEY_PROVIDERS.deepseek;
    const plan = createApiKeyProviderInstallPlan({
      provider,
      apiKey: 'sk-deepseek',
      modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    });

    expect(plan).toEqual({
      providerId: 'deepseek',
      authType: AuthType.USE_OPENAI,
      env: {
        DEEPSEEK_API_KEY: 'sk-deepseek',
      },
      modelSelection: {
        modelId: 'deepseek-v4-flash',
      },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [
            {
              id: 'deepseek-v4-flash',
              name: '[DeepSeek] deepseek-v4-flash',
              baseUrl: 'https://api.deepseek.com',
              envKey: 'DEEPSEEK_API_KEY',
            },
            {
              id: 'deepseek-v4-pro',
              name: '[DeepSeek] deepseek-v4-pro',
              baseUrl: 'https://api.deepseek.com',
              envKey: 'DEEPSEEK_API_KEY',
            },
          ],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: expect.any(Function),
        },
      ],
    });
  });

  it('owns only the selected preset provider models', () => {
    const provider = createApiKeyLlmProvider(API_KEY_PROVIDERS.deepseek);

    expect(
      provider.ownsModel?.({
        id: 'deepseek-v4-flash',
        name: '[DeepSeek] deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
      }),
    ).toBe(true);
    expect(
      provider.ownsModel?.({
        id: 'custom-deepseek-compatible',
        name: '[Custom] custom-deepseek-compatible',
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
      }),
    ).toBe(false);
  });
});
