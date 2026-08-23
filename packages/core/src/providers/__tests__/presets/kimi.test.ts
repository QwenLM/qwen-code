/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PROVIDERS,
  AuthType,
  KIMI_API_ENV_KEY,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_ENV_KEY,
  PROVIDER_METADATA_NS,
  THIRD_PARTY_PROVIDERS,
  buildProviderTemplate,
  buildInstallPlan,
  computeModelListVersion,
  findProviderByCredentials,
  findProviderById,
  getAllProviderBaseUrls,
  kimiProvider,
  normalizeBaseUrlForMatching,
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
  },
];

describe('kimiProvider', () => {
  it('normalizes malformed and trailing-slash endpoint values safely', () => {
    expect(normalizeBaseUrlForMatching(null as unknown as string)).toBe('');

    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: `${KIMI_CODE_BASE_URL}/`,
      apiKey: 'sk-kimi-code',
      modelIds: ['k3-256k'],
    });
    expect(plan.env).toEqual({ [KIMI_CODE_ENV_KEY]: 'sk-kimi-code' });
    expect(plan.modelProviders?.[0]?.models?.[0]?.envKey).toBe(
      KIMI_CODE_ENV_KEY,
    );
    // The trailing slash must not reach any persisted output: a variant
    // baseUrl would never match the canonical template's version hash.
    expect(plan.modelProviders?.[0]?.models?.[0]?.baseUrl).toBe(
      KIMI_CODE_BASE_URL,
    );
    expect(plan.modelSelection).toEqual({
      modelId: 'k3-256k',
      baseUrl: KIMI_CODE_BASE_URL,
    });
    expect(
      plan.providerState?.[`${PROVIDER_METADATA_NS}.kimi--coding-plan`],
    ).toMatchObject({ baseUrl: KIMI_CODE_BASE_URL });

    expect(typeof kimiProvider.documentationUrl).toBe('function');
    const documentationUrl = kimiProvider.documentationUrl as (
      baseUrl: string,
    ) => string;
    expect(documentationUrl(`${KIMI_CODE_BASE_URL}/`)).toBe(
      'https://www.kimi.com/code/docs/en/',
    );
    expect(documentationUrl('https://api.moonshot.cn/v1/')).toBe(
      'https://platform.kimi.com/docs/api/overview',
    );
    expect(documentationUrl('https://api.moonshot.ai/v1/')).toBe(
      'https://platform.kimi.ai/docs/api/overview',
    );
  });

  it('offers one provider with Coding Plan and regional API choices', () => {
    expect(kimiProvider).toMatchObject({
      id: 'kimi',
      label: 'Kimi',
      protocol: AuthType.USE_OPENAI,
      modelsEditable: true,
      mergeModelsByIdentity: true,
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
    expect(
      plan.modelProviders?.[0]?.models.map(({ id, generationConfig }) => ({
        id,
        generationConfig,
      })),
    ).toEqual([
      {
        id: 'k3-256k',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 262144,
          modalities: { image: true },
        },
      },
      {
        id: 'k3',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 1048576,
          modalities: { image: true, video: true },
        },
      },
      {
        id: 'kimi-for-coding',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 262144,
          modalities: { image: true, video: true },
        },
      },
      {
        id: 'kimi-for-coding-highspeed',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 262144,
          modalities: { image: true, video: true },
        },
      },
    ]);
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
    expect(
      plan.modelProviders?.[0]?.models.map(({ id, generationConfig }) => ({
        id,
        generationConfig,
      })),
    ).toEqual([
      {
        id: 'kimi-k3',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 1048576,
          modalities: { image: true, video: true },
        },
      },
      {
        id: 'kimi-k2.7-code',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 262144,
          modalities: { image: true, video: true },
        },
      },
      {
        id: 'kimi-k2.7-code-highspeed',
        generationConfig: {
          thinkingMandatory: true,
          contextWindowSize: 262144,
          modalities: { image: true, video: true },
        },
      },
      {
        id: 'kimi-k2.6',
        generationConfig: {
          contextWindowSize: 262144,
        },
      },
    ]);
  });

  it('uses identity-scoped patches so Code and API installs can coexist', () => {
    const codePlan = buildInstallPlan(kimiProvider, {
      baseUrl: KIMI_CODE_BASE_URL,
      apiKey: 'sk-code',
      modelIds: ['k3-256k'],
    });
    const apiPlan = buildInstallPlan(kimiProvider, {
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-api',
      modelIds: ['kimi-k3'],
    });

    const codeOwnsModel = codePlan.modelProviders?.[0]?.ownsModel;
    const apiOwnsModel = apiPlan.modelProviders?.[0]?.ownsModel;
    expect(codeOwnsModel).toBeDefined();
    expect(apiOwnsModel).toBeDefined();
    expect(
      codeOwnsModel?.({
        id: 'old-code',
        name: '[Kimi Code] old-code',
        baseUrl: KIMI_CODE_BASE_URL,
        envKey: KIMI_CODE_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      codeOwnsModel?.({
        id: 'sibling-api',
        name: '[Kimi API] sibling-api',
        baseUrl: 'https://api.moonshot.ai/v1',
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      apiOwnsModel?.({
        id: 'old-api',
        name: '[Kimi API] old-api',
        baseUrl: 'https://api.moonshot.ai/v1',
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(true);
    expect(codePlan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'k3-256k',
      baseUrl: KIMI_CODE_BASE_URL,
      envKey: KIMI_CODE_ENV_KEY,
    });
    expect(apiPlan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'kimi-k3',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: KIMI_API_ENV_KEY,
    });
  });

  it('scopes ownsModel by endpoint across same-envKey API regions', () => {
    // api-china and api-international share MOONSHOT_API_KEY, the [Kimi API]
    // name prefix, and identical model lists — an envKey-scoped ownsModel
    // would classify one region's models as the other's and let a resubmit
    // delete them.
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const intlPlan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'sk-api',
      modelIds: ['kimi-k3'],
    });
    const intlOwnsModel = intlPlan.modelProviders?.[0]?.ownsModel;
    expect(intlOwnsModel).toBeDefined();
    expect(
      intlOwnsModel?.({
        id: 'kimi-k3',
        name: '[Kimi API] kimi-k3',
        baseUrl: chinaUrl,
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      intlOwnsModel?.({
        id: 'kimi-k3',
        name: '[Kimi API] kimi-k3',
        baseUrl: intlUrl,
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('persists the template version even when the selection differs', () => {
    const baseUrl = 'https://api.moonshot.cn/v1';
    const template = buildProviderTemplate(kimiProvider, baseUrl);
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl,
      apiKey: 'sk-kimi',
      // Deselect one default and add a custom id — the stored version must
      // still agree with the template hash the update check computes.
      modelIds: [...template.slice(1).map((model) => model.id), 'my-custom'],
    });

    expect(plan.providerState).toEqual({
      'providerMetadata.kimi--api-china': {
        baseUrl,
        version: computeModelListVersion(template),
      },
    });
  });

  it.each([
    ['https://api.kimi.com/coding/v1', 'kimi--coding-plan'],
    ['https://api.moonshot.cn/v1', 'kimi--api-china'],
    ['https://api.moonshot.ai/v1', 'kimi--api-international'],
  ])(
    'records endpoint-scoped provider state for %s',
    (baseUrl, metadataKey) => {
      const template = buildProviderTemplate(kimiProvider, baseUrl);
      const plan = buildInstallPlan(kimiProvider, {
        baseUrl,
        apiKey: 'sk-kimi',
        modelIds: template.map((model) => model.id),
      });

      expect(plan.providerState).toEqual({
        [`providerMetadata.${metadataKey}`]: {
          baseUrl,
          version: computeModelListVersion(template),
        },
      });
    },
  );

  it('owns installed models in both credential domains', () => {
    expect(
      kimiProvider.ownsModel?.({
        id: 'k3-256k',
        name: '[Kimi Code] k3-256k',
        baseUrl: KIMI_CODE_BASE_URL,
        envKey: KIMI_CODE_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      kimiProvider.ownsModel?.({
        id: 'kimi-k3',
        name: '[Kimi API] kimi-k3',
        baseUrl: 'https://api.moonshot.ai/v1',
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(true);
    expect(
      kimiProvider.ownsModel?.({
        id: 'kimi-k3',
        name: '[Kimi API] kimi-k3',
        baseUrl: 'https://api.moonshot.cn/v1',
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership for cross-paired names and env keys', () => {
    expect(
      kimiProvider.ownsModel?.({
        id: 'kimi-k3',
        name: '[Kimi API] kimi-k3',
        baseUrl: 'https://api.moonshot.ai/v1',
        envKey: KIMI_CODE_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      kimiProvider.ownsModel?.({
        id: 'k3-256k',
        name: '[Kimi Code] k3-256k',
        baseUrl: KIMI_CODE_BASE_URL,
        envKey: KIMI_API_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('refuses ownership for unrelated env keys or missing names', () => {
    expect(
      kimiProvider.ownsModel?.({
        id: 'user-model',
        name: '[Kimi Code] user-model',
        baseUrl: KIMI_CODE_BASE_URL,
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
    expect(
      kimiProvider.ownsModel?.({
        id: 'k3-256k',
        baseUrl: KIMI_CODE_BASE_URL,
        envKey: KIMI_CODE_ENV_KEY,
      }),
    ).toBe(false);
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
