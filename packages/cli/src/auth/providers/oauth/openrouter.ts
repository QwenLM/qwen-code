/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
import {
  getOpenRouterModelsWithFallback,
  getPreferredOpenRouterModelId,
  isOpenRouterConfig,
  OPENROUTER_ENV_KEY,
  selectRecommendedOpenRouterModels,
} from './openrouterOAuth.js';
import type { LlmProvider, ProviderInstallPlan } from '../../types.js';

export interface OpenRouterProviderInstallInput {
  apiKey: string;
  models?: ProviderModelConfig[];
}

export async function createOpenRouterProviderInstallPlan({
  apiKey,
  models,
}: OpenRouterProviderInstallInput): Promise<ProviderInstallPlan> {
  const openRouterCatalog = models ?? (await getOpenRouterModelsWithFallback());
  const openRouterModels = selectRecommendedOpenRouterModels(openRouterCatalog);
  const activeModelId = getPreferredOpenRouterModelId(openRouterModels);

  return {
    providerId: openRouterProvider.id,
    authType: AuthType.USE_OPENAI,
    env: {
      [OPENROUTER_ENV_KEY]: apiKey,
    },
    ...(activeModelId
      ? {
          modelSelection: {
            modelId: activeModelId,
          },
        }
      : {}),
    modelProviders: [
      {
        authType: AuthType.USE_OPENAI,
        models: openRouterModels,
        mergeStrategy: 'prepend-and-remove-owned',
      },
    ],
  };
}

export const openRouterProvider: LlmProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  category: 'third-party',
  protocol: AuthType.USE_OPENAI,
  setupMethods: [{ type: 'oauth' }],
  ownsModel(model) {
    return isOpenRouterConfig(model);
  },
  async createInstallPlan(input) {
    return createOpenRouterProviderInstallPlan(
      input as unknown as OpenRouterProviderInstallInput,
    );
  },
};
