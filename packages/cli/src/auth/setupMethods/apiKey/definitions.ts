/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  defineApiKeyProvider,
  type AnyApiKeyProviderConfig,
  type ApiKeyProviderConfig,
  type ApiKeyProviderEndpointOptionConfig,
} from './defineApiKeyProvider.js';
export {
  ALIBABA_STANDARD_API_KEY_PROVIDER,
  type AlibabaStandardEndpointOption,
} from '../../providers/alibaba/modelStudio.js';
export { DEEPSEEK_API_KEY_PROVIDER } from '../../providers/thirdParty/deepseek.js';
export { MINIMAX_API_KEY_PROVIDER } from '../../providers/thirdParty/minimax.js';
export { ZAI_API_KEY_PROVIDER } from '../../providers/thirdParty/zai.js';

import { ALIBABA_STANDARD_API_KEY_PROVIDER } from '../../providers/alibaba/modelStudio.js';
import { DEEPSEEK_API_KEY_PROVIDER } from '../../providers/thirdParty/deepseek.js';
import { MINIMAX_API_KEY_PROVIDER } from '../../providers/thirdParty/minimax.js';
import { ZAI_API_KEY_PROVIDER } from '../../providers/thirdParty/zai.js';
import type {
  AnyApiKeyProviderConfig,
  ApiKeyProviderConfig,
} from './defineApiKeyProvider.js';

export type ApiKeyProviderEndpointOption = string;

export const API_KEY_PROVIDERS = {
  alibabaStandard: ALIBABA_STANDARD_API_KEY_PROVIDER,
  deepseek: DEEPSEEK_API_KEY_PROVIDER,
  minimax: MINIMAX_API_KEY_PROVIDER,
  zai: ZAI_API_KEY_PROVIDER,
} as const satisfies Record<string, AnyApiKeyProviderConfig>;

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
  endpointOption?: ApiKeyProviderEndpointOption,
): string {
  if (provider.endpointOptions) {
    const selectedEndpointOption =
      provider.endpointOptions.find(
        (candidate) => candidate.id === endpointOption,
      ) || provider.endpointOptions[0];
    return selectedEndpointOption.endpoint;
  }

  return provider.endpoint || '';
}

export function isApiKeyProviderConfig(
  provider: ApiKeyProviderConfig,
  name: unknown,
  baseUrl: unknown,
  envKey: unknown,
): boolean {
  if (
    typeof name !== 'string' ||
    envKey !== provider.envKey ||
    typeof baseUrl !== 'string' ||
    !name.startsWith(`[${provider.modelNamePrefix}] `)
  ) {
    return false;
  }

  if (provider.endpointOptions) {
    return provider.endpointOptions.some(
      (endpointOption) => endpointOption.endpoint === baseUrl,
    );
  }

  return baseUrl === provider.endpoint;
}
