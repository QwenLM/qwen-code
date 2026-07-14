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

  it('exposes all xAI chat & code models with their context windows', () => {
    expect(grokProvider.models).toEqual([
      { id: 'grok-4.5', contextWindowSize: 500000 },
      { id: 'grok-4.3', contextWindowSize: 1000000 },
      { id: 'grok-4.20-0309-reasoning', contextWindowSize: 1000000 },
      { id: 'grok-4.20-0309-non-reasoning', contextWindowSize: 1000000 },
      { id: 'grok-4.20-multi-agent-0309', contextWindowSize: 1000000 },
      { id: 'grok-build-0.1', contextWindowSize: 256000 },
    ]);
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
      modelIds: ['grok-4.5', 'grok-4.3'],
    });

    expect(plan.env).toEqual({ XAI_API_KEY: 'xai-key' });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'grok-4.5',
      name: '[Grok] grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      envKey: 'XAI_API_KEY',
    });
    // Standard OpenAI format: only the context window, no extra_body.
    expect(models?.[0]?.generationConfig).toEqual({
      contextWindowSize: 500000,
    });
    expect(models?.[1]?.generationConfig).toEqual({
      contextWindowSize: 1000000,
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(grokProvider, {
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
      modelIds: ['grok-4.5', 'grok-future'],
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
