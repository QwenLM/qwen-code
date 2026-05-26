/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const openRouterProvider: ProviderConfig = {
  id: 'openrouter',
  label: 'OpenRouter',
  description:
    'Connect with an OpenRouter API key (get one from openrouter.ai/keys)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: OPENROUTER_BASE_URL,
  envKey: OPENROUTER_ENV_KEY,
  models: [
    { id: 'z-ai/glm-4.5-air:free', contextWindowSize: 128000 },
    { id: 'openai/gpt-oss-120b:free', contextWindowSize: 131072 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'OpenRouter',
  ownsModel: (model) => {
    // A user who manually added an OpenRouter-routed model under a custom
    // envKey (e.g. their own gateway) shouldn't have their entry silently
    // removed on re-install — require BOTH the hostname *and* our envKey to
    // claim ownership.
    if (model.envKey !== OPENROUTER_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? '').hostname;
      return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
    } catch {
      return false;
    }
  },
  documentationUrl: 'https://openrouter.ai/docs',
  uiGroup: 'third-party',
};
