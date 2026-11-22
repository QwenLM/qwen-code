/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const DEEPINFRA_ENV_KEY = 'DEEPINFRA_API_KEY';
export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';

export const deepinfraProvider: ProviderConfig = {
  id: 'deepinfra',
  label: 'DeepInfra',
  description:
    'Connect with a DeepInfra API key (get one from deepinfra.com/dash/api_keys)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: DEEPINFRA_BASE_URL,
  envKey: DEEPINFRA_ENV_KEY,
  models: [
    { id: 'deepseek-ai/DeepSeek-V3', contextWindowSize: 128000 },
    { id: 'deepseek-ai/DeepSeek-R1', contextWindowSize: 128000 },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', contextWindowSize: 128000 },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', contextWindowSize: 131072 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'DeepInfra',
  ownsModel: (model) => {
    if (model.envKey !== DEEPINFRA_ENV_KEY) return false;
    try {
      const host = new URL(model.baseUrl ?? '').hostname;
      return host === 'api.deepinfra.com' || host.endsWith('.deepinfra.com');
    } catch {
      return false;
    }
  },
  customHeaders: {
    'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
    'X-Title': 'Qwen Code',
  },
  documentationUrl: 'https://docs.deepinfra.com',
  uiGroup: 'third-party',
};
