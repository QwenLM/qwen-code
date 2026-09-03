/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { moonshotProvider } from '../../presets/moonshot.js';
import {
  ALL_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  findProviderByCredentials,
  findProviderById,
  getAllProviderBaseUrls,
} from '../../all-providers.js';
import { buildInstallPlan } from '../../provider-config.js';

const INTL_BASE_URL = 'https://api.moonshot.ai/v1';
const CHINA_BASE_URL = 'https://api.moonshot.cn/v1';

describe('moonshotProvider', () => {
  it('has correct provider config', () => {
    expect(moonshotProvider).toMatchObject({
      id: 'moonshot',
      label: 'Kimi (Moonshot AI) API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'MOONSHOT_API_KEY',
      modelNamePrefix: 'Kimi',
      modelsEditable: true,
      uiGroup: 'third-party',
    });
  });

  it('offers international and China endpoints', () => {
    expect(Array.isArray(moonshotProvider.baseUrl)).toBe(true);
    const urls = (moonshotProvider.baseUrl as Array<{ url: string }>).map(
      (o) => o.url,
    );
    expect(urls).toEqual([INTL_BASE_URL, CHINA_BASE_URL]);
  });

  it('is registered and discoverable in the provider registry', () => {
    expect(findProviderById('moonshot')).toBe(moonshotProvider);
    expect(ALL_PROVIDERS).toContain(moonshotProvider);
    expect(THIRD_PARTY_PROVIDERS).toContain(moonshotProvider);
    expect(getAllProviderBaseUrls()).toContain(INTL_BASE_URL);
    expect(getAllProviderBaseUrls()).toContain(CHINA_BASE_URL);
  });

  it('is found by its env key + base URL credentials', () => {
    expect(
      findProviderByCredentials(INTL_BASE_URL, 'MOONSHOT_API_KEY')?.id,
    ).toBe('moonshot');
    expect(
      findProviderByCredentials(CHINA_BASE_URL, 'MOONSHOT_API_KEY')?.id,
    ).toBe('moonshot');
    // Wrong base URL for the right key must not match.
    expect(
      findProviderByCredentials(
        'https://wrong.example.com/v1',
        'MOONSHOT_API_KEY',
      ),
    ).toBeUndefined();
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(moonshotProvider, {
      baseUrl: INTL_BASE_URL,
      apiKey: 'sk-moonshot',
      modelIds: [
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
      ],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(4);

    // K3 always thinks: mandatory, never a plain enable_thinking toggle.
    expect(models?.[0]).toMatchObject({
      id: 'kimi-k3',
      name: '[Kimi] kimi-k3',
      generationConfig: {
        contextWindowSize: 1000000,
        thinkingMandatory: true,
        modalities: { image: true, video: true },
      },
    });
    expect(models?.[0]?.generationConfig?.extra_body).toBeUndefined();

    expect(models?.[1]).toMatchObject({
      id: 'kimi-k2.7-code',
      name: '[Kimi] kimi-k2.7-code',
      generationConfig: {
        contextWindowSize: 262144,
        thinkingMandatory: true,
        modalities: { image: true, video: true },
      },
    });
    expect(models?.[1]?.generationConfig?.thinkingMandatory).toBe(true);

    expect(models?.[2]).toMatchObject({
      id: 'kimi-k2.7-code-highspeed',
      name: '[Kimi] kimi-k2.7-code-highspeed',
      generationConfig: {
        contextWindowSize: 262144,
        thinkingMandatory: true,
        modalities: { image: true, video: true },
      },
    });
    expect(models?.[2]?.generationConfig?.thinkingMandatory).toBe(true);

    expect(models?.[3]).toMatchObject({
      id: 'kimi-k2.6',
      name: '[Kimi] kimi-k2.6',
      generationConfig: {
        contextWindowSize: 262144,
        modalities: { image: true, video: true },
      },
    });
    expect(models?.[3]?.generationConfig?.thinkingMandatory).toBeUndefined();
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(moonshotProvider, {
      baseUrl: CHINA_BASE_URL,
      apiKey: 'sk-moonshot',
      modelIds: ['kimi-k4-preview'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]).toMatchObject({
      id: 'kimi-k4-preview',
      name: '[Kimi] kimi-k4-preview',
    });
    expect(models?.[0]?.generationConfig).toBeUndefined();
  });
});
