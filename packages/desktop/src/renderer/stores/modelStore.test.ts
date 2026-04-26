/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createInitialModelState, modelReducer } from './modelStore.js';
import type { DesktopUserSettings } from '../api/client.js';

describe('modelStore', () => {
  it('tracks loaded session model and mode state', () => {
    const state = modelReducer(createInitialModelState(), {
      type: 'session_runtime_loaded',
      models: {
        currentModelId: 'openai/qwen-plus',
        availableModels: [{ modelId: 'openai/qwen-plus', name: 'Qwen Plus' }],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Ask first' },
        ],
      },
    });

    expect(state.models?.currentModelId).toBe('openai/qwen-plus');
    expect(state.modes?.currentModeId).toBe('default');
  });

  it('applies socket model and mode updates to loaded state', () => {
    const loaded = modelReducer(createInitialModelState(), {
      type: 'session_runtime_loaded',
      models: {
        currentModelId: 'openai/qwen-plus',
        availableModels: [
          { modelId: 'openai/qwen-plus', name: 'Qwen Plus' },
          { modelId: 'openai/qwen-max', name: 'Qwen Max' },
        ],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Ask first' },
          { id: 'yolo', name: 'YOLO', description: 'No prompts' },
        ],
      },
    });

    const modelChanged = modelReducer(loaded, {
      type: 'model_changed',
      modelId: 'openai/qwen-max',
    });
    const modeChanged = modelReducer(modelChanged, {
      type: 'mode_changed',
      mode: 'yolo',
    });

    expect(modeChanged.models?.currentModelId).toBe('openai/qwen-max');
    expect(modeChanged.modes?.currentModeId).toBe('yolo');
  });

  it('promotes configured settings models into active session options', () => {
    const withSettings = modelReducer(createInitialModelState(), {
      type: 'settings_models_loaded',
      settings: createSettings('qwen-e2e-cdp'),
    });
    const loaded = modelReducer(withSettings, {
      type: 'session_runtime_loaded',
      models: {
        currentModelId: 'e2e/qwen-code',
        availableModels: [{ modelId: 'e2e/qwen-code', name: 'Qwen Code E2E' }],
      },
    });

    expect(loaded.models?.currentModelId).toBe('e2e/qwen-code');
    expect(loaded.models?.availableModels).toEqual([
      { modelId: 'e2e/qwen-code', name: 'Qwen Code E2E' },
      {
        modelId: 'qwen-e2e-cdp',
        name: 'qwen-e2e-cdp',
        description: 'Configured in desktop settings',
      },
    ]);
  });

  it('keeps configured settings models available across session resets', () => {
    const withSettings = modelReducer(createInitialModelState(), {
      type: 'settings_models_loaded',
      settings: createSettings('qwen-e2e-cdp'),
    });
    const reset = modelReducer(withSettings, { type: 'reset' });
    const loaded = modelReducer(reset, {
      type: 'session_runtime_loaded',
      models: {
        currentModelId: 'e2e/qwen-code',
        availableModels: [{ modelId: 'e2e/qwen-code', name: 'Qwen Code E2E' }],
      },
    });

    expect(reset.models).toBeNull();
    expect(
      loaded.models?.availableModels.map((model) => model.modelId),
    ).toEqual(['e2e/qwen-code', 'qwen-e2e-cdp']);
  });

  it('replaces stale configured options when settings change', () => {
    const withOldSettings = modelReducer(createInitialModelState(), {
      type: 'settings_models_loaded',
      settings: createSettings('qwen-old'),
    });
    const loaded = modelReducer(withOldSettings, {
      type: 'session_runtime_loaded',
      models: {
        currentModelId: 'e2e/qwen-code',
        availableModels: [{ modelId: 'e2e/qwen-code', name: 'Qwen Code E2E' }],
      },
    });
    const withNewSettings = modelReducer(loaded, {
      type: 'settings_models_loaded',
      settings: createSettings('qwen-new'),
    });

    expect(
      withNewSettings.models?.availableModels.map((model) => model.modelId),
    ).toEqual(['e2e/qwen-code', 'qwen-new']);
  });
});

function createSettings(model: string): DesktopUserSettings {
  return {
    ok: true,
    settingsPath: '/tmp/settings.json',
    provider: 'api-key',
    selectedAuthType: 'openai',
    model: { name: model },
    codingPlan: {
      region: 'china',
      hasApiKey: false,
      version: null,
    },
    openai: {
      hasApiKey: true,
      providers: [
        {
          id: model,
          name: model,
          baseUrl: 'https://example.invalid/v1',
          envKey: 'OPENAI_API_KEY',
        },
      ],
    },
  };
}
