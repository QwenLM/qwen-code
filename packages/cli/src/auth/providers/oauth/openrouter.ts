/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * CLI-specific OAuth install plan builder for OpenRouter.
 * Provider config is defined in core; this file only contains
 * the CLI-specific function that depends on openrouterOAuth.ts.
 */

import {
  type ProviderModelConfig,
  type ProviderInstallPlan,
  buildInstallPlan,
  openRouterProvider,
  OPENROUTER_BASE_URL,
} from '@qwen-code/qwen-code-core';
import {
  getOpenRouterModelsWithFallback,
  selectRecommendedOpenRouterModels,
  getPreferredOpenRouterModelId,
} from './openrouterOAuth.js';

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

  return buildInstallPlan(openRouterProvider, {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey,
    modelIds: preferredId ? [preferredId] : [],
    prebuiltModels: recommended,
  });
}
