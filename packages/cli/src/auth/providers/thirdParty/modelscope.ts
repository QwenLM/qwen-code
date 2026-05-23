/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const modelscopeProvider: ProviderConfig = {
  id: 'modelscope',
  label: 'ModelScope API Key',
  description: 'Quick setup for ModelScope API Inference',
  protocol: AuthType.USE_OPENAI,
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  envKey: 'MODELSCOPE_API_KEY',
  authMethod: 'input',
  models: [
    {
      id: 'deepseek-ai/DeepSeek-V4-Flash',
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    {
      id: 'Qwen/Qwen3.5-397B-A17B',
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    {
      id: 'ZhipuAI/GLM-5.1',
      contextWindowSize: 1000000,
      enableThinking: true,
    },
  ],
  modelsEditable: true,
  modelNamePrefix: 'ModelScope',
  documentationUrl:
    'https://modelscope.cn/docs/model-service/API-Inference/intro',
  uiGroup: 'third-party',
};
