/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, DEFAULT_QWEN_MODEL } from '@qwen-code/qwen-code-core';
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
        'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)',
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
  return id ? { id, label: id } : null;
}

/**
 * Fetch available models from local Ollama instance
 */
async function fetchOllamaModels(): Promise<AvailableModel[]> {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return (data.models || []).map(
      (model: { name: string; details?: { parameter_size?: string } }) => ({
        id: model.name,
        label: model.name,
        description: `Ollama model (${model.details?.parameter_size || 'Unknown size'})`,
      }),
    );
  } catch (_error) {
    // Silently fail if Ollama is not running or unreachable
    return [];
  }
}

export async function getAvailableModelsForAuthType(
  authType: AuthType,
): Promise<AvailableModel[]> {
  switch (authType) {
    case AuthType.QWEN_OAUTH:
      return AVAILABLE_MODELS_QWEN;
    case AuthType.USE_OPENAI: {
      const openAIModel = getOpenAIAvailableModelFromEnv();
      return openAIModel ? [openAIModel] : [];
    }
    case AuthType.OLLAMA:
      return await fetchOllamaModels();
    default:
      // For other auth types, return empty array for now
      // This can be expanded later according to the design doc
      return [];
  }
}

/**
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
