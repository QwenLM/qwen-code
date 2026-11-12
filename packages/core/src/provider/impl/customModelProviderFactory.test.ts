/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import { createCustomModelProviders } from './customModelProviderFactory.js';

const transportManager = {
  resolve: () => ({}),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

describe('createCustomModelProviders', () => {
  it('ignores account-owned ids and keeps generic providers', () => {
    const providers = createCustomModelProviders(
      {
        'qwen-subscription': {
          baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
          apiKey: 'placeholder',
          models: [{ model: 'qwen3.8-max' }],
        },
        normal: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
          model: 'model-1',
        },
      },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers.map((provider) => provider.providerId)).toEqual([
      'normal',
    ]);
  });

  it('returns nothing when only account-owned ids are configured', () => {
    const providers = createCustomModelProviders(
      { 'qwen-subscription': { anything: true } },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
  });
});
