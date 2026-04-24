/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildSettingsUpdateRequest,
  createInitialSettingsState,
  settingsReducer,
} from './settingsStore.js';
import type { DesktopUserSettings } from '../api/client.js';

describe('settingsStore', () => {
  it('hydrates the settings form without exposing a saved API key', () => {
    const state = settingsReducer(createInitialSettingsState(), {
      type: 'load_success',
      settings: createSettings(),
    });

    expect(state.form).toMatchObject({
      provider: 'api-key',
      activeModel: 'qwen-plus',
      baseUrl: 'https://example.test/v1',
      apiKey: '',
    });
  });

  it('builds an API-key settings update request from the form', () => {
    const state = {
      ...createInitialSettingsState(),
      form: {
        provider: 'api-key' as const,
        apiKey: 'secret',
        codingPlanRegion: 'china' as const,
        activeModel: 'qwen-max',
        baseUrl: 'https://example.test/v1',
      },
    };

    expect(buildSettingsUpdateRequest(state.form)).toEqual({
      provider: 'api-key',
      apiKey: 'secret',
      activeModel: 'qwen-max',
      modelProviders: {
        'qwen-max': 'https://example.test/v1',
      },
    });
  });
});

function createSettings(): DesktopUserSettings {
  return {
    ok: true,
    settingsPath: '/tmp/settings.json',
    provider: 'api-key',
    selectedAuthType: 'openai',
    model: { name: 'qwen-plus' },
    codingPlan: {
      region: 'china',
      hasApiKey: false,
      version: null,
    },
    openai: {
      hasApiKey: true,
      providers: [
        {
          id: 'qwen-plus',
          name: 'Qwen Plus',
          baseUrl: 'https://example.test/v1',
          envKey: 'OPENAI_API_KEY',
        },
      ],
    },
  };
}
