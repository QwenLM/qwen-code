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
  codingPlanProvider,
} from './codingPlan.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
} from '../../providerConfig.js';

describe('coding plan provider', () => {
  it('creates a Coding Plan install plan', () => {
    const baseUrl = resolveBaseUrl(
      codingPlanProvider,
      CODING_PLAN_CHINA_BASE_URL,
    );
    const template = buildProviderTemplate(
      codingPlanProvider,
      CODING_PLAN_CHINA_BASE_URL,
    );
    const version = computeModelListVersion(template);

    const plan = buildInstallPlan(codingPlanProvider, {
      baseUrl,
      apiKey: 'sk-coding',
      modelIds: getDefaultModelIds(codingPlanProvider),
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
      'providerMetadata.coding-plan': {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version,
      },
    });
  });

  it('owns Coding Plan models', () => {
    expect(
      codingPlanProvider.ownsModel?.({
        id: 'coding-model',
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        envKey: CODING_PLAN_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      codingPlanProvider.ownsModel?.({
        id: 'custom-model',
        baseUrl: 'https://custom.example.com/v1',
        envKey: 'CUSTOM_API_KEY',
      }),
    ).toBe(false);
  });
});
