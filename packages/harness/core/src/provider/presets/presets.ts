/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PresetModel, ProviderPreset } from './types.js';

/**
 * Provider presets offered by the connect-provider wizard.
 *
 * Reasoning metadata only carries effort levels we can represent as model
 * preferences. Toggle-only thinking (no effort levels) stays server-side
 * default for now; those models still think without a client knob.
 */

const QWENCLOUD_MODELS: readonly PresetModel[] = [
  {
    id: 'qwen3.8-max',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' },
  },
  { id: 'qwen3.7-plus', contextWindow: 1_000_000, vision: true },
  {
    id: 'qwen3.8-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' },
  },
  {
    id: 'deepseek-v4-pro-0813',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'kimi-k3',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      canDisable: false,
    },
  },
  { id: 'glm-5.3', contextWindow: 1_000_000 },
];

const MODELSTUDIO_MODELS: readonly PresetModel[] = [
  { id: 'qwen3.5-plus', contextWindow: 1_000_000, vision: true },
  { id: 'qwen3.6-plus', contextWindow: 1_000_000, vision: true },
  { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
  { id: 'glm-5', contextWindow: 202_752 },
  { id: 'kimi-k2.5', contextWindow: 262_144, vision: true },
  { id: 'MiniMax-M2.5', contextWindow: 196_608 },
  { id: 'qwen3-coder-plus', contextWindow: 1_000_000 },
  { id: 'qwen3-coder-next', contextWindow: 262_144 },
  { id: 'qwen3-max-2026-01-23', contextWindow: 262_144 },
  { id: 'glm-4.7', contextWindow: 202_752 },
];

const TOKEN_PLAN_MODELS: readonly PresetModel[] = [
  { id: 'qwen3.7-plus', contextWindow: 1_000_000, vision: true },
  { id: 'qwen3.6-plus', contextWindow: 1_000_000, vision: true },
  { id: 'qwen3.7-max', contextWindow: 1_000_000 },
  {
    id: 'qwen3.8-max',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    },
  },
  { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
  {
    id: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    thinking: { efforts: ['high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4-flash-0731',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'kimi-k2.7-code',
    contextWindow: 262_144,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], canDisable: false },
  },
  { id: 'kimi-k2.6', contextWindow: 262_144 },
  { id: 'kimi-k2.5', contextWindow: 262_144, vision: true },
  { id: 'glm-5.3', contextWindow: 1_000_000 },
  { id: 'glm-5.2', contextWindow: 1_000_000 },
  { id: 'glm-5.1', contextWindow: 202_752 },
  { id: 'glm-5', contextWindow: 202_752 },
  { id: 'MiniMax-M2.5', contextWindow: 196_608 },
  {
    id: 'qwen3.8-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    },
  },
  {
    id: 'deepseek-v4-pro-0813',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
];

const ALIBABA_STANDARD_MODELS: readonly PresetModel[] = [
  { id: 'qwen3.6-plus', contextWindow: 1_000_000 },
  { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
  { id: 'qwen3.7-max', contextWindow: 1_000_000 },
  { id: 'glm-5.3', contextWindow: 1_000_000 },
  { id: 'glm-5.2', contextWindow: 1_000_000 },
  { id: 'glm-5.1', contextWindow: 202_752 },
  {
    id: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    thinking: { efforts: ['high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    contextWindow: 1_000_000,
    vision: true,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'qwen3.8-max',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    },
  },
  {
    id: 'qwen3.8-max-0902',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    },
  },
  {
    id: 'qwen3.8-flash',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'xhigh',
    },
  },
  {
    id: 'deepseek-v4-pro-0813',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-v4-flash-0731',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'kimi-k3',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      canDisable: false,
    },
  },
  { id: 'kimi-k2.7-code', contextWindow: 262_144, vision: true },
  { id: 'kimi-k2.6', contextWindow: 262_144, vision: true },
];

const DEEPSEEK_MODELS: readonly PresetModel[] = [
  {
    id: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
  {
    id: 'deepseek-flash',
    contextWindow: 1_000_000,
    thinking: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  },
];

const GROK_MODELS: readonly PresetModel[] = [
  { id: 'grok-4.5', contextWindow: 500_000 },
  { id: 'grok-4.3', contextWindow: 1_000_000 },
  { id: 'grok-4.20-0309-reasoning', contextWindow: 1_000_000 },
  { id: 'grok-4.20-0309-non-reasoning', contextWindow: 1_000_000 },
  { id: 'grok-4.20-multi-agent-0309', contextWindow: 1_000_000 },
  { id: 'grok-build-0.1', contextWindow: 262_144 },
];

const MINIMAX_MODELS: readonly PresetModel[] = [
  { id: 'MiniMax-M3', contextWindow: 1_000_000, vision: true },
  { id: 'MiniMax-M2.7', contextWindow: 204_800 },
  { id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800 },
  { id: 'MiniMax-M2.5', contextWindow: 196_608 },
  { id: 'MiniMax-M2.5-highspeed', contextWindow: 196_608 },
];

const ZAI_MODELS: readonly PresetModel[] = [
  { id: 'GLM-5.2', contextWindow: 1_000_000 },
  { id: 'GLM-5.1', contextWindow: 204_800 },
  { id: 'GLM-5', contextWindow: 204_800 },
  { id: 'GLM-5-Turbo', contextWindow: 204_800 },
];

const MOONSHOT_MODELS: readonly PresetModel[] = [
  {
    id: 'kimi-k3',
    contextWindow: 1_000_000,
    vision: true,
    thinking: {
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      canDisable: false,
    },
  },
  { id: 'kimi-k2.7-code', contextWindow: 262_144, vision: true },
  { id: 'kimi-k2.7-code-highspeed', contextWindow: 262_144, vision: true },
  { id: 'kimi-k2.6', contextWindow: 262_144, vision: true },
];

const IDEALAB_MODELS: readonly PresetModel[] = [
  { id: 'Qwen3.6-Plus-DogFooding', contextWindow: 1_000_000, vision: true },
  { id: 'bailian/deepseek-v4-pro', contextWindow: 1_000_000 },
  { id: 'bailian/deepseek-v4-flash', contextWindow: 1_000_000 },
  { id: 'bailian/kimi-k2.6', contextWindow: 262_144 },
];

const MODELSCOPE_MODELS: readonly PresetModel[] = [
  { id: 'deepseek-ai/DeepSeek-V4-Flash', contextWindow: 1_000_000 },
  { id: 'Qwen/Qwen3.5-397B-A17B', contextWindow: 1_000_000 },
  { id: 'ZhipuAI/GLM-5.1', contextWindow: 1_000_000 },
];

const OPENROUTER_MODELS: readonly PresetModel[] = [
  { id: 'z-ai/glm-4.5-air:free', contextWindow: 128_000 },
  { id: 'openai/gpt-oss-120b:free', contextWindow: 131_072 },
];

const REQUESTY_MODELS: readonly PresetModel[] = [
  { id: 'openai/gpt-4o-mini', contextWindow: 128_000 },
  { id: 'openai/gpt-4o', contextWindow: 128_000 },
];

export const qwencloudStandardPreset: ProviderPreset = {
  id: 'qwencloud-standard',
  label: 'Standard API Key',
  description:
    'Pay-as-you-go · Connect with an existing platform API key',
  protocol: 'openai',
  envKey: 'QWENCLOUD_API_KEY',
  endpoints: [
    {
      id: 'cn-qianwenai',
      label: 'China — 千问AI平台',
      url: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
      documentationUrl:
        'https://platform.qianwenai.com/docs/developer-guides/administration/api-keys',
    },
    {
      id: 'intl-qwencloud',
      label: 'International — QwenCloud',
      url: 'https://maas.qwencloudapi.com/compatible-mode/v1',
      documentationUrl:
        'https://docs.qwencloud.com/developer-guides/administration/api-keys',
    },
  ],
  models: QWENCLOUD_MODELS,
  supportsModelDiscovery: true,
  apiKeyPlaceholder: 'sk-...',
  validateApiKey: (key) =>
    key.startsWith('sk-') && !key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Pay-as-you-go keys start with "sk-" or "sk-ws-". Token Plan keys ("sk-sp-") need the Token Plan entry instead.',
  modelNamePrefix: 'QwenCloud Standard',
  group: 'qwencloud',
  flowTitle: 'QwenCloud',
  endpointStepTitle: 'Platform',
};

export const qwencloudTokenPlanPreset: ProviderPreset = {
  id: 'qwencloud-token-plan',
  label: 'Token Plan',
  description:
    'Subscription with a monthly Credit quota · Dedicated endpoint (Personal and Team editions)',
  protocol: 'openai',
  envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
  endpoints: [
    {
      id: 'cn-qianwenai',
      label: 'China — 千问AI平台',
      url: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
      documentationUrl:
        'https://platform.qianwenai.com/docs/token-plan/overview',
    },
    {
      id: 'intl-qwencloud',
      label: 'International — QwenCloud',
      url: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
      documentationUrl: 'https://docs.qwencloud.com/token-plan/overview',
    },
  ],
  models: QWENCLOUD_MODELS.filter((model) => model.id !== 'kimi-k3'),
  supportsModelDiscovery: true,
  apiKeyPlaceholder: 'sk-sp-...',
  validateApiKey: (key) =>
    key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Token Plan API keys start with "sk-sp-". Generate one from the Token Plan console, or use the Standard API Key entry for a pay-as-you-go key.',
  modelNamePrefix: (baseUrl) =>
    baseUrl === 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1'
      ? 'QwenCloud Token Plan for Global/Intl'
      : 'QwenCloud Token Plan',
  group: 'qwencloud',
  flowTitle: 'QwenCloud',
  endpointStepTitle: 'Platform',
};

export const codingPlanPreset: ProviderPreset = {
  id: 'coding-plan',
  label: 'Coding Plan',
  description: 'For individual developers · Weekly quota included',
  protocol: 'openai',
  envKey: 'BAILIAN_CODING_PLAN_API_KEY',
  endpoints: [
    {
      id: 'aliyun',
      label: 'China (Beijing)',
      url: 'https://coding.dashscope.aliyuncs.com/v1',
      documentationUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    },
    {
      id: 'alibabacloud',
      label: 'Singapore (International)',
      url: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      documentationUrl:
        'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    },
  ],
  models: MODELSTUDIO_MODELS,
  supportsModelDiscovery: true,
  apiKeyPlaceholder: 'sk-sp-...',
  validateApiKey: (key) =>
    key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.',
  modelNamePrefix: (baseUrl) =>
    baseUrl === 'https://coding-intl.dashscope.aliyuncs.com/v1'
      ? 'ModelStudio Coding Plan for Global/Intl'
      : 'ModelStudio Coding Plan',
  group: 'alibaba',
  flowTitle: 'Alibaba Cloud Model Studio',
  endpointStepTitle: 'Region',
};

export const tokenPlanPreset: ProviderPreset = {
  id: 'token-plan',
  label: 'Token Plan',
  description:
    'Subscription with a monthly Credit quota · Dedicated endpoint (Personal and Team editions)',
  protocol: 'openai',
  envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
  endpoints: [
    {
      id: 'cn-beijing',
      label: 'China (Beijing)',
      url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856',
    },
    {
      id: 'ap-southeast-1',
      label: 'Singapore (International)',
      url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      documentationUrl:
        'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model',
    },
  ],
  models: TOKEN_PLAN_MODELS,
  supportsModelDiscovery: true,
  modelNamePrefix: (baseUrl) =>
    baseUrl === 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
      ? 'ModelStudio Token Plan for Global/Intl'
      : 'ModelStudio Token Plan',
  group: 'alibaba',
  flowTitle: 'Alibaba Cloud Model Studio',
  endpointStepTitle: 'Region',
};

export const alibabaStandardPreset: ProviderPreset = {
  id: 'alibaba-standard',
  label: 'Standard API Key',
  description: 'Connect with an existing ModelStudio API key',
  protocol: 'openai',
  envKey: 'DASHSCOPE_API_KEY',
  endpoints: [
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
  models: ALIBABA_STANDARD_MODELS,
  supportsModelDiscovery: true,
  apiKeyPlaceholder: 'sk-...',
  validateApiKey: (key) =>
    key.startsWith('sk-') && !key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Pay-as-you-go keys start with "sk-" or "sk-ws-". Token Plan keys ("sk-sp-") need the Token Plan entry instead.',
  modelNamePrefix: 'ModelStudio Standard',
  group: 'alibaba',
  flowTitle: 'Alibaba Cloud Model Studio',
  endpointStepTitle: 'Region',
};

export const deepseekPreset: ProviderPreset = {
  id: 'deepseek',
  label: 'DeepSeek API Key',
  description: 'Quick setup for DeepSeek (deepseek-flash, deepseek-v4-pro)',
  protocol: 'openai',
  envKey: 'DEEPSEEK_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'DeepSeek',
      url: 'https://api.deepseek.com',
      documentationUrl: 'https://api-docs.deepseek.com/zh-cn/',
    },
  ],
  models: DEEPSEEK_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'DeepSeek',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const grokPreset: ProviderPreset = {
  id: 'grok',
  label: 'Grok (xAI) API Key',
  description: 'Quick setup for xAI Grok chat & code models',
  protocol: 'openai',
  envKey: 'XAI_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'xAI',
      url: 'https://api.x.ai/v1',
      documentationUrl: 'https://docs.x.ai/docs',
    },
  ],
  models: GROK_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'Grok',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const minimaxPreset: ProviderPreset = {
  id: 'minimax',
  label: 'MiniMax API Key',
  description: 'Quick setup for MiniMax models',
  protocol: 'openai',
  envKey: 'MINIMAX_API_KEY',
  endpoints: [
    {
      id: 'international',
      label: 'International',
      url: 'https://api.minimax.io/v1',
      documentationUrl: 'https://www.minimax.io/platform',
    },
    {
      id: 'china',
      label: 'China',
      url: 'https://api.minimaxi.com/v1',
      documentationUrl: 'https://platform.minimaxi.com',
    },
  ],
  models: MINIMAX_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'MiniMax',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const zaiPreset: ProviderPreset = {
  id: 'zai',
  label: 'Z.AI API Key',
  description: 'Quick setup for Z.AI models',
  protocol: 'openai',
  envKey: 'ZAI_API_KEY',
  endpoints: [
    {
      id: 'standard-api-key',
      label: 'Standard API Key',
      url: 'https://api.z.ai/api/paas/v4',
      documentationUrl: 'https://docs.z.ai/',
    },
    {
      id: 'coding-plan',
      label: 'Coding Plan',
      url: 'https://api.z.ai/api/coding/paas/v4',
      documentationUrl: 'https://docs.z.ai/',
    },
  ],
  models: ZAI_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'Z.AI',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const moonshotPreset: ProviderPreset = {
  id: 'moonshot',
  label: 'Kimi (Moonshot AI) API Key',
  description: 'Quick setup for Kimi models',
  protocol: 'openai',
  envKey: 'MOONSHOT_API_KEY',
  endpoints: [
    {
      id: 'international',
      label: 'International',
      url: 'https://api.moonshot.ai/v1',
      documentationUrl: 'https://platform.kimi.ai/docs',
    },
    {
      id: 'china',
      label: 'China',
      url: 'https://api.moonshot.cn/v1',
      documentationUrl: 'https://platform.moonshot.cn/docs',
    },
  ],
  models: MOONSHOT_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'Kimi',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const idealabPreset: ProviderPreset = {
  id: 'idealab',
  label: 'Idealab API Key',
  description:
    'Alibaba internal LLM service (Qwen3.6-Plus-DogFooding, DeepSeek V4, Kimi K2.6)',
  protocol: 'openai',
  envKey: 'IDEALAB_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'Idealab',
      url: 'https://idealab.alibaba-inc.com/api/openai/v1',
    },
  ],
  models: IDEALAB_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'Idealab',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const modelscopePreset: ProviderPreset = {
  id: 'modelscope',
  label: 'ModelScope API Key',
  description: 'Quick setup for ModelScope API Inference',
  protocol: 'openai',
  envKey: 'MODELSCOPE_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'ModelScope',
      url: 'https://api-inference.modelscope.cn/v1',
      documentationUrl:
        'https://modelscope.cn/docs/model-service/API-Inference/intro',
    },
  ],
  models: MODELSCOPE_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'ModelScope',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const openrouterPreset: ProviderPreset = {
  id: 'openrouter',
  label: 'OpenRouter',
  description:
    'Connect with an OpenRouter API key (get one from openrouter.ai/keys)',
  protocol: 'openai',
  envKey: 'OPENROUTER_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1',
      documentationUrl: 'https://openrouter.ai/docs',
    },
  ],
  models: OPENROUTER_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'OpenRouter',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const requestyPreset: ProviderPreset = {
  id: 'requesty',
  label: 'Requesty',
  description:
    'Connect with a Requesty API key (get one from app.requesty.ai/api-keys)',
  protocol: 'openai',
  envKey: 'REQUESTY_API_KEY',
  endpoints: [
    {
      id: 'default',
      label: 'Requesty',
      url: 'https://router.requesty.ai/v1',
      documentationUrl: 'https://docs.requesty.ai',
    },
  ],
  models: REQUESTY_MODELS,
  supportsModelDiscovery: false,
  modelNamePrefix: 'Requesty',
  group: 'third-party',
  flowTitle: 'Other Providers',
  endpointStepTitle: 'Endpoint',
};

export const customProviderPreset: ProviderPreset = {
  id: 'custom',
  label: 'Custom Provider',
  description:
    'Configure a local model server, proxy, or another compatible API endpoint.',
  protocol: 'openai',
  envKey: 'CUSTOM_PROVIDER_API_KEY',
  endpoints: [],
  models: [],
  supportsModelDiscovery: false,
  modelNamePrefix: '',
  group: 'custom',
  flowTitle: 'Custom Provider',
  endpointStepTitle: 'Endpoint',
};

export const QWENCLOUD_PRESETS: readonly ProviderPreset[] = [
  qwencloudTokenPlanPreset,
  qwencloudStandardPreset,
];

export const ALIBABA_PRESETS: readonly ProviderPreset[] = [
  codingPlanPreset,
  tokenPlanPreset,
  alibabaStandardPreset,
];

export const THIRD_PARTY_PRESETS: readonly ProviderPreset[] = [
  deepseekPreset,
  grokPreset,
  minimaxPreset,
  zaiPreset,
  moonshotPreset,
  idealabPreset,
  modelscopePreset,
  openrouterPreset,
  requestyPreset,
];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  ...QWENCLOUD_PRESETS,
  ...ALIBABA_PRESETS,
  ...THIRD_PARTY_PRESETS,
  customProviderPreset,
];

export function findPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
