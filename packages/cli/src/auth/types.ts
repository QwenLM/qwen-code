/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  Config,
  ModelProvidersConfig,
  ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import type { SettingScope, LoadedSettings } from '../config/settings.js';

export type ProviderId = string;

export type ProviderCategory = 'recommended' | 'third-party' | 'custom';

export type ProviderSetupMethodType =
  | 'api-key'
  | 'oauth'
  | 'subscription'
  | 'manual';

export interface ProviderSetupMethod {
  type: ProviderSetupMethodType;
}

export interface ProviderSetupContext {
  settings: LoadedSettings;
  config: Config;
}

export type ProviderSetupInput = Record<string, unknown>;

export type ProviderSetupResult = Record<string, unknown>;

export interface ProviderValidationResult {
  valid: boolean;
  message?: string;
}

export interface LlmProvider {
  id: ProviderId;
  label: string;
  description?: string;
  category: ProviderCategory;
  protocol: AuthType;
  setupMethods: ProviderSetupMethod[];
  getDefaultModels?(): ProviderModelConfig[];
  ownsModel?(model: ProviderModelConfig): boolean;
  runSetup?(
    input: ProviderSetupInput,
    context: ProviderSetupContext,
  ): Promise<ProviderSetupResult>;
  createInstallPlan(
    input: ProviderSetupInput,
    context: ProviderSetupContext,
    setupResult?: ProviderSetupResult,
  ): Promise<ProviderInstallPlan>;
  validateInstall?(
    plan: ProviderInstallPlan,
    context: ProviderSetupContext,
  ): Promise<ProviderValidationResult>;
}

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

export interface ProviderInstallState {
  codingPlan?: {
    baseUrl?: string;
    version?: string;
  };
  tokenPlan?: {
    baseUrl?: string;
    version?: string;
  };
}

export interface ApplyProviderInstallPlanOptions {
  settings: LoadedSettings;
  config: Config;
  provider: LlmProvider;
  scope?: SettingScope;
  refreshAuth?: boolean;
}

export interface ApplyProviderInstallPlanResult {
  persistScope: SettingScope;
  updatedModelProviders: ModelProvidersConfig;
}
