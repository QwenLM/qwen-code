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
  description: 'Browser OAuth · Auto-configure API key and OpenRouter models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: OPENROUTER_BASE_URL,
  envKey: OPENROUTER_ENV_KEY,
  authMethod: 'oauth',
  models: undefined,
  modelNamePrefix: 'OpenRouter',
  ownsModel: (model) => (model.baseUrl ?? '').includes('openrouter.ai'),
  uiGroup: 'oauth',
};
