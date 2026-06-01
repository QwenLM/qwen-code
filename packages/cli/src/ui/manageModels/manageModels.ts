/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type ProviderModelConfig as ModelConfig,
  type ModelProvidersConfig,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  OPENROUTER_DEFAULT_MODEL,
  fetchOpenRouterModels,
  isOpenRouterConfig,
  mergeOpenRouterConfigs,
} from '../../auth/providers/oauth/openrouterOAuth.js';

export const MANAGE_MODELS_SOURCES = ['openrouter'] as const;

export type ManageModelsSource = (typeof MANAGE_MODELS_SOURCES)[number];

export interface ManageModelsCatalogEntry {
  id: string;
  label: string;
  searchText: string;
  supportsVision: boolean;
  contextWindowSize?: number;
  badges: string[];
  model: ModelConfig;
}

export interface ManageModelsCatalog {
  source: ManageModelsSource;
  title: string;
  description: string;
  authType: AuthType;
  entries: ManageModelsCatalogEntry[];
}

export interface ManageModelsSaveResult {
  updatedConfigs: ModelConfig[];
  selectedIds: string[];
  activeModelId?: string;
}

function isFreeOpenRouterModel(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return normalizedId.includes(':free') || normalizedId === 'openrouter/free';
}

function getManageModelsDisplayLabel(
  source: ManageModelsSource,
  model: ModelConfig,
): string {
  const rawLabel = model.name || model.id;

  switch (source) {
    case 'openrouter':
      return rawLabel.replace(/^OpenRouter\s*·\s*/i, '').trim() || model.id;
    default:
      return rawLabel;
  }
}

function createEntry(
  source: ManageModelsSource,
  model: ModelConfig,
): ManageModelsCatalogEntry {
  const contextWindowSize = model.generationConfig?.contextWindowSize;
  const supportsVision = model.capabilities?.vision === true;
  const badges: string[] = [];

  if (isFreeOpenRouterModel(model.id)) {
    badges.push('free');
  }
  if (supportsVision) {
    badges.push('vision');
  }
  if (typeof contextWindowSize === 'number' && contextWindowSize >= 1_000_000) {
    badges.push('long-context');
  }

  const displayLabel = getManageModelsDisplayLabel(source, model);

  return {
    id: model.id,
    label: displayLabel,
    searchText: [model.id, model.name, displayLabel, ...badges]
      .filter(Boolean)
      .join(' '),
    supportsVision,
    contextWindowSize,
    badges,
    model,
  };
}

export async function fetchManageModelsCatalog(
  source: ManageModelsSource,
): Promise<ManageModelsCatalog> {
  switch (source) {
    case 'openrouter': {
      const models = await fetchOpenRouterModels();
      return {
        source,
        title: 'OpenRouter',
        description:
          'Browse the latest OpenRouter model catalog and choose which models are enabled locally.',
        authType: AuthType.USE_OPENAI,
        entries: models.map((model) => createEntry(source, model)),
      };
    }
    default:
      throw new Error(`Unsupported manage models source: ${source}`);
  }
}

export function getEnabledModelIdsForSource(
  source: ManageModelsSource,
  settings: LoadedSettings,
): string[] {
  const modelProviders = settings.merged.modelProviders as
    | ModelProvidersConfig
    | undefined;
  const openaiConfigs = modelProviders?.[AuthType.USE_OPENAI] || [];

  switch (source) {
    case 'openrouter':
      return openaiConfigs
        .filter((config) => isOpenRouterConfig(config))
        .map((config) => config.id);
    default:
      return [];
  }
}

export async function saveManageModelsSelection(params: {
  source: ManageModelsSource;
  selectedModels: ModelConfig[];
  settings: LoadedSettings;
  config: Config;
}): Promise<ManageModelsSaveResult> {
  const { source, selectedModels, settings, config } = params;
  const persistScope = getPersistScopeForModelSelection(settings);
  const mergedModelProviders = settings.merged.modelProviders as
    | ModelProvidersConfig
    | undefined;
  const existingOpenAIConfigs =
    mergedModelProviders?.[AuthType.USE_OPENAI] || [];

  switch (source) {
    case 'openrouter': {
      const updatedConfigs = mergeOpenRouterConfigs(
        existingOpenAIConfigs,
        selectedModels,
      );

      if (updatedConfigs.length === 0) {
        throw new Error(
          'At least one OpenAI-compatible model must remain enabled.',
        );
      }

      settings.setValue(
        persistScope,
        `modelProviders.${AuthType.USE_OPENAI}`,
        updatedConfigs,
      );

      const selectedIds = selectedModels.map((model) => model.id);
      const currentAuthType = config.getContentGeneratorConfig()?.authType;
      const currentModelId = config.getModel();
      const currentModelStillAvailable = currentModelId
        ? updatedConfigs.some((model) => model.id === currentModelId)
        : false;

      let activeModelId = currentModelId;
      if (!currentModelStillAvailable) {
        const preferredDefault = updatedConfigs.find(
          (model) => model.id === OPENROUTER_DEFAULT_MODEL,
        );
        activeModelId = preferredDefault?.id || updatedConfigs[0]?.id;
        if (activeModelId) {
          settings.setValue(persistScope, 'model.name', activeModelId);
        }
      }

      const updatedModelProviders: ModelProvidersConfig = {
        ...(mergedModelProviders || {}),
        [AuthType.USE_OPENAI]: updatedConfigs,
      };
      config.reloadModelProvidersConfig(updatedModelProviders);

      if (currentAuthType === AuthType.USE_OPENAI) {
        await config.refreshAuth(AuthType.USE_OPENAI);
      }

      return {
        updatedConfigs,
        selectedIds,
        activeModelId,
      };
    }
    default:
      throw new Error(`Unsupported manage models source: ${source}`);
  }
}
