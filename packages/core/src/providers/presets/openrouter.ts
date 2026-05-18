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
  ownsModel: (model) => (model.baseUrl ?? '').includes('openrouter.ai'),
  documentationUrl: 'https://openrouter.ai/docs',
  uiGroup: 'third-party',
};
