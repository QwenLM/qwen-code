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
  xiaomiMimoProvider,
} from '@qwen-code/qwen-code-core';

describe('xiaomiMimoProvider', () => {
  it('offers pay-as-you-go and regional Token Plan endpoints', () => {
    expect(xiaomiMimoProvider).toMatchObject({
      id: 'xiaomi-mimo',
      label: 'Xiaomi MiMo API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'MIMO_API_KEY',
      apiKeyPlaceholder: 'sk-... or tp-...',
      modelsEditable: true,
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

    expect(plan.env).toEqual({ MIMO_API_KEY: 'tp-mimo' });
    expect(plan.modelProviders?.[0]?.models).toEqual([
      expect.objectContaining({
        id: 'mimo-v2.5-pro',
        name: '[Xiaomi MiMo] mimo-v2.5-pro',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        envKey: 'MIMO_API_KEY',
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
        'MIMO_API_KEY',
      ),
    ).toBe(xiaomiMimoProvider);
  });
});
