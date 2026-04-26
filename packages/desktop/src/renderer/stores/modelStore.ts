/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopApprovalMode,
  DesktopModelInfo,
  DesktopSessionModeState,
  DesktopSessionModelState,
} from '../../shared/desktopProtocol.js';
import type { DesktopUserSettings } from '../api/client.js';

export interface ModelState {
  models: DesktopSessionModelState | null;
  modes: DesktopSessionModeState | null;
  configuredModels: DesktopModelInfo[];
  savingModel: boolean;
  savingMode: boolean;
  error: string | null;
}

export type ModelAction =
  | {
      type: 'session_runtime_loaded';
      models?: DesktopSessionModelState;
      modes?: DesktopSessionModeState;
    }
  | { type: 'settings_models_loaded'; settings: DesktopUserSettings }
  | { type: 'model_save_start' }
  | { type: 'model_saved'; models: DesktopSessionModelState }
  | { type: 'mode_save_start' }
  | { type: 'mode_saved'; modes: DesktopSessionModeState }
  | { type: 'model_changed'; modelId: string }
  | { type: 'mode_changed'; mode: DesktopApprovalMode }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function createInitialModelState(): ModelState {
  return {
    models: null,
    modes: null,
    configuredModels: [],
    savingModel: false,
    savingMode: false,
    error: null,
  };
}

export function modelReducer(
  state: ModelState,
  action: ModelAction,
): ModelState {
  switch (action.type) {
    case 'session_runtime_loaded':
      return {
        ...state,
        models: mergeConfiguredModels(
          action.models ?? state.models,
          state.configuredModels,
        ),
        modes: action.modes ?? state.modes,
        error: null,
      };
    case 'settings_models_loaded': {
      const configuredModels = extractConfiguredModels(action.settings);
      const sessionModels = removeConfiguredModels(
        state.models,
        state.configuredModels,
      );
      return {
        ...state,
        configuredModels,
        models: mergeConfiguredModels(sessionModels, configuredModels),
        error: null,
      };
    }
    case 'model_save_start':
      return { ...state, savingModel: true, error: null };
    case 'model_saved':
      return {
        ...state,
        savingModel: false,
        models: mergeConfiguredModels(action.models, state.configuredModels),
        error: null,
      };
    case 'mode_save_start':
      return { ...state, savingMode: true, error: null };
    case 'mode_saved':
      return {
        ...state,
        savingMode: false,
        modes: action.modes,
        error: null,
      };
    case 'model_changed':
      return {
        ...state,
        models: state.models
          ? { ...state.models, currentModelId: action.modelId }
          : state.models,
      };
    case 'mode_changed':
      return {
        ...state,
        modes: state.modes
          ? { ...state.modes, currentModeId: action.mode }
          : state.modes,
      };
    case 'error':
      return {
        ...state,
        savingModel: false,
        savingMode: false,
        error: action.message,
      };
    case 'reset':
      return {
        ...createInitialModelState(),
        configuredModels: state.configuredModels,
      };
    default:
      return state;
  }
}

function mergeConfiguredModels(
  models: DesktopSessionModelState | null,
  configuredModels: DesktopModelInfo[],
): DesktopSessionModelState | null {
  if (!models) {
    return null;
  }

  const availableModels = [...models.availableModels];
  for (const configuredModel of configuredModels) {
    if (
      !availableModels.some(
        (candidate) => candidate.modelId === configuredModel.modelId,
      )
    ) {
      availableModels.push(configuredModel);
    }
  }

  if (
    !availableModels.some(
      (candidate) => candidate.modelId === models.currentModelId,
    )
  ) {
    availableModels.unshift({
      modelId: models.currentModelId,
      name: models.currentModelId,
    });
  }

  return {
    ...models,
    availableModels,
  };
}

function removeConfiguredModels(
  models: DesktopSessionModelState | null,
  configuredModels: DesktopModelInfo[],
): DesktopSessionModelState | null {
  if (!models || configuredModels.length === 0) {
    return models;
  }

  const configuredIds = new Set(configuredModels.map((model) => model.modelId));
  return {
    ...models,
    availableModels: models.availableModels.filter(
      (model) =>
        model.modelId === models.currentModelId ||
        !configuredIds.has(model.modelId),
    ),
  };
}

function extractConfiguredModels(
  settings: DesktopUserSettings,
): DesktopModelInfo[] {
  const providers = settings.openai.providers
    .map((provider) => ({
      modelId: provider.id.trim(),
      name: (provider.name || provider.id).trim(),
      description: 'Configured in desktop settings',
    }))
    .filter((model) => model.modelId.length > 0);
  const activeModel = settings.model.name?.trim();
  if (
    activeModel &&
    !providers.some((provider) => provider.modelId === activeModel)
  ) {
    providers.unshift({
      modelId: activeModel,
      name: activeModel,
      description: 'Configured in desktop settings',
    });
  }

  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (seen.has(provider.modelId)) {
      return false;
    }

    seen.add(provider.modelId);
    return true;
  });
}
