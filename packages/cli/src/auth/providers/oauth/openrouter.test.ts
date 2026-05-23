/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  createOpenRouterProviderInstallPlan,
  openRouterProvider,
} from './openrouter.js';

vi.mock('./openrouterOAuth.js', () => ({
  getOpenRouterModelsWithFallback: vi.fn(),
  getPreferredOpenRouterModelId: vi.fn((models) => models[0]?.id),
  OPENROUTER_ENV_KEY: 'OPENROUTER_API_KEY',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  selectRecommendedOpenRouterModels: vi.fn((models) => models.slice(0, 1)),
}));

describe('openRouterProvider', () => {
  it('creates an install plan for recommended OpenRouter models', async () => {
    const plan = await createOpenRouterProviderInstallPlan({
      apiKey: 'or-key',
      models: [
        {
          id: 'z-ai/glm-4.5-air:free',
          name: 'OpenRouter · GLM 4.5 Air',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'anthropic/claude-3.7-sonnet',
          name: 'OpenRouter · Claude 3.7 Sonnet',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
      ],
    });

    expect(plan).toEqual({
      providerId: 'openrouter',
      authType: AuthType.USE_OPENAI,
      env: {
        OPENROUTER_API_KEY: 'or-key',
      },
      modelSelection: {
        modelId: 'z-ai/glm-4.5-air:free',
      },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [
            {
              id: 'z-ai/glm-4.5-air:free',
              name: 'OpenRouter · GLM 4.5 Air',
              baseUrl: 'https://openrouter.ai/api/v1',
              envKey: 'OPENROUTER_API_KEY',
            },
          ],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: expect.any(Function),
        },
      ],
    });
  });

  it('owns models by OpenRouter base URL', () => {
    expect(
      openRouterProvider.ownsModel?.({
        id: 'openrouter-model',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe(true);
    expect(
      openRouterProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toBe(false);
  });
});
