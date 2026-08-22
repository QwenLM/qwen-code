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
  buildProviderTemplate,
  buildInstallPlan,
  computeModelListVersion,
  findProviderByCredentials,
  findProviderById,
  getAllProviderBaseUrls,
  resolveMetadataKey,
  xiaomiMimoProvider,
} from '@qwen-code/qwen-code-core';

describe('xiaomiMimoProvider', () => {
  it('offers pay-as-you-go and regional Token Plan endpoints', () => {
    expect(xiaomiMimoProvider).toMatchObject({
      id: 'xiaomi-mimo',
      label: 'Xiaomi MiMo API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: expect.any(Function),
      apiKeyPlaceholder: 'sk-... or tp-...',
      modelsEditable: true,
      mergeModelsByIdentity: true,
      uiGroup: 'third-party',
    });

    expect(xiaomiMimoProvider.baseUrl).toEqual([
      expect.objectContaining({
        id: 'pay-as-you-go',
        url: 'https://api.xiaomimimo.com/v1',
      }),
      expect.objectContaining({
        id: 'token-plan-china',
        url: 'https://token-plan-cn.xiaomimimo.com/v1',
      }),
      expect.objectContaining({
        id: 'token-plan-singapore',
        url: 'https://token-plan-sgp.xiaomimimo.com/v1',
      }),
      expect.objectContaining({
        id: 'token-plan-europe',
        url: 'https://token-plan-ams.xiaomimimo.com/v1',
      }),
    ]);
  });

  it('uses current MiMo V2.5 model metadata', () => {
    expect(xiaomiMimoProvider.models).toEqual([
      { id: 'mimo-v2.5-pro', contextWindowSize: 1048576 },
      {
        id: 'mimo-v2.5',
        contextWindowSize: 1048576,
        modalities: { image: true, video: true, audio: true },
      },
    ]);
  });

  it('creates an install plan consumed by the existing MiMo adapter', () => {
    const plan = buildInstallPlan(xiaomiMimoProvider, {
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      apiKey: 'tp-mimo',
      modelIds: ['mimo-v2.5-pro', 'mimo-v2.5'],
    });

    expect(plan.env).toEqual({ MIMO_TOKEN_PLAN_API_KEY: 'tp-mimo' });
    expect(plan.modelProviders?.[0]).toMatchObject({
      retainCurrentModelAcrossEndpoints: true,
      ownsModel: expect.any(Function),
      ownsModelAcrossEndpoints: expect.any(Function),
    });
    expect(plan.modelProviders?.[0]?.models).toEqual([
      expect.objectContaining({
        id: 'mimo-v2.5-pro',
        name: '[Xiaomi MiMo] mimo-v2.5-pro',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        envKey: 'MIMO_TOKEN_PLAN_API_KEY',
        generationConfig: { contextWindowSize: 1048576 },
      }),
      expect.objectContaining({
        id: 'mimo-v2.5',
        generationConfig: {
          contextWindowSize: 1048576,
          modalities: { image: true, video: true, audio: true },
        },
      }),
    ]);
  });

  it('keeps pay-as-you-go and Token Plan credentials separate', () => {
    const payGoPlan = buildInstallPlan(xiaomiMimoProvider, {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'sk-mimo',
      modelIds: ['mimo-v2.5-pro'],
    });
    const tokenPlan = buildInstallPlan(xiaomiMimoProvider, {
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: 'tp-mimo',
      modelIds: ['mimo-v2.5-pro'],
    });

    expect(payGoPlan.env).toEqual({ MIMO_API_KEY: 'sk-mimo' });
    expect(tokenPlan.env).toEqual({
      MIMO_TOKEN_PLAN_API_KEY: 'tp-mimo',
    });
  });

  it.each([
    'https://api.xiaomimimo.com/v1',
    'https://token-plan-cn.xiaomimimo.com/v1',
    'https://token-plan-sgp.xiaomimimo.com/v1',
    'https://token-plan-ams.xiaomimimo.com/v1',
  ])('records endpoint-scoped provider state for %s', (baseUrl) => {
    const template = buildProviderTemplate(xiaomiMimoProvider, baseUrl);
    const plan = buildInstallPlan(xiaomiMimoProvider, {
      baseUrl,
      apiKey: 'sk-mimo',
      modelIds: template.map((model) => model.id),
    });

    expect(plan.providerState).toEqual({
      [`providerMetadata.${resolveMetadataKey(xiaomiMimoProvider, baseUrl)}`]: {
        baseUrl,
        version: computeModelListVersion(template),
      },
    });
  });

  it('is registered and discoverable by credentials', () => {
    expect(findProviderById('xiaomi-mimo')).toBe(xiaomiMimoProvider);
    expect(ALL_PROVIDERS).toContain(xiaomiMimoProvider);
    expect(THIRD_PARTY_PROVIDERS).toContain(xiaomiMimoProvider);
    expect(getAllProviderBaseUrls()).toEqual(
      expect.arrayContaining([
        'https://api.xiaomimimo.com/v1',
        'https://token-plan-cn.xiaomimimo.com/v1',
        'https://token-plan-sgp.xiaomimimo.com/v1',
        'https://token-plan-ams.xiaomimimo.com/v1',
      ]),
    );
    expect(
      findProviderByCredentials(
        'https://token-plan-ams.xiaomimimo.com/v1',
        'MIMO_TOKEN_PLAN_API_KEY',
      ),
    ).toBe(xiaomiMimoProvider);
  });
});
