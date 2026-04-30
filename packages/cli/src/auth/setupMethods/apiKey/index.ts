/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
export {
  ALIBABA_STANDARD_API_KEY_PROVIDER,
  API_KEY_PROVIDERS,
  API_KEY_PROVIDER_OPTIONS,
  DEEPSEEK_API_KEY_PROVIDER,
  defineApiKeyProvider,
  getApiKeyProviderByOption,
  getApiKeyProviderEndpoint,
  isApiKeyProviderConfig,
} from './definitions.js';
export type {
  AlibabaStandardRegion,
  AnyApiKeyProviderConfig,
  ApiKeyProviderConfig,
  ApiKeyProviderId,
  ApiKeyProviderRegion,
  ApiKeyProviderRegionConfig,
} from './definitions.js';
import {
  getApiKeyProviderEndpoint,
  isApiKeyProviderConfig,
  type ApiKeyProviderConfig,
  type ApiKeyProviderRegion,
} from './definitions.js';
import type { LlmProvider, ProviderInstallPlan } from '../../types.js';

export interface ApiKeyProviderInstallInput {
  provider: ApiKeyProviderConfig;
  apiKey: string;
  modelIds: string[];
  region?: ApiKeyProviderRegion;
}

export function buildApiKeyProviderModelConfigs(
  provider: ApiKeyProviderConfig,
  modelIds: string[],
  baseUrl: string,
): ProviderModelConfig[] {
  return modelIds.map((modelId) => ({
    id: modelId,
    name: `[${provider.modelNamePrefix}] ${modelId}`,
    baseUrl,
    envKey: provider.envKey,
  }));
}

export function createApiKeyProviderInstallPlan({
  provider,
  apiKey,
  modelIds,
  region,
}: ApiKeyProviderInstallInput): ProviderInstallPlan {
  const baseUrl = getApiKeyProviderEndpoint(provider, region);
  const models = buildApiKeyProviderModelConfigs(provider, modelIds, baseUrl);

  return {
    providerId: provider.id,
    authType: AuthType.USE_OPENAI,
    env: {
      [provider.envKey]: apiKey,
    },
    ...(modelIds[0]
      ? {
          modelSelection: {
            modelId: modelIds[0],
          },
        }
      : {}),
    modelProviders: [
      {
        authType: AuthType.USE_OPENAI,
        models,
        mergeStrategy: 'prepend-and-remove-owned',
        ownsModel(model) {
          return isApiKeyProviderConfig(
            provider,
            model.name,
            model.baseUrl,
            model.envKey,
          );
        },
      },
    ],
  };
}

export function createApiKeyLlmProvider(
  provider: ApiKeyProviderConfig,
): LlmProvider {
  return {
    id: provider.id,
    label: provider.title,
    description: provider.description,
    category: 'third-party',
    protocol: AuthType.USE_OPENAI,
    setupMethods: [{ type: 'api-key' }],
    ownsModel(model) {
      return isApiKeyProviderConfig(
        provider,
        model.name,
        model.baseUrl,
        model.envKey,
      );
    },
    async createInstallPlan(input) {
      return createApiKeyProviderInstallPlan(
        input as unknown as ApiKeyProviderInstallInput,
      );
    },
  };
}
