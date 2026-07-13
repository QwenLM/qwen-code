/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { grokProvider } from '../../presets/grok.js';
import {
  ALL_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  findProviderByCredentials,
  findProviderById,
  getAllProviderBaseUrls,
} from '../../all-providers.js';
import { buildInstallPlan } from '../../provider-config.js';

describe('grokProvider', () => {
  it('has correct provider config', () => {
    expect(grokProvider).toMatchObject({
      id: 'grok',
      label: 'Grok (xAI) API Key',
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://api.x.ai/v1',
      envKey: 'XAI_API_KEY',
      modelsEditable: true,
      uiGroup: 'third-party',
    });
  });

  it('is registered and discoverable in the provider registry', () => {
    expect(findProviderById('grok')).toBe(grokProvider);
    expect(ALL_PROVIDERS).toContain(grokProvider);
    expect(THIRD_PARTY_PROVIDERS).toContain(grokProvider);
    expect(getAllProviderBaseUrls()).toContain('https://api.x.ai/v1');
  });

  it('is found by its env key + base URL credentials', () => {
    expect(
      findProviderByCredentials('https://api.x.ai/v1', 'XAI_API_KEY')?.id,
    ).toBe('grok');
    // Wrong base URL for the right key must not match.
    expect(
      findProviderByCredentials('https://wrong.example.com/v1', 'XAI_API_KEY'),
    ).toBeUndefined();
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(grokProvider, {
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
      modelIds: ['grok-3', 'grok-4'],
    });

    expect(plan.env).toEqual({ XAI_API_KEY: 'xai-key' });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'grok-3',
      name: '[Grok] grok-3',
      baseUrl: 'https://api.x.ai/v1',
      envKey: 'XAI_API_KEY',
    });
    // Standard OpenAI format: only the context window, no extra_body.
    expect(models?.[0]?.generationConfig).toEqual({
      contextWindowSize: 131072,
    });
    expect(models?.[1]?.generationConfig).toEqual({
      contextWindowSize: 256000,
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(grokProvider, {
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
      modelIds: ['grok-4', 'grok-future'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[1]).toMatchObject({
      id: 'grok-future',
      name: '[Grok] grok-future',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });
});
