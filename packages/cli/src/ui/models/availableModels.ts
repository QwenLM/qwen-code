/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type AvailableModel = {
  id: string;
  label: string;
  isVision?: boolean;
};

export const AVAILABLE_MODELS_QWEN: AvailableModel[] = [
  { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus' },
  { id: 'qwen-vl-max-latest', label: 'qwen-vl-max', isVision: true },
];

export const AVAILABLE_MODELS_GEMINI: AvailableModel[] = [
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
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
 * Get available Gemini models filtered by vision model preview setting
 */
export function getFilteredGeminiModels(
  visionModelPreviewEnabled: boolean,
): AvailableModel[] {
  if (visionModelPreviewEnabled) {
    return AVAILABLE_MODELS_GEMINI;
  }
  return AVAILABLE_MODELS_GEMINI.filter((model) => !model.isVision);
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
 * Hard code the default vision model as a string literal,
 * until our coding model supports multimodal.
 */
export function getDefaultVisionModel(): string {
  return 'qwen-vl-max-latest';
}

export function isVisionModel(modelId: string): boolean {
  return (
    AVAILABLE_MODELS_QWEN.some(
      (model) => model.id === modelId && model.isVision,
    ) ||
    AVAILABLE_MODELS_GEMINI.some(
      (model) => model.id === modelId && model.isVision,
    )
  );
}
