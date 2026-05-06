/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import type { AuthType } from '@qwen-code/qwen-code-core';
import type { DescriptiveRadioSelectItem } from '../../components/shared/DescriptiveRadioButtonSelect.js';
import type { ApiKeyProviderRegion } from '../../../auth/setupMethods/apiKey/index.js';

export type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'OAUTH'
  | 'CUSTOM_PROVIDER';

export type SubscribeOption = string;
export type ApiKeyOption = string;
export type OAuthOption = 'OPENROUTER_OAUTH' | 'QWEN_OAUTH_DISCONTINUED';

export type ViewLevel =
  | 'main'
  | 'alibaba-modelstudio-select'
  | 'base-url-select'
  | 'api-key-input'
  | 'api-key-type-select'
  | 'preset-api-key-region-select'
  | 'preset-api-key-input'
  | 'preset-model-id-input'
  | 'custom-protocol-select'
  | 'custom-base-url-input'
  | 'custom-api-key-input'
  | 'custom-model-id-input'
  | 'custom-advanced-config'
  | 'custom-review-json'
  | 'oauth-provider-select';

export interface PresetApiKeyState {
  providerTitle: string;
  providerDefaultModelIds: string;
  region?: ApiKeyProviderRegion;
  regionItems: Array<DescriptiveRadioSelectItem<ApiKeyProviderRegion>>;
  regionIndex: number;
  apiKey: string;
  apiKeyError: string | null;
  modelId: string;
  modelIdError: string | null;
  endpoint: string;
  documentationUrl?: string;
}

export interface CustomProviderState {
  protocolItems: Array<DescriptiveRadioSelectItem<AuthType>>;
  protocolIndex: number;
  protocol: AuthType;
  baseUrl: string;
  baseUrlError: string | null;
  apiKey: string;
  apiKeyError: string | null;
  modelIds: string;
  modelIdsError: string | null;
  focusedConfigIndex: number;
  thinkingEnabled: boolean;
  modalityEnabled: boolean;
  previewJson: string;
}

export type BaseUrlItem = DescriptiveRadioSelectItem<string>;
export type AlibabaModelStudioItem = DescriptiveRadioSelectItem<
  SubscribeOption | ApiKeyOption
>;
export type ThirdPartyProviderItem = DescriptiveRadioSelectItem<ApiKeyOption>;
export type OAuthProviderItem = DescriptiveRadioSelectItem<OAuthOption>;
export type MainAuthItem = DescriptiveRadioSelectItem<MainOption>;

export interface SubscriptionApiKeyPlan {
  apiKeyUrl: string;
  helpText: string;
  placeholder: string;
  validate?: (apiKey: string) => string | null;
}

export interface AlibabaModelStudioFlowProps {
  viewLevel: ViewLevel;
  items: AlibabaModelStudioItem[];
  initialIndex: number;
  baseUrlItems: BaseUrlItem[];
  baseUrlIndex: number;
  subscriptionApiKeyPlan: SubscriptionApiKeyPlan;
  onSelect: (value: SubscribeOption | ApiKeyOption) => void;
  onHighlight: (value: SubscribeOption | ApiKeyOption) => void;
  onBaseUrlSelect: (baseUrl: string) => void;
  onBaseUrlHighlight: (baseUrl: string) => void;
  onApiKeySubmit: (apiKey: string) => void;
  onBack: () => void;
}

export interface ThirdPartyProvidersFlowProps {
  viewLevel: ViewLevel;
  items: ThirdPartyProviderItem[];
  initialIndex: number;
  preset: PresetApiKeyState;
  onSelect: (value: ApiKeyOption) => void;
  onHighlight: (value: ApiKeyOption) => void;
  onRegionSelect: (region: ApiKeyProviderRegion) => void;
  onRegionHighlight: (region: ApiKeyProviderRegion) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeySubmit: () => void;
  onModelIdChange: (value: string) => void;
  onModelSubmit: () => void;
}

export interface OAuthFlowProps {
  items: OAuthProviderItem[];
  initialIndex: number;
  onSelect: (value: OAuthOption) => void;
  onHighlight: (value: OAuthOption) => void;
}

export interface CustomProviderFlowProps {
  viewLevel: ViewLevel;
  state: CustomProviderState;
  documentationUrl: string;
  onProtocolSelect: (protocol: AuthType) => void;
  onProtocolHighlight: (protocol: AuthType) => void;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlSubmit: () => void;
  onApiKeyChange: (value: string) => void;
  onApiKeySubmit: () => void;
  onModelIdsChange: (value: string) => void;
  onModelIdsSubmit: () => void;
}

export type ReactNode = React.ReactNode;
