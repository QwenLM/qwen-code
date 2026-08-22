/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AuthType,
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  codingPlanProvider,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
} from '@qwen-code/qwen-code-core';

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

    expect(
      template.find((model) => model.id === 'qwen3.5-plus')?.generationConfig
        ?.modalities,
    ).toEqual({ image: true, video: true });
    expect(version).toBe(
      '7eeb6cbf66d95c6a12e6857d249165767a5d83259e7f390ab95f6bc717fdad51',
    );

    const plan = buildInstallPlan(codingPlanProvider, {
      baseUrl,
      apiKey: 'sk-coding',
      modelIds: getDefaultModelIds(codingPlanProvider),
    });

    expect(plan.providerId).toBe('coding-plan');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ [CODING_PLAN_ENV_KEY]: 'sk-coding' });
    expect(plan.modelSelection).toEqual({ modelId: template[0].id });
    expect(plan.modelProviders?.[0]).toMatchObject({
      authType: AuthType.USE_OPENAI,
      mergeStrategy: 'prepend-and-remove-owned',
      ownsModel: expect.any(Function),
    });
    expect(plan.modelProviders?.[0]?.models).toEqual(
      template.map(({ generationConfig, ...model }) => {
        const { modalities: _modalities, ...remainingConfig } =
          generationConfig ?? {};
        return {
          ...model,
          envKey: CODING_PLAN_ENV_KEY,
          ...(Object.keys(remainingConfig).length > 0
            ? { generationConfig: remainingConfig }
            : {}),
        };
      }),
    );
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
