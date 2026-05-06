/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import {
  API_KEY_PROVIDER_OPTIONS,
  API_KEY_PROVIDERS,
  type ApiKeyProviderConfig,
  type ApiKeyProviderEndpointOption,
  type ApiKeyProviderEndpointOptionConfig,
  type ApiKeyProviderId,
} from '../../../auth/setupMethods/apiKey/index.js';
import type {
  ApiKeyOption,
  PresetApiKeyState,
  ThirdPartyProviderItem,
} from './AuthFlowTypes.js';

function getDefaultEndpointOption(
  provider: ApiKeyProviderConfig,
): ApiKeyProviderEndpointOption | undefined {
  return provider.endpointOptions?.[0]?.id;
}

function getSelectedEndpointOptionConfig(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): ApiKeyProviderEndpointOptionConfig | undefined {
  return provider.endpointOptions?.find(
    (candidate) => candidate.id === endpointOption,
  );
}

function getProviderEndpoint(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): string {
  return (
    getSelectedEndpointOptionConfig(provider, endpointOption)?.endpoint ||
    provider.endpoint ||
    ''
  );
}

function getProviderDocumentationUrl(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): string | undefined {
  return (
    getSelectedEndpointOptionConfig(provider, endpointOption)
      ?.documentationUrl || provider.documentationUrl
  );
}

export function getProviderFlowTitle(
  provider: ApiKeyProviderConfig,
  fallback: string,
): string {
  return provider.ui?.flowTitle || fallback;
}

export function getEndpointStepTitle(provider: ApiKeyProviderConfig): string {
  return provider.ui?.endpointStepTitle || 'Endpoint';
}

export function getApiKeyProviderStepCount(
  provider: ApiKeyProviderConfig,
): number {
  return provider.endpointOptions ? 4 : 3;
}

interface UsePresetApiKeyFlowParams {
  onSubmit: (
    providerId: ApiKeyProviderId,
    apiKey: string,
    modelIdsInput: string,
    endpointOption?: ApiKeyProviderEndpointOption,
  ) => void;
}

export function usePresetApiKeyFlow({ onSubmit }: UsePresetApiKeyFlowParams) {
  const [endpointOptionIndex, setEndpointOptionIndex] = useState<number>(0);
  const [apiKeyTypeIndex, setApiKeyTypeIndex] = useState<number>(0);
  const [provider, setProvider] = useState<ApiKeyProviderConfig>(
    API_KEY_PROVIDERS.alibabaStandard,
  );
  const [endpointOption, setEndpointOption] = useState<
    ApiKeyProviderEndpointOption | undefined
  >(getDefaultEndpointOption(API_KEY_PROVIDERS.alibabaStandard));
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const [modelIdError, setModelIdError] = useState<string | null>(null);

  const providerItems: ThirdPartyProviderItem[] =
    API_KEY_PROVIDER_OPTIONS.filter(
      (candidate) => candidate.category === 'third-party',
    ).map((candidate) => ({
      key: candidate.option,
      title: t(candidate.title),
      label: t(candidate.title),
      description: t(candidate.description),
      value: candidate.option as ApiKeyOption,
    }));

  const endpointOptionItems =
    provider.endpointOptions?.map((endpointOptionConfig) => ({
      key: endpointOptionConfig.id,
      title: t(endpointOptionConfig.title),
      label: t(endpointOptionConfig.title),
      description: (
        <Text color={theme.text.secondary}>
          Endpoint: {endpointOptionConfig.endpoint}
        </Text>
      ),
      value: endpointOptionConfig.id,
    })) || [];

  const selectProvider = (value: ApiKeyOption): ApiKeyProviderConfig | null => {
    const selectedProvider = API_KEY_PROVIDER_OPTIONS.find(
      (candidate) => candidate.option === value,
    ) as ApiKeyProviderConfig | undefined;
    if (!selectedProvider) {
      return null;
    }

    setProvider(selectedProvider);
    setEndpointOption(getDefaultEndpointOption(selectedProvider));
    setEndpointOptionIndex(0);
    setApiKey('');
    setApiKeyError(null);
    setModelId(selectedProvider.defaultModelIds);
    setModelIdError(null);
    return selectedProvider;
  };

  const selectEndpointOption = (
    selectedEndpointOption: ApiKeyProviderEndpointOption,
  ) => {
    setApiKeyError(null);
    setModelIdError(null);
    setEndpointOption(selectedEndpointOption);
  };

  const changeApiKey = (value: string) => {
    setApiKey(value);
    if (apiKeyError) {
      setApiKeyError(null);
    }
  };

  const submitApiKey = (): boolean => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setApiKeyError(t('API key cannot be empty.'));
      return false;
    }

    setApiKeyError(null);
    if (!modelId.trim()) {
      setModelId(provider.defaultModelIds);
    }
    return true;
  };

  const changeModelId = (value: string) => {
    setModelId(value);
    if (modelIdError) {
      setModelIdError(null);
    }
  };

  const submitModel = (): 'submitted' | 'api-key-error' | 'model-error' => {
    const trimmedApiKey = apiKey.trim();
    const trimmedModelIds = modelId.trim();
    if (!trimmedApiKey) {
      setApiKeyError(t('API key cannot be empty.'));
      return 'api-key-error';
    }
    if (!trimmedModelIds) {
      setModelIdError(t('Model IDs cannot be empty.'));
      return 'model-error';
    }

    setModelIdError(null);
    onSubmit(
      provider.id as ApiKeyProviderId,
      trimmedApiKey,
      trimmedModelIds,
      endpointOption || getDefaultEndpointOption(provider),
    );
    return 'submitted';
  };

  const state: PresetApiKeyState = {
    providerTitle: provider.title,
    providerDefaultModelIds: provider.defaultModelIds,
    endpointOption,
    endpointOptionItems,
    endpointOptionIndex,
    apiKey,
    apiKeyError,
    modelId,
    modelIdError,
    endpoint: getProviderEndpoint(provider, endpointOption),
    documentationUrl: getProviderDocumentationUrl(provider, endpointOption),
  };

  return {
    provider,
    providerItems,
    providerIndex: apiKeyTypeIndex,
    state,
    selectProvider,
    setProviderIndex: setApiKeyTypeIndex,
    selectEndpointOption,
    setEndpointOptionIndex,
    changeApiKey,
    submitApiKey,
    changeModelId,
    submitModel,
  };
}
