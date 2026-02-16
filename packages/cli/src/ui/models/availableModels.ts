/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  DEFAULT_QWEN_MODEL,
  type Config,
  type AvailableModel as CoreAvailableModel,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export type AvailableModel = {
  id: string;
  label: string;
  description?: string;
  isVision?: boolean;
};

export const MAINLINE_VLM = 'vision-model';
export const MAINLINE_CODER = DEFAULT_QWEN_MODEL;

export const AVAILABLE_MODELS_QWEN: AvailableModel[] = [
  {
    id: MAINLINE_CODER,
    label: MAINLINE_CODER,
    get description() {
      return t(
        'Qwen 3.5 Plus — efficient hybrid model with leading coding performance',
      );
    },
  },
  {
    id: MAINLINE_VLM,
    label: MAINLINE_VLM,
    get description() {
      return t(
        'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)',
      );
    },
    isVision: true,
  },
];

/**
 * Get available Qwen models filtered by vision model preview setting
 */
export function getFilteredQwenModels(
  visionModelPreviewEnabled: boolean,
): AvailableModel[] {
  if (visionModelPreviewEnabled) {
    return AVAILABLE_MODELS_QWEN;
  }
  return AVAILABLE_MODELS_QWEN.filter((model) => !model.isVision);
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
 * For qwen-oauth, always returns the hard-coded models.
 * Falls back to environment variables only when no config is provided.
 */
export function getAvailableModelsForAuthType(
  authType: AuthType,
  config?: Config,
): AvailableModel[] {
  // For qwen-oauth, always use hard-coded models, this aligns with the API gateway.
  if (authType === AuthType.QWEN_OAUTH) {
    return AVAILABLE_MODELS_QWEN;
  }

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

/**
 * Hard code the default vision model as a string literal,
 * until our coding model supports multimodal.
 */
export function getDefaultVisionModel(): string {
  return MAINLINE_VLM;
}

export function isVisionModel(modelId: string): boolean {
  return AVAILABLE_MODELS_QWEN.some(
    (model) => model.id === modelId && model.isVision,
  );
}
