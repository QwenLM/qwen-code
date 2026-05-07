/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const deepseekProvider: ProviderConfig = {
  id: 'deepseek',
  label: 'DeepSeek API Key',
  description: 'Quick setup for DeepSeek (deepseek-v4-flash, deepseek-v4-pro)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: 'https://api.deepseek.com',
  envKey: 'DEEPSEEK_API_KEY',
  authMethod: 'input',
  models: [
    {
      id: 'deepseek-v4-pro',
      contextWindowSize: 1000000,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
    { id: 'deepseek-v4-flash', contextWindowSize: 1000000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'DeepSeek',
  documentationUrl: 'https://api-docs.deepseek.com/zh-cn/',
  uiGroup: 'third-party',
};
