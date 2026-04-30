/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  createTokenPlanInstallPlan,
  getTokenPlanConfig,
  tokenPlanProvider,
} from './tokenPlan.js';

describe('token plan provider', () => {
  it('creates a Token Plan install plan', () => {
    const config = getTokenPlanConfig();
    const plan = createTokenPlanInstallPlan({ apiKey: 'sk-token' });

    expect(plan.providerId).toBe('token-plan');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ [config.envKey]: 'sk-token' });
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
      tokenPlan: {
        baseUrl: config.baseUrl,
        version: config.version,
      },
    });
  });

  it('owns Token Plan models', () => {
    const config = getTokenPlanConfig();

    expect(
      tokenPlanProvider.ownsModel?.({
        id: 'token-model',
        baseUrl: config.baseUrl,
        envKey: config.envKey,
      }),
    ).toBe(true);
    expect(
      tokenPlanProvider.ownsModel?.({
        id: 'custom-model',
        baseUrl: 'https://custom.example.com/v1',
        envKey: 'CUSTOM_API_KEY',
      }),
    ).toBe(false);
  });
});
