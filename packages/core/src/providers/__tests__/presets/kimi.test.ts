/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PROVIDERS,
  AuthType,
  THIRD_PARTY_PROVIDERS,
  buildInstallPlan,
  findProviderByCredentials,
  findProviderById,
  getAllProviderBaseUrls,
  kimiProvider,
  resolveProviderModels,
} from '@qwen-code/qwen-code-core';

const codingPlanModels = [
  {
    id: 'k3-256k',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true },
  },
  {
    id: 'k3',
    contextWindowSize: 1048576,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-for-coding',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-for-coding-highspeed',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
];

const apiModels = [
  {
    id: 'kimi-k3',
    contextWindowSize: 1048576,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.7-code',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.6',
    contextWindowSize: 262144,
    modalities: { image: true, video: true },
  },
];

describe('kimiProvider', () => {
  it('offers one provider with Coding Plan and regional API choices', () => {
    expect(kimiProvider).toMatchObject({
      id: 'kimi',
      label: 'Kimi',
      protocol: AuthType.USE_OPENAI,
      modelsEditable: true,
      uiGroup: 'third-party',
    });

    expect(kimiProvider.baseUrl).toEqual([
      expect.objectContaining({
        id: 'coding-plan',
        label: 'Coding Plan',
        url: 'https://api.kimi.com/coding/v1',
      }),
      expect.objectContaining({
        id: 'api-china',
        label: 'API Key (China)',
        url: 'https://api.moonshot.cn/v1',
      }),
      expect.objectContaining({
        id: 'api-international',
        label: 'API Key (International)',
        url: 'https://api.moonshot.ai/v1',
      }),
    ]);
  });

  it('resolves Coding Plan models independently from API models', () => {
    expect(
      resolveProviderModels(kimiProvider, 'https://api.kimi.com/coding/v1'),
    ).toEqual(codingPlanModels);
    expect(
      resolveProviderModels(kimiProvider, 'https://api.moonshot.cn/v1'),
    ).toEqual(apiModels);
    expect(
      resolveProviderModels(kimiProvider, 'https://api.moonshot.ai/v1'),
    ).toEqual(apiModels);
  });

  it('creates a Coding Plan install with only Coding Plan models', () => {
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi-code',
      modelIds: codingPlanModels.map((model) => model.id),
    });

    expect(plan.env).toEqual({ KIMI_CODE_API_KEY: 'sk-kimi-code' });
    expect(plan.modelProviders?.[0]?.models).toHaveLength(4);
    expect(plan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'k3-256k',
      name: '[Kimi Code] k3-256k',
      baseUrl: 'https://api.kimi.com/coding/v1',
      envKey: 'KIMI_CODE_API_KEY',
    });
  });

  it('creates an API install with only Kimi API models', () => {
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-kimi-api',
      modelIds: apiModels.map((model) => model.id),
    });

    expect(plan.env).toEqual({ MOONSHOT_API_KEY: 'sk-kimi-api' });
    expect(plan.modelProviders?.[0]?.models).toHaveLength(4);
    expect(plan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
    });
  });

  it('registers a single Kimi entry and discovers every endpoint', () => {
    expect(findProviderById('kimi')).toBe(kimiProvider);
    expect(ALL_PROVIDERS).toContain(kimiProvider);
    expect(THIRD_PARTY_PROVIDERS).toContain(kimiProvider);
    expect(
      THIRD_PARTY_PROVIDERS.filter((provider) => provider.label === 'Kimi'),
    ).toEqual([kimiProvider]);
    expect(getAllProviderBaseUrls()).toEqual(
      expect.arrayContaining([
        'https://api.kimi.com/coding/v1',
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
      ]),
    );
    expect(
      findProviderByCredentials(
        'https://api.moonshot.ai/v1',
        'MOONSHOT_API_KEY',
      ),
    ).toBe(kimiProvider);
    expect(
      findProviderByCredentials(
        'https://api.kimi.com/coding/v1',
        'KIMI_CODE_API_KEY',
      ),
    ).toBe(kimiProvider);
  });
});
