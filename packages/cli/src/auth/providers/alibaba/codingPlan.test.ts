/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_CHINA_BASE_URL,
  codingPlanProvider,
  createCodingPlanInstallPlan,
  getCodingPlanConfig,
} from './codingPlan.js';

describe('coding plan provider', () => {
  it('creates a Coding Plan install plan', () => {
    const config = getCodingPlanConfig(CODING_PLAN_CHINA_BASE_URL);
    const plan = createCodingPlanInstallPlan({
      apiKey: 'sk-coding',
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
    });

    expect(plan.providerId).toBe('coding-plan');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ [config.envKey]: 'sk-coding' });
    expect(plan.modelSelection).toEqual({ modelId: config.template[0].id });
    expect(plan.modelProviders).toEqual([
      {
        authType: AuthType.USE_OPENAI,
        models: config.template.map((model) => ({
          ...model,
          envKey: config.envKey,
        })),
        mergeStrategy: 'prepend-and-remove-owned',
      },
    ]);
    expect(plan.providerState).toEqual({
      codingPlan: {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version: config.version,
      },
    });
  });

  it('owns Coding Plan models', () => {
    const config = getCodingPlanConfig(CODING_PLAN_CHINA_BASE_URL);

    expect(
      codingPlanProvider.ownsModel?.({
        id: 'coding-model',
        baseUrl: config.baseUrl,
        envKey: config.envKey,
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
