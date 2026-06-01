/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const idealabProvider: ProviderConfig = {
  id: 'idealab',
  label: 'Idealab API Key',
  description:
    'Alibaba internal LLM service (Qwen3.6-Plus-DogFooding, DeepSeek V4, Kimi K2.6)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
  envKey: 'IDEALAB_API_KEY',
  authMethod: 'input',
  models: [
    {
      id: 'Qwen3.6-Plus-DogFooding',
      contextWindowSize: 1000000,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
    {
      id: 'bailian/deepseek-v4-pro',
      contextWindowSize: 1000000,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
    {
      id: 'bailian/deepseek-v4-flash',
      contextWindowSize: 1000000,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
    {
      id: 'bailian/kimi-k2.6',
      contextWindowSize: 262144,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Idealab',
  uiGroup: 'third-party',
};
