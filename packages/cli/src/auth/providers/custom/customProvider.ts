/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { LlmProvider, ProviderInstallPlan } from '../../types.js';
import type {
  CustomProviderGenerationConfigInput,
  CustomProviderInstallInput,
} from './customProviderWizardTypes.js';

export const CUSTOM_API_KEY_ENV_PREFIX = 'QWEN_CUSTOM_API_KEY_';

export function generateCustomApiKeyEnvKey(
  protocol: string,
  baseUrl: string,
): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalize(protocol)}_${normalize(
    baseUrl,
  )}`;
}

function buildCustomGenerationConfig(
  generationConfig: CustomProviderGenerationConfigInput | undefined,
): ProviderModelConfig['generationConfig'] | undefined {
  if (!generationConfig) {
    return undefined;
  }

  const hasThinking = generationConfig.enableThinking === true;
  const hasMultimodal =
    generationConfig.multimodal &&
    (generationConfig.multimodal.image === true ||
      generationConfig.multimodal.video === true ||
      generationConfig.multimodal.audio === true);
  const hasMaxTokens =
    generationConfig.maxTokens !== undefined && generationConfig.maxTokens > 0;

  if (!hasThinking && !hasMultimodal && !hasMaxTokens) {
    return undefined;
  }

  const modelGenerationConfig: ProviderModelConfig['generationConfig'] = {};
  if (hasMultimodal) {
    modelGenerationConfig.modalities = {
      image: generationConfig.multimodal!.image ?? false,
      video: generationConfig.multimodal!.video ?? false,
      audio: generationConfig.multimodal!.audio ?? false,
    };
  }
  if (hasThinking) {
    modelGenerationConfig.extra_body = { enable_thinking: true };
  }
  if (hasMaxTokens) {
    modelGenerationConfig.samplingParams = {
      max_tokens: generationConfig.maxTokens,
    };
  }

  return modelGenerationConfig;
}

export function createCustomProviderInstallPlan({
  protocol,
  baseUrl,
  apiKey,
  modelIds,
  envKey,
  generationConfig,
}: CustomProviderInstallInput): ProviderInstallPlan {
  const modelGenerationConfig = buildCustomGenerationConfig(generationConfig);
  const models: ProviderModelConfig[] = modelIds.map((modelId) => ({
    id: modelId,
    name: modelId,
    baseUrl,
    envKey,
    ...(modelGenerationConfig
      ? { generationConfig: modelGenerationConfig }
      : {}),
  }));

  return {
    providerId: customProvider.id,
    authType: protocol,
    env: {
      [envKey]: apiKey,
    },
    legacyCredentials: {
      baseUrl,
    },
    modelSelection: {
      modelId: modelIds[0],
    },
    modelProviders: [
      {
        authType: protocol,
        models,
        mergeStrategy: 'prepend-and-remove-owned',
        ownsModel(model) {
          return model.envKey === envKey;
        },
      },
    ],
  };
}

export const customProvider: LlmProvider = {
  id: 'custom-openai-compatible',
  label: 'Custom OpenAI-compatible Provider',
  category: 'custom',
  protocol: AuthType.USE_OPENAI,
  setupMethods: [{ type: 'manual' }],
  ownsModel(model) {
    return (
      typeof model.envKey === 'string' &&
      model.envKey.startsWith(CUSTOM_API_KEY_ENV_PREFIX)
    );
  },
  async createInstallPlan(input) {
    return createCustomProviderInstallPlan(
      input as unknown as CustomProviderInstallInput,
    );
  },
};
