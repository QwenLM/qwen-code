/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider registry — imports all provider definitions and assembles the
 * lookup tables used by the UI and CLI commands.
 */

import { providerMatchesCredentials } from './provider-config.js';
import type { ProviderConfig } from './types.js';
import { codingPlanProvider } from './presets/alibaba-coding-plan.js';
import { tokenPlanProvider } from './presets/alibaba-token-plan.js';
import { alibabaStandardProvider } from './presets/alibaba-standard.js';
import { openRouterProvider } from './presets/openrouter.js';
import { requestyProvider } from './presets/requesty.js';
import { pleumRouterProvider } from './presets/pleumrouter.js';
import { deepseekProvider } from './presets/deepseek.js';
import { minimaxProvider } from './presets/minimax.js';
import { zaiProvider } from './presets/zai.js';
import { idealabProvider } from './presets/idealab.js';
import { modelscopeProvider } from './presets/modelscope.js';
import { customProvider } from './presets/custom-provider.js';

// Re-export all providers
export {
  codingPlanProvider,
  tokenPlanProvider,
  alibabaStandardProvider,
  openRouterProvider,
  requestyProvider,
  pleumRouterProvider,
  deepseekProvider,
  minimaxProvider,
  zaiProvider,
  idealabProvider,
  modelscopeProvider,
  customProvider,
};
export {
  CUSTOM_API_KEY_ENV_PREFIX,
  generateCustomEnvKey,
} from './presets/custom-provider.js';

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/** All known providers, in display order. */
export const ALL_PROVIDERS: readonly ProviderConfig[] = [
  codingPlanProvider,
  tokenPlanProvider,
  alibabaStandardProvider,
  deepseekProvider,
  minimaxProvider,
  zaiProvider,
  idealabProvider,
  modelscopeProvider,
  openRouterProvider,
  requestyProvider,
  pleumRouterProvider,
  customProvider,
];

/** Providers grouped by uiGroup. */
export const ALIBABA_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === 'alibaba',
);
export const THIRD_PARTY_PROVIDERS = ALL_PROVIDERS.filter(
  (p) => p.uiGroup === 'third-party',
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
    if (Array.isArray(p.baseUrl))
      return p.baseUrl.map((o: { url: string }) => o.url);
    return [];
  });
}
