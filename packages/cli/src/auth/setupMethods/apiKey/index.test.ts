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

  it('creates an install plan for a selected provider endpoint', () => {
    const plan = createApiKeyProviderInstallPlan({
      provider: API_KEY_PROVIDERS.zai,
      apiKey: 'sk-zai',
      modelIds: ['glm-4.6'],
      region: 'coding-plan',
    });

    expect(plan.modelProviders?.[0]?.models).toEqual([
      {
        id: 'glm-4.6',
        name: '[Z.AI] glm-4.6',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        envKey: 'ZAI_API_KEY',
      },
    ]);
  });

  it('creates an install plan for the MiniMax China endpoint', () => {
    const plan = createApiKeyProviderInstallPlan({
      provider: API_KEY_PROVIDERS.minimax,
      apiKey: 'sk-minimax',
      modelIds: ['MiniMax-M2.5'],
      region: 'china',
    });

    expect(plan.modelProviders?.[0]?.models).toEqual([
      {
        id: 'MiniMax-M2.5',
        name: '[MiniMax] MiniMax-M2.5',
        baseUrl: 'https://api.minimaxi.com/v1',
        envKey: 'MINIMAX_API_KEY',
      },
    ]);
  });
});
