/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ALIBABA_STANDARD_API_KEY_PROVIDER,
  type AlibabaStandardRegion,
} from './alibabaStandardApiKey.js';
import { DEEPSEEK_API_KEY_PROVIDER } from './deepseekApiKey.js';

export type ApiKeyProviderRegion = AlibabaStandardRegion;
export type { AlibabaStandardRegion };

export interface ApiKeyProviderRegionConfig<
  TRegion extends string = ApiKeyProviderRegion,
> {
  id: TRegion;
  title: string;
  endpoint: string;
  documentationUrl: string;
}

export interface ApiKeyProviderConfig<
  TRegion extends string = ApiKeyProviderRegion,
> {
  id: string;
  option: string;
  title: string;
  description: string;
  envKey: string;
  modelNamePrefix: string;
  defaultModelIds: string;
  documentationUrl?: string;
  endpoint?: string;
  regions?: ReadonlyArray<ApiKeyProviderRegionConfig<TRegion>>;
}

export const API_KEY_PROVIDERS = {
  alibabaStandard: ALIBABA_STANDARD_API_KEY_PROVIDER,
  deepseek: DEEPSEEK_API_KEY_PROVIDER,
} as const satisfies Record<string, ApiKeyProviderConfig>;

export type ApiKeyProviderId = keyof typeof API_KEY_PROVIDERS;

export const API_KEY_PROVIDER_OPTIONS = Object.values(API_KEY_PROVIDERS);

export function getApiKeyProviderByOption(
  option: string,
): (typeof API_KEY_PROVIDERS)[ApiKeyProviderId] | undefined {
  return API_KEY_PROVIDER_OPTIONS.find(
    (provider) => provider.option === option,
  );
}

export function getApiKeyProviderEndpoint(
  provider: ApiKeyProviderConfig,
  region?: ApiKeyProviderRegion,
): string {
  if (provider.regions) {
    const selectedRegion =
      provider.regions.find((candidate) => candidate.id === region) ||
      provider.regions[0];
    return selectedRegion.endpoint;
  }

  return provider.endpoint || '';
}

export function isApiKeyProviderConfig(
  provider: ApiKeyProviderConfig,
  baseUrl: unknown,
  envKey: unknown,
): boolean {
  if (envKey !== provider.envKey || typeof baseUrl !== 'string') {
    return false;
  }

  if (provider.regions) {
    return provider.regions.some((region) => region.endpoint === baseUrl);
  }

  return baseUrl === provider.endpoint;
}
