/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

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
  models: [
    {
      id: 'qwen3.6-plus',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        },
      },
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    {
      id: 'qwen3.7-plus',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        },
      },
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    {
      id: 'qwen3.7-max',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        },
      },
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    { id: 'glm-5.1', contextWindowSize: 202752, enableThinking: true },
    {
      id: 'deepseek-v4-pro',
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['high', 'max'],
          defaultEffort: 'high',
          disableField: 'enable_thinking',
        },
      },
      contextWindowSize: 1000000,
    },
    {
      id: 'deepseek-v4-flash',
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['high', 'max'],
          defaultEffort: 'high',
          disableField: 'enable_thinking',
        },
      },
      contextWindowSize: 1000000,
    },
    {
      id: 'qwen3.8-max',
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'medium', 'xhigh'],
          defaultEffort: 'xhigh',
          disableField: 'reasoning_effort',
        },
      },
      modalities: { image: true, video: true },
    },
    {
      id: 'qwen3.8-max-0902',
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'medium', 'xhigh'],
          defaultEffort: 'xhigh',
          disableField: 'reasoning_effort',
        },
      },
      modalities: { image: true, video: true },
    },
    {
      id: 'qwen3.8-flash',
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'medium', 'xhigh'],
          defaultEffort: 'xhigh',
          disableField: 'reasoning_effort',
        },
      },
      modalities: { image: true, video: true },
    },
    {
      id: 'deepseek-v4-pro-0813',
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'high',
          disableField: 'enable_thinking',
        },
      },
    },
    {
      id: 'deepseek-v4-flash-0731',
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'high',
          disableField: 'enable_thinking',
        },
      },
    },
    {
      id: 'kimi-k3',
      thinkingMandatory: true,
      contextWindowSize: 1000000,
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
          canDisable: false,
          disableField: 'reasoning_effort',
        },
      },
      modalities: { image: true },
    },
    {
      id: 'kimi-k2.7-code',
      thinkingMandatory: true,
      enableThinking: true,
      contextWindowSize: 262144,
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: 'enable_thinking',
        },
      },
      modalities: { image: true, video: true },
    },
    {
      id: 'kimi-k2.6',
      enableThinking: true,
      contextWindowSize: 262144,
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        },
      },
      modalities: { image: true, video: true },
    },
  ],
  modelsEditable: true,
  modelNamePrefix: 'ModelStudio Standard',
  // The Responses API on these endpoints serves the server-side `web_search`
  // / `web_extractor` tools with the same key, so the built-in tool needs no
  // extra configuration.
  webSearch: { backend: 'dashscope' },
  uiGroup: 'alibaba',
  uiLabels: { flowTitle: 'Alibaba ModelStudio', baseUrlStepTitle: 'Region' },
};
