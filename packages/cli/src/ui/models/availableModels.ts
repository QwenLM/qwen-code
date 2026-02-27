/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type AvailableModel as CoreAvailableModel,
  QWEN_OAUTH_MODELS,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export type AvailableModel = {
  id: string;
  label: string;
  description?: string;
  isVision?: boolean;
};

const CACHED_QWEN_OAUTH_MODELS: AvailableModel[] = QWEN_OAUTH_MODELS.map(
  (model) => ({
    id: model.id,
    label: model.name ?? model.id,
    description: model.description,
    isVision: model.capabilities?.vision ?? false,
  }),
);

function getQwenOAuthModels(): readonly AvailableModel[] {
  return CACHED_QWEN_OAUTH_MODELS;
}

/**
 * Get available Qwen models
 * coder-model now has vision capabilities by default.
 */
export function getFilteredQwenModels(): AvailableModel[] {
  return [...getQwenOAuthModels()];
}

/**
 * Currently we use the single model of `OPENAI_MODEL` in the env.
 * In the future, after settings.json is updated, we will allow users to configure this themselves.
 */
export function getOpenAIAvailableModelFromEnv(): AvailableModel | null {
  const id = process.env['OPENAI_MODEL']?.trim();
  return id
    ? {
        id,
        label: id,
        get description() {
          return t('Configured via OPENAI_MODEL environment variable');
        },
      }
    : null;
}

export function getAnthropicAvailableModelFromEnv(): AvailableModel | null {
  const id = process.env['ANTHROPIC_MODEL']?.trim();
  return id
    ? {
        id,
        label: id,
        get description() {
          return t('Configured via ANTHROPIC_MODEL environment variable');
        },
      }
    : null;
}

/**
 * Convert core AvailableModel to CLI AvailableModel format
 */
function convertCoreModelToCliModel(
  coreModel: CoreAvailableModel,
): AvailableModel {
  return {
    id: coreModel.id,
    label: coreModel.label,
    description: coreModel.description,
    isVision: coreModel.isVision ?? coreModel.capabilities?.vision ?? false,
  };
}

/**
 * Get available models for the given authType.
 *
 * If a Config object is provided, uses config.getAvailableModelsForAuthType().
 * Falls back to environment variables only when no config is provided.
 */
export function getAvailableModelsForAuthType(
  authType: AuthType,
  config?: Config,
): AvailableModel[] {
  // Use config's model registry when available
  if (config) {
    try {
      const models = config.getAvailableModelsForAuthType(authType);
      if (models.length > 0) {
        return models.map(convertCoreModelToCliModel);
      }
    } catch {
      // If config throws (e.g., not initialized), return empty array
    }
    // When a Config object is provided, we intentionally do NOT fall back to env-based
    // "raw" models. These may reflect the currently effective config but should not be
    // presented as selectable options in /model.
    return [];
  }

  // Fall back to environment variables for specific auth types (no config provided)
  switch (authType) {
    case AuthType.QWEN_OAUTH: {
      return [...getQwenOAuthModels()];
    }
    case AuthType.USE_OPENAI: {
      const openAIModel = getOpenAIAvailableModelFromEnv();
      return openAIModel ? [openAIModel] : [];
    }
    case AuthType.USE_ANTHROPIC: {
      const anthropicModel = getAnthropicAvailableModelFromEnv();
      return anthropicModel ? [anthropicModel] : [];
    }
    default:
      return [];
  }
}
