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
  validateSettingsForm,
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

  it('trims API-key model settings before saving', () => {
    const state = {
      ...createInitialSettingsState(),
      form: {
        provider: 'api-key' as const,
        apiKey: '  secret  ',
        codingPlanRegion: 'china' as const,
        activeModel: '  qwen-max  ',
        baseUrl: '  https://example.test/v1  ',
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

  it('builds a Coding Plan settings update request from the form', () => {
    const state = {
      ...createInitialSettingsState(),
      form: {
        provider: 'coding-plan' as const,
        apiKey: '  cp-secret  ',
        codingPlanRegion: 'global' as const,
        activeModel: 'qwen-plus',
        baseUrl: 'https://example.test/v1',
      },
    };

    expect(buildSettingsUpdateRequest(state.form)).toEqual({
      provider: 'coding-plan',
      apiKey: 'cp-secret',
      codingPlanRegion: 'global',
    });
  });

  it('validates API-key provider inputs before saving', () => {
    const state = createInitialSettingsState();

    expect(
      validateSettingsForm(
        { ...state.form, activeModel: '   ', apiKey: 'secret' },
        null,
      ),
    ).toEqual({
      valid: false,
      reason: 'Enter a model name before saving.',
    });
    expect(
      validateSettingsForm(
        { ...state.form, baseUrl: 'ftp://example.test', apiKey: 'secret' },
        null,
      ),
    ).toEqual({
      valid: false,
      reason: 'Use a valid HTTP(S) base URL.',
    });
    expect(validateSettingsForm(state.form, null)).toEqual({
      valid: false,
      reason: 'Enter an API key to save this provider.',
    });
    expect(
      validateSettingsForm({ ...state.form, apiKey: 'secret' }, null),
    ).toEqual({
      valid: true,
      reason: null,
    });
  });

  it('accepts saved provider secrets without exposing them in the form', () => {
    const settings = createSettings();
    const state = settingsReducer(createInitialSettingsState(), {
      type: 'load_success',
      settings,
    });

    expect(state.form.apiKey).toBe('');
    expect(validateSettingsForm(state.form, settings)).toEqual({
      valid: true,
      reason: null,
    });
  });

  it('validates Coding Plan API keys before saving', () => {
    const state = createInitialSettingsState();
    const form = {
      ...state.form,
      provider: 'coding-plan' as const,
      apiKey: '',
    };

    expect(validateSettingsForm(form, null)).toEqual({
      valid: false,
      reason: 'Enter a Coding Plan API key to save this provider.',
    });
    expect(validateSettingsForm({ ...form, apiKey: 'secret' }, null)).toEqual({
      valid: true,
      reason: null,
    });
  });

  it('accepts a saved Coding Plan secret without exposing it in the form', () => {
    const settings = createSettings({
      provider: 'coding-plan',
      codingPlanHasApiKey: true,
      openAiHasApiKey: false,
    });
    const state = settingsReducer(createInitialSettingsState(), {
      type: 'load_success',
      settings,
    });

    expect(state.form).toMatchObject({
      provider: 'coding-plan',
      apiKey: '',
      codingPlanRegion: 'china',
    });
    expect(validateSettingsForm(state.form, settings)).toEqual({
      valid: true,
      reason: null,
    });
  });
});

function createSettings(
  overrides: {
    provider?: DesktopUserSettings['provider'];
    codingPlanHasApiKey?: boolean;
    openAiHasApiKey?: boolean;
  } = {},
): DesktopUserSettings {
  return {
    ok: true,
    settingsPath: '/tmp/settings.json',
    provider: overrides.provider ?? 'api-key',
    selectedAuthType: 'openai',
    model: { name: 'qwen-plus' },
    codingPlan: {
      region: 'china',
      hasApiKey: overrides.codingPlanHasApiKey ?? false,
      version: null,
    },
    openai: {
      hasApiKey: overrides.openAiHasApiKey ?? true,
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
