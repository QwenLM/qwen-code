/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PROVIDERS,
  AuthType,
  type ProviderConfig,
} from '@qwen-code/qwen-code-core';
import type { ServeAuthProviderBaseUrlOption } from '../types.js';
import { buildAuthProviderCatalog } from './auth-provider-helpers.js';

describe('buildAuthProviderCatalog', () => {
  it('serializes endpoint-specific Kimi models', () => {
    const catalog = buildAuthProviderCatalog('/workspace');
    const kimi = catalog.providers.find((provider) => provider.id === 'kimi');

    expect(kimi?.envKey).toBe('KIMI_CODE_API_KEY');
    expect(kimi?.documentationUrl).toBe('https://www.kimi.com/code/docs/en/');
    expect(kimi?.models?.map((model) => model.id)).toEqual([
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);

    const options = kimi?.baseUrl as ServeAuthProviderBaseUrlOption[];
    expect(options).toHaveLength(3);
    expect(options[0]?.envKey).toBe('KIMI_CODE_API_KEY');
    expect(options[1]?.envKey).toBe('MOONSHOT_API_KEY');
    expect(options[2]?.envKey).toBe('MOONSHOT_API_KEY');
    expect(options[0]?.models?.map((model) => model.id)).toEqual([
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(options[0]?.models?.[0]).toEqual({
      id: 'k3-256k',
      contextWindowSize: 262144,
      modalities: { image: true },
    });
    expect(options[1]?.models?.map((model) => model.id)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);
    expect(options[2]?.models).toEqual(options[1]?.models);
  });

  it('populates endpoint-specific env keys for Xiaomi MiMo', () => {
    const catalog = buildAuthProviderCatalog('/workspace');
    const xiaomi = catalog.providers.find(
      (provider) => provider.id === 'xiaomi-mimo',
    );

    expect(xiaomi?.envKey).toBe('MIMO_API_KEY');
    expect(xiaomi?.documentationUrl).toBe(
      'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call',
    );
    const options = xiaomi?.baseUrl as ServeAuthProviderBaseUrlOption[];
    expect(options).toHaveLength(4);
    expect(options[0]?.envKey).toBe('MIMO_API_KEY');
    expect(options[1]?.envKey).toBe('MIMO_TOKEN_PLAN_API_KEY');
    expect(options[2]?.envKey).toBe('MIMO_TOKEN_PLAN_API_KEY');
    expect(options[3]?.envKey).toBe('MIMO_TOKEN_PLAN_API_KEY');
    // The options carry no per-option models; the descriptor's top-level
    // models fall back to the provider-wide list and seed the Web Shell
    // models field.
    for (const option of options) {
      expect(option.models).toBeUndefined();
    }
    expect(xiaomi?.models?.map((model) => model.id)).toEqual([
      'mimo-v2.5-pro',
      'mimo-v2.5',
    ]);
  });

  it('does not synthesize an environment key before a custom endpoint is entered', () => {
    const catalog = buildAuthProviderCatalog('/workspace');
    const custom = catalog.providers.find(
      (provider) => provider.id === 'custom-openai-compatible',
    );

    expect(custom?.baseUrl).toBeUndefined();
    expect(custom?.envKey).toBeUndefined();
  });

  it('omits derived fields instead of failing the catalog when a provider throws', () => {
    const throwingProvider: ProviderConfig = {
      id: 'throwing-provider',
      label: 'Throwing Provider',
      description: 'Throws while deriving env key and documentation URL',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'main',
          label: 'Main',
          url: 'https://throwing.example/v1',
        },
      ],
      envKey: () => {
        throw new Error('broken env key');
      },
      documentationUrl: () => {
        throw new Error('broken documentation URL');
      },
      modelsEditable: true,
      modelNamePrefix: 'Throwing',
      uiGroup: 'third-party',
    };

    const mutableProviders = ALL_PROVIDERS as ProviderConfig[];
    mutableProviders.unshift(throwingProvider);
    try {
      const catalog = buildAuthProviderCatalog('/workspace');

      const throwing = catalog.providers.find(
        (provider) => provider.id === 'throwing-provider',
      );
      expect(throwing).toBeDefined();
      expect(throwing?.envKey).toBeUndefined();
      expect(throwing?.documentationUrl).toBeUndefined();
      const options = throwing?.baseUrl as ServeAuthProviderBaseUrlOption[];
      expect(options[0]?.envKey).toBeUndefined();

      // Sibling providers keep their derived fields.
      const kimi = catalog.providers.find((provider) => provider.id === 'kimi');
      expect(kimi?.envKey).toBe('KIMI_CODE_API_KEY');
    } finally {
      expect(mutableProviders.shift()).toBe(throwingProvider);
    }
  });
});
