/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import type { ModelProvider } from '../modelProvider.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import { registerCustomProviderComposer } from './customProviderComposers.js';
import { createCustomModelProviders } from './customModelProviderFactory.js';

const transportManager = {
  resolve: () => ({}),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

afterEach(() => {
  registerCustomProviderComposer('reserved', undefined);
});

describe('createCustomModelProviders', () => {
  it('composes a reserved id before the generic parser', () => {
    const composed = { providerId: 'reserved' } as unknown as ModelProvider;
    const compose = vi.fn(() => composed);
    registerCustomProviderComposer('reserved', compose);

    const providers = createCustomModelProviders(
      {
        reserved: { anything: true },
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

    expect(compose).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toEqual([
      'reserved',
      'normal',
    ]);
  });

  it('drops the reserved id when the composer declines', () => {
    registerCustomProviderComposer('reserved', () => undefined);

    const providers = createCustomModelProviders(
      { reserved: { anything: true } },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
  });
});
