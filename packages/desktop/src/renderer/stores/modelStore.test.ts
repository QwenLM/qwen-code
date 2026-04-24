/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createInitialModelState, modelReducer } from './modelStore.js';

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
});
