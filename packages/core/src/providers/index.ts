/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Types
export type {
  BaseUrlOption,
  ModelSpec,
  ProviderId,
  ProviderConfig,
  ProviderInstallPlan,
  ProviderInstallState,
  ProviderModelConfig,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
  ProviderSetupInputs,
} from './types.js';

// Provider config utilities
export {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  findExistingProviderModels,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  legacyEnvKeyAttribution,
  normalizeBaseUrlForMatching,
  providerMatchesCredentials,
  PROVIDER_METADATA_NS,
  resolveBaseUrl,
  resolveMetadataKey,
  resolveOwnsModel,
  resolveProviderModels,
  shouldShowStep,
} from './provider-config.js';

export { discoverProviderModels } from './model-discovery.js';

// Provider registry
export {
  ALL_PROVIDERS,
  ALIBABA_PROVIDERS,
  alibabaStandardProvider,
  codingPlanProvider,
  CUSTOM_API_KEY_ENV_PREFIX,
  customProvider,
  deepseekProvider,
  findProviderByCredentials,
  findProviderById,
  generateCustomEnvKey,
  legacyCustomEnvKey,
  legacyCustomEnvKey6Hex,
  getAllProviderBaseUrls,
  grokProvider,
  idealabProvider,
  kimiProvider,
  minimaxProvider,
  modelscopeProvider,
  moonshotProvider,
  openRouterProvider,
  requestyProvider,
  THIRD_PARTY_PROVIDERS,
  tokenPlanProvider,
  xiaomiMimoProvider,
  zaiProvider,
} from './all-providers.js';

// Preset constants
export {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  CODING_PLAN_GLOBAL_BASE_URL,
} from './presets/alibaba-coding-plan.js';
export {
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_CHINA_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_GLOBAL_BASE_URL,
} from './presets/alibaba-token-plan.js';
export { GROK_BASE_URL, GROK_ENV_KEY } from './presets/grok.js';
export {
  KIMI_API_ENV_KEY,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_ENV_KEY,
} from './presets/kimi.js';
export {
  OPENROUTER_BASE_URL,
  OPENROUTER_ENV_KEY,
} from './presets/openrouter.js';
export { REQUESTY_BASE_URL, REQUESTY_ENV_KEY } from './presets/requesty.js';
export {
  XIAOMI_MIMO_ENV_KEY,
  XIAOMI_MIMO_TOKEN_ENV_KEY,
} from './presets/xiaomi-mimo.js';

// Install logic
export {
  applyProviderInstallPlan,
  ProviderInstallError,
  type ApplyProviderInstallPlanOptions,
  type ApplyProviderInstallPlanResult,
} from './install.js';
