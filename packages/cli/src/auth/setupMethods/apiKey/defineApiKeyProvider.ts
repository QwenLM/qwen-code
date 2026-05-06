/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ApiKeyProviderEndpointOptionConfig<
  TEndpointOption extends string = string,
> {
  id: TEndpointOption;
  title: string;
  endpoint: string;
  documentationUrl: string;
}

export interface ApiKeyProviderUiConfig {
  flowTitle?: string;
  endpointStepTitle?: string;
}

export interface ApiKeyProviderConfig<TEndpointOption extends string = string> {
  id: string;
  option: string;
  title: string;
  description: string;
  category: 'alibaba' | 'third-party';
  envKey: string;
  modelNamePrefix: string;
  defaultModelIds: string;
  documentationUrl?: string;
  endpoint?: string;
  endpointOptions?: ReadonlyArray<
    ApiKeyProviderEndpointOptionConfig<TEndpointOption>
  >;
  ui?: ApiKeyProviderUiConfig;
}

export type AnyApiKeyProviderConfig = ApiKeyProviderConfig<string>;

export function defineApiKeyProvider<TEndpointOption extends string>(
  provider: ApiKeyProviderConfig<TEndpointOption>,
): ApiKeyProviderConfig<TEndpointOption> {
  return provider;
}
