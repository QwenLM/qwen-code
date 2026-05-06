/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider registry — imports all provider definitions and assembles the
 * lookup tables used by the UI and CLI commands.
 */

import {
  providerMatchesCredentials,
  type ProviderConfig,
} from './providerConfig.js';

// ---------------------------------------------------------------------------
// Import all providers from their respective files
// ---------------------------------------------------------------------------

export {
  codingPlanProviderConfig,
  codingPlanProviderConfig as codingPlanProvider,
} from './providers/alibaba/codingPlan.js';
export {
  tokenPlanProviderConfig,
  tokenPlanProviderConfig as tokenPlanProvider,
} from './providers/alibaba/tokenPlan.js';
export { alibabaStandardProvider } from './providers/alibaba/alibabaStandard.js';
export {
  openRouterProviderConfig,
  openRouterProviderConfig as openRouterProvider,
} from './providers/oauth/openrouter.js';
export { deepseekProvider } from './providers/thirdParty/deepseek.js';
export { minimaxProvider } from './providers/thirdParty/minimax.js';
export { zaiProvider } from './providers/thirdParty/zai.js';
export {
  customProvider,
  CUSTOM_API_KEY_ENV_PREFIX,
  generateCustomEnvKey,
} from './providers/custom/customProvider.js';

import { codingPlanProviderConfig } from './providers/alibaba/codingPlan.js';
import { tokenPlanProviderConfig } from './providers/alibaba/tokenPlan.js';
import { alibabaStandardProvider } from './providers/alibaba/alibabaStandard.js';
import { openRouterProviderConfig } from './providers/oauth/openrouter.js';
import { deepseekProvider } from './providers/thirdParty/deepseek.js';
import { minimaxProvider } from './providers/thirdParty/minimax.js';
import { zaiProvider } from './providers/thirdParty/zai.js';
import { customProvider } from './providers/custom/customProvider.js';

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/** All known providers, in display order. */
export const ALL_PROVIDERS: readonly ProviderConfig[] = [
  codingPlanProviderConfig,
  tokenPlanProviderConfig,
  alibabaStandardProvider,
  openRouterProviderConfig,
  deepseekProvider,
  minimaxProvider,
  zaiProvider,
  customProvider,
];

/** Providers grouped by uiGroup. */
export const ALIBABA_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === 'alibaba',
);
export const THIRD_PARTY_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === 'third-party',
);
export const OAUTH_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === 'oauth',
);

export function findProviderById(id: string): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

/** Find a provider by model credentials (baseUrl + envKey). */
export function findProviderByCredentials(
  baseUrl: string | undefined,
  envKey: string | undefined,
): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) =>
    providerMatchesCredentials(p, baseUrl, envKey),
  );
}

/** All known provider base URLs (for preconnect, validation, etc.). */
export function getAllProviderBaseUrls(): string[] {
  return ALL_PROVIDERS.flatMap((p) => {
    if (typeof p.baseUrl === 'string') return [p.baseUrl];
    if (Array.isArray(p.baseUrl)) return p.baseUrl.map((o) => o.url);
    return [];
  });
}

// Re-export providerConfig utilities for convenience
export {
  buildInstallPlan,
  toLlmProvider,
  resolveBaseUrl,
  getDefaultModelIds,
  shouldShowStep,
  computeModelListVersion,
} from './providerConfig.js';
