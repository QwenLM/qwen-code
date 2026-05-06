/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  ModelProvidersConfig,
  ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import type { SettingScope, LoadedSettings } from '../config/settings.js';

export type ProviderId = string;

export interface ProviderInstallPlan {
  providerId: ProviderId;
  authType: AuthType;
  env?: Record<string, string>;
  legacyCredentials?: {
    apiKey?: string;
    baseUrl?: string;
  };
  modelSelection?: {
    modelId: string;
  };
  modelProviders?: ProviderModelProvidersPatch[];
  providerState?: ProviderInstallState;
  display?: {
    successMessage?: string;
    nextSteps?: string[];
  };
}

export interface ProviderModelProvidersPatch {
  authType: AuthType;
  models: ProviderModelConfig[];
  mergeStrategy: 'prepend-and-remove-owned' | 'replace-owned' | 'append';
  ownsModel?: (model: ProviderModelConfig) => boolean;
}

/**
 * Arbitrary key-value metadata to persist alongside a provider install.
 * Each top-level key becomes a settings path prefix (e.g. `codingPlan.version`).
 */
export type ProviderInstallState = Record<string, Record<string, string>>;

export interface ApplyProviderInstallPlanOptions {
  settings: LoadedSettings;
  config: {
    reloadModelProvidersConfig: (mp: ModelProvidersConfig) => void;
    getModelsConfig: () => {
      syncAfterAuthRefresh: (authType: AuthType, modelId: string) => void;
    };
    refreshAuth: (authType: AuthType) => Promise<void>;
  };
  scope?: SettingScope;
  refreshAuth?: boolean;
}

export interface ApplyProviderInstallPlanResult {
  persistScope: SettingScope;
  updatedModelProviders: ModelProvidersConfig;
}
