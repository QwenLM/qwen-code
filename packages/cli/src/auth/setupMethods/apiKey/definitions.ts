/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  defineApiKeyProvider,
  type AnyApiKeyProviderConfig,
  type ApiKeyProviderConfig,
  type ApiKeyProviderRegionConfig,
} from './defineApiKeyProvider.js';
export {
  ALIBABA_STANDARD_API_KEY_PROVIDER,
  type AlibabaStandardRegion,
} from '../../providers/alibaba/modelStudio.js';
export { DEEPSEEK_API_KEY_PROVIDER } from '../../providers/thirdParty/deepseek.js';
export { HUGGINGFACE_API_KEY_PROVIDER } from '../../providers/thirdParty/huggingface.js';
export { MINIMAX_API_KEY_PROVIDER } from '../../providers/thirdParty/minimax.js';
export { OPENAI_API_KEY_PROVIDER } from '../../providers/thirdParty/openai.js';
export { XIAOMI_API_KEY_PROVIDER } from '../../providers/thirdParty/xiaomi.js';
export { ZAI_API_KEY_PROVIDER } from '../../providers/thirdParty/zai.js';

import { ALIBABA_STANDARD_API_KEY_PROVIDER } from '../../providers/alibaba/modelStudio.js';
import { DEEPSEEK_API_KEY_PROVIDER } from '../../providers/thirdParty/deepseek.js';
import { HUGGINGFACE_API_KEY_PROVIDER } from '../../providers/thirdParty/huggingface.js';
import { MINIMAX_API_KEY_PROVIDER } from '../../providers/thirdParty/minimax.js';
import { OPENAI_API_KEY_PROVIDER } from '../../providers/thirdParty/openai.js';
import { XIAOMI_API_KEY_PROVIDER } from '../../providers/thirdParty/xiaomi.js';
import { ZAI_API_KEY_PROVIDER } from '../../providers/thirdParty/zai.js';
import type {
  AnyApiKeyProviderConfig,
  ApiKeyProviderConfig,
} from './defineApiKeyProvider.js';

export type ApiKeyProviderRegion = string;

export const API_KEY_PROVIDERS = {
  alibabaStandard: ALIBABA_STANDARD_API_KEY_PROVIDER,
  deepseek: DEEPSEEK_API_KEY_PROVIDER,
  openai: OPENAI_API_KEY_PROVIDER,
  huggingface: HUGGINGFACE_API_KEY_PROVIDER,
  minimax: MINIMAX_API_KEY_PROVIDER,
  zai: ZAI_API_KEY_PROVIDER,
  xiaomi: XIAOMI_API_KEY_PROVIDER,
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

  if (provider.regions) {
    return provider.regions.some((region) => region.endpoint === baseUrl);
  }

  return baseUrl === provider.endpoint;
}
