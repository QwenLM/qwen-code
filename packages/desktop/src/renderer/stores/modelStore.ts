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

const CONFIGURED_API_KEY_PROVIDER_DESCRIPTION = 'Saved API key provider';
const CONFIGURED_CODING_PLAN_PROVIDER_DESCRIPTION =
  'Saved Coding Plan provider';
const CONFIGURED_MODEL_PROVIDER_META_KEY = 'desktopProvider';
const CONFIGURED_MODEL_API_KEY_META_KEY = 'desktopProviderHasApiKey';

type ConfiguredModelProviderKind = 'api-key' | 'coding-plan';

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
        models: mergeConfiguredModels(
          preserveKnownModelMetadata(action.models, state.models),
          state.configuredModels,
        ),
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

  const configuredById = new Map(
    configuredModels.map((model) => [model.modelId, model]),
  );
  const availableModels = models.availableModels.map((model) => {
    const configuredModel = configuredById.get(model.modelId);
    if (!configuredModel) {
      return model;
    }

    return {
      ...model,
      name:
        model.name && model.name !== model.modelId
          ? model.name
          : configuredModel.name,
      description: model.description ?? configuredModel.description,
      _meta: configuredModel._meta
        ? { ...(model._meta ?? {}), ...configuredModel._meta }
        : model._meta,
    };
  });

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

function preserveKnownModelMetadata(
  models: DesktopSessionModelState,
  previousModels: DesktopSessionModelState | null,
): DesktopSessionModelState {
  if (!previousModels) {
    return models;
  }

  const previousById = new Map(
    previousModels.availableModels.map((model) => [model.modelId, model]),
  );

  return {
    ...models,
    availableModels: models.availableModels.map((model) => {
      const previous = previousById.get(model.modelId);
      if (!previous) {
        return model;
      }

      return {
        ...model,
        name:
          model.name && model.name !== model.modelId
            ? model.name
            : previous.name,
        description: model.description ?? previous.description,
        _meta: model._meta ?? previous._meta,
      };
    }),
  };
}

function extractConfiguredModels(
  settings: DesktopUserSettings,
): DesktopModelInfo[] {
  const providers = settings.openai.providers
    .map((provider) => {
      const providerKind = getConfiguredProviderKind(provider.envKey);

      return {
        modelId: provider.id.trim(),
        name: (provider.name || provider.id).trim(),
        description: getConfiguredModelDescription(provider.envKey),
        _meta: createConfiguredProviderMeta(
          providerKind,
          getConfiguredProviderHasApiKey(settings, providerKind),
        ),
      };
    })
    .filter((model) => model.modelId.length > 0);
  const activeModel = settings.model.name?.trim();
  if (
    activeModel &&
    !providers.some((provider) => provider.modelId === activeModel)
  ) {
    const providerKind =
      settings.provider === 'coding-plan' ? 'coding-plan' : 'api-key';
    providers.unshift({
      modelId: activeModel,
      name: activeModel,
      description:
        providerKind === 'coding-plan'
          ? CONFIGURED_CODING_PLAN_PROVIDER_DESCRIPTION
          : CONFIGURED_API_KEY_PROVIDER_DESCRIPTION,
      _meta: createConfiguredProviderMeta(
        providerKind,
        getConfiguredProviderHasApiKey(settings, providerKind),
      ),
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

function getConfiguredModelDescription(envKey: string): string {
  if (envKey.toUpperCase().includes('CODING_PLAN')) {
    return CONFIGURED_CODING_PLAN_PROVIDER_DESCRIPTION;
  }

  return CONFIGURED_API_KEY_PROVIDER_DESCRIPTION;
}

function getConfiguredProviderKind(
  envKey: string,
): ConfiguredModelProviderKind {
  return envKey.toUpperCase().includes('CODING_PLAN')
    ? 'coding-plan'
    : 'api-key';
}

function getConfiguredProviderHasApiKey(
  settings: DesktopUserSettings,
  providerKind: ConfiguredModelProviderKind,
): boolean {
  return providerKind === 'coding-plan'
    ? settings.codingPlan.hasApiKey
    : settings.openai.hasApiKey;
}

function createConfiguredProviderMeta(
  providerKind: ConfiguredModelProviderKind,
  hasApiKey: boolean,
): Record<string, unknown> {
  return {
    [CONFIGURED_MODEL_PROVIDER_META_KEY]: providerKind,
    [CONFIGURED_MODEL_API_KEY_META_KEY]: hasApiKey,
  };
}
