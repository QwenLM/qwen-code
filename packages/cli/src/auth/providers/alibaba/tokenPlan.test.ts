/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_BASE_URL,
  tokenPlanProviderConfig,
} from './tokenPlan.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  toLlmProvider,
} from '../../providerConfig.js';

describe('token plan provider', () => {
  it('creates a Token Plan install plan', () => {
    const template = buildProviderTemplate(tokenPlanProviderConfig);
    const version = computeModelListVersion(template);
    const baseUrl = resolveBaseUrl(tokenPlanProviderConfig);

    const plan = buildInstallPlan(tokenPlanProviderConfig, {
      baseUrl,
      apiKey: 'sk-token',
      modelIds: getDefaultModelIds(tokenPlanProviderConfig),
    });

    expect(template.map((model) => model.id)).toEqual([
      'qwen3.6-plus',
      'deepseek-v3.2',
      'glm-5',
      'MiniMax-M2.5',
    ]);
    expect(plan.providerId).toBe('token-plan');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ [TOKEN_PLAN_ENV_KEY]: 'sk-token' });
    expect(plan.modelSelection).toEqual({ modelId: template[0].id });
    expect(plan.modelProviders).toEqual([
      {
        authType: AuthType.USE_OPENAI,
        models: template.map((model) => ({
          ...model,
          envKey: TOKEN_PLAN_ENV_KEY,
        })),
        mergeStrategy: 'prepend-and-remove-owned',
        ownsModel: expect.any(Function),
      },
    ]);
    expect(plan.providerState).toEqual({
      tokenPlan: {
        baseUrl: TOKEN_PLAN_BASE_URL,
        version,
      },
    });
  });

  it('owns Token Plan models', () => {
    const provider = toLlmProvider(tokenPlanProviderConfig);

    expect(
      provider.ownsModel?.({
        id: 'token-model',
        name: '[ModelStudio Token Plan] token-model',
        baseUrl: TOKEN_PLAN_BASE_URL,
        envKey: TOKEN_PLAN_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      provider.ownsModel?.({
        id: 'custom-model',
        name: '[Other] custom-model',
        baseUrl: 'https://custom.example.com/v1',
        envKey: 'CUSTOM_API_KEY',
      }),
    ).toBe(false);
  });
});
