/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export type AlibabaStandardRegion =
  | 'cn-beijing'
  | 'sg-singapore'
  | 'us-virginia'
  | 'cn-hongkong';

export const ALIBABA_STANDARD_API_KEY_PROVIDER =
  defineApiKeyProvider<AlibabaStandardRegion>({
    id: 'alibabaStandard',
    option: 'ALIBABA_STANDARD_API_KEY',
    title: 'Alibaba Cloud ModelStudio Standard API Key',
    description: 'Quick setup for Model Studio (China/International)',
    envKey: 'DASHSCOPE_API_KEY',
    modelNamePrefix: 'ModelStudio Standard',
    defaultModelIds: 'qwen3.5-plus,glm-5,kimi-k2.5',
    regions: [
      {
        id: 'cn-beijing',
        title: 'China (Beijing)',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        documentationUrl:
          'https://bailian.console.aliyun.com/cn-beijing?tab=api#/api',
      },
      {
        id: 'sg-singapore',
        title: 'Singapore',
        endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        documentationUrl:
          'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=api#/api/?type=model&url=2712195',
      },
      {
        id: 'us-virginia',
        title: 'US (Virginia)',
        endpoint: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        documentationUrl:
          'https://modelstudio.console.alibabacloud.com/us-east-1?tab=api#/api/?type=model&url=2712195',
      },
      {
        id: 'cn-hongkong',
        title: 'China (Hong Kong)',
        endpoint:
          'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
        documentationUrl:
          'https://modelstudio.console.alibabacloud.com/cn-hongkong?tab=api#/api/?type=model&url=2712195',
      },
    ],
  });
