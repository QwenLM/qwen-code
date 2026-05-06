/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  codingPlanProviderConfig,
} from './codingPlan.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  toLlmProvider,
} from '../../providerConfig.js';

describe('coding plan provider', () => {
  it('creates a Coding Plan install plan', () => {
    const baseUrl = resolveBaseUrl(
      codingPlanProviderConfig,
      CODING_PLAN_CHINA_BASE_URL,
    );
    const template = buildProviderTemplate(
      codingPlanProviderConfig,
      CODING_PLAN_CHINA_BASE_URL,
    );
    const version = computeModelListVersion(template);

    const plan = buildInstallPlan(codingPlanProviderConfig, {
      baseUrl,
      apiKey: 'sk-coding',
      modelIds: getDefaultModelIds(codingPlanProviderConfig),
    });

    expect(plan.providerId).toBe('coding-plan');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ [CODING_PLAN_ENV_KEY]: 'sk-coding' });
    expect(plan.modelSelection).toEqual({ modelId: template[0].id });
    expect(plan.modelProviders).toEqual([
      {
        authType: AuthType.USE_OPENAI,
        models: template.map((model) => ({
          ...model,
          envKey: CODING_PLAN_ENV_KEY,
        })),
        mergeStrategy: 'prepend-and-remove-owned',
        ownsModel: expect.any(Function),
      },
    ]);
    expect(plan.providerState).toEqual({
      codingPlan: {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version,
      },
    });
  });

  it('owns Coding Plan models', () => {
    const provider = toLlmProvider(codingPlanProviderConfig);

    expect(
      provider.ownsModel?.({
        id: 'coding-model',
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        envKey: CODING_PLAN_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      provider.ownsModel?.({
        id: 'custom-model',
        baseUrl: 'https://custom.example.com/v1',
        envKey: 'CUSTOM_API_KEY',
      }),
    ).toBe(false);
  });
});
