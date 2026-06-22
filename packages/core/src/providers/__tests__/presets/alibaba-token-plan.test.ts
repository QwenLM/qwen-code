/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AuthType,
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_BASE_URL,
  tokenPlanProvider,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  providerMatchesCredentials,
} from '@qwen-code/qwen-code-core';

describe('token plan provider', () => {
  it('creates a Token Plan install plan', () => {
    const template = buildProviderTemplate(tokenPlanProvider);
    const version = computeModelListVersion(template);
    const baseUrl = resolveBaseUrl(tokenPlanProvider);

    const plan = buildInstallPlan(tokenPlanProvider, {
      baseUrl,
      apiKey: 'sk-token',
      modelIds: getDefaultModelIds(tokenPlanProvider),
    });

    expect(template.map((model) => model.id)).toEqual([
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.7-max',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v3.2',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'MiniMax-M2.5',
    ]);
    expect(
      template.find((model) => model.id === 'deepseek-v4-pro')
        ?.generationConfig,
    ).toEqual({ contextWindowSize: 1000000 });
    expect(
      template.find((model) => model.id === 'qwen3.6-flash')?.generationConfig,
    ).toEqual({
      extra_body: { enable_thinking: true },
      contextWindowSize: 1000000,
    });
    expect(
      template.find((model) => model.id === 'kimi-k2.6')?.generationConfig,
    ).toEqual({
      extra_body: { enable_thinking: true },
      contextWindowSize: 262144,
    });
    // Plus/2.5 variants are genuinely multimodal and stay that way.
    expect(
      template.find((model) => model.id === 'qwen3.6-plus')?.generationConfig
        ?.modalities,
    ).toEqual({ image: true, video: true });
    expect(
      template.find((model) => model.id === 'kimi-k2.5')?.generationConfig
        ?.modalities,
    ).toEqual({ image: true, video: true });
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
      'providerMetadata.token-plan': {
        baseUrl: TOKEN_PLAN_BASE_URL,
        version,
      },
    });
  });

  it('matches Token Plan credentials', () => {
    expect(
      providerMatchesCredentials(
        tokenPlanProvider,
        TOKEN_PLAN_BASE_URL,
        TOKEN_PLAN_ENV_KEY,
      ),
    ).toBe(true);
    expect(
      providerMatchesCredentials(
        tokenPlanProvider,
        'https://custom.example.com/v1',
        'CUSTOM_API_KEY',
      ),
    ).toBe(false);
  });
});
