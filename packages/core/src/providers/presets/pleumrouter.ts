/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const PLEUMROUTER_ENV_KEY = 'PLEUMROUTER_API_KEY';
export const PLEUMROUTER_BASE_URL = 'https://router.pleum.ai/v1';

export const pleumRouterProvider: ProviderConfig = {
  id: 'pleumrouter',
  label: 'PleumRouter',
  description:
    'Connect with a PleumRouter API key (get one from router.pleum.ai). ' +
    'Korea-region OpenAI-compatible multi-provider LLM gateway.',
  protocol: AuthType.USE_OPENAI,
  baseUrl: PLEUMROUTER_BASE_URL,
  envKey: PLEUMROUTER_ENV_KEY,
  models: [
    { id: 'gpt-5.5', contextWindowSize: 1050000 },
    { id: 'claude-opus-4-8', contextWindowSize: 1000000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'PleumRouter',
  ownsModel: (model) => {
    if (model.envKey !== PLEUMROUTER_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? '').hostname;
      return host === 'router.pleum.ai' || host.endsWith('.pleum.ai');
    } catch {
      return false;
    }
  },
  customHeaders: {
    'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
    'X-Title': 'Qwen Code',
  },
  documentationUrl: 'https://router.pleum.ai/docs',
  uiGroup: 'third-party',
};
