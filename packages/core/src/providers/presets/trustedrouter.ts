/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const TRUSTEDROUTER_ENV_KEY = 'TRUSTEDROUTER_API_KEY';
export const TRUSTEDROUTER_BASE_URL = 'https://api.trustedrouter.com/v1';

export const trustedRouterProvider: ProviderConfig = {
  id: 'trustedrouter',
  label: 'TrustedRouter',
  description:
    'Connect with a TrustedRouter API key for OpenRouter-compatible routing',
  protocol: AuthType.USE_OPENAI,
  baseUrl: TRUSTEDROUTER_BASE_URL,
  envKey: TRUSTEDROUTER_ENV_KEY,
  models: [
    { id: 'trustedrouter/auto', contextWindowSize: 200000 },
    { id: 'trustedrouter/zdr', contextWindowSize: 200000 },
    { id: 'trustedrouter/e2e', contextWindowSize: 200000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'TrustedRouter',
  ownsModel: (model) => {
    if (model.envKey !== TRUSTEDROUTER_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? '').hostname;
      return host === 'api.trustedrouter.com';
    } catch {
      return false;
    }
  },
  documentationUrl: 'https://trustedrouter.com/docs',
  uiGroup: 'third-party',
};
