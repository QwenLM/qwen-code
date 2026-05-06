/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';
import { buildInstallPlan } from '../../providerConfig.js';
import {
  getOpenRouterModelsWithFallback,
  selectRecommendedOpenRouterModels,
  getPreferredOpenRouterModelId,
} from './openrouterOAuth.js';
import type { ProviderInstallPlan } from '../../types.js';

export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const openRouterProviderConfig: ProviderConfig = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Browser OAuth · Auto-configure API key and OpenRouter models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: OPENROUTER_BASE_URL,
  envKey: OPENROUTER_ENV_KEY,
  authMethod: 'oauth',
  models: undefined,
  modelNamePrefix: 'OpenRouter',
  ownsModel: (model) => (model.baseUrl ?? '').includes('openrouter.ai'),
  uiGroup: 'oauth',
};

export async function createOpenRouterProviderInstallPlan({
  apiKey,
  models,
}: {
  apiKey: string;
  models?: ProviderModelConfig[];
}): Promise<ProviderInstallPlan> {
  const catalog = models ?? (await getOpenRouterModelsWithFallback());
  const recommended = selectRecommendedOpenRouterModels(catalog);
  const preferredId = getPreferredOpenRouterModelId(recommended);

  return buildInstallPlan(openRouterProviderConfig, {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey,
    modelIds: preferredId ? [preferredId] : [],
    prebuiltModels: recommended,
  });
}
