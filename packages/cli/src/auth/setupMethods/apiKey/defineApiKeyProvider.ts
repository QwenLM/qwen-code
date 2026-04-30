/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ApiKeyProviderRegionConfig<TRegion extends string = string> {
  id: TRegion;
  title: string;
  endpoint: string;
  documentationUrl: string;
}

export interface ApiKeyProviderConfig<TRegion extends string = string> {
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

export type AnyApiKeyProviderConfig = ApiKeyProviderConfig<string>;

export function defineApiKeyProvider<TRegion extends string>(
  provider: ApiKeyProviderConfig<TRegion>,
): ApiKeyProviderConfig<TRegion> {
  return provider;
}
