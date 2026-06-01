/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const alibabaStandardProvider: ProviderConfig = {
  id: 'alibabaStandard',
  label: 'Standard API Key',
  description: 'Connect with an existing ModelStudio API key',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'cn-beijing',
      label: 'China (Beijing)',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api',
    },
    {
      id: 'sg-singapore',
      label: 'Singapore',
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=api#/api/?type=model&url=2712195',
    },
    {
      id: 'us-virginia',
      label: 'US (Virginia)',
      url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://modelstudio.console.alibabacloud.com/us-east-1?tab=api#/api/?type=model&url=2712195',
    },
    {
      id: 'cn-hongkong',
      label: 'China (Hong Kong)',
      url: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://modelstudio.console.alibabacloud.com/cn-hongkong?tab=api#/api/?type=model&url=2712195',
    },
  ],
  envKey: 'DASHSCOPE_API_KEY',
  authMethod: 'input',
  models: [
    { id: 'qwen3.6-plus', contextWindowSize: 1000000, enableThinking: true },
    { id: 'glm-5.1', contextWindowSize: 202752, enableThinking: true },
    {
      id: 'deepseek-v4-pro',
      contextWindowSize: 1000000,
      enableThinking: true,
      modalities: { image: true, video: true },
    },
    { id: 'deepseek-v4-flash', contextWindowSize: 1000000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'ModelStudio Standard',
  uiGroup: 'alibaba',
  uiLabels: { flowTitle: 'Alibaba ModelStudio', baseUrlStepTitle: 'Region' },
};
