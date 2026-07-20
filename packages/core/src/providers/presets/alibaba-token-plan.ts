/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig, ModelSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOKEN_PLAN_ENV_KEY = 'BAILIAN_TOKEN_PLAN_API_KEY';
export const TOKEN_PLAN_CHINA_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
export const TOKEN_PLAN_GLOBAL_BASE_URL =
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
export const TOKEN_PLAN_BASE_URL = TOKEN_PLAN_CHINA_BASE_URL;

const TOKEN_PLAN_MODELS: ModelSpec[] = [
  {
    id: 'qwen3.7-plus',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'qwen3.6-plus',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  { id: 'qwen3.7-max', contextWindowSize: 1000000, enableThinking: true },
  {
    id: 'qwen3.8-max-preview',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'qwen3.6-flash',
    contextWindowSize: 1000000,
    enableThinking: true,
  },
  { id: 'deepseek-v4-pro', contextWindowSize: 1000000 },
  { id: 'deepseek-v4-flash', contextWindowSize: 1000000 },
  { id: 'deepseek-v3.2', contextWindowSize: 131072 },
  {
    id: 'kimi-k2.7-code',
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.6',
    contextWindowSize: 262144,
    enableThinking: true,
  },
  {
    id: 'kimi-k2.5',
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  { id: 'glm-5.2', contextWindowSize: 1000000, enableThinking: true },
  { id: 'glm-5.1', contextWindowSize: 202752, enableThinking: true },
  { id: 'glm-5', contextWindowSize: 202752, enableThinking: true },
  { id: 'MiniMax-M2.5', contextWindowSize: 196608 },
];

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export const tokenPlanProvider: ProviderConfig = {
  id: 'token-plan',
  label: 'Token Plan',
  description:
    'For teams and companies · Usage-based billing with dedicated endpoint',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'cn-beijing',
      label: 'China (Beijing)',
      url: TOKEN_PLAN_CHINA_BASE_URL,
      documentationUrl:
        'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856',
    },
    {
      id: 'ap-southeast-1',
      label: 'Singapore (International)',
      url: TOKEN_PLAN_GLOBAL_BASE_URL,
      documentationUrl:
        'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model',
    },
  ],
  envKey: TOKEN_PLAN_ENV_KEY,
  models: TOKEN_PLAN_MODELS,
  modelsEditable: true,
  modelNamePrefix: (baseUrl) =>
    baseUrl === TOKEN_PLAN_GLOBAL_BASE_URL
      ? 'ModelStudio Token Plan for Global/Intl'
      : 'ModelStudio Token Plan',
  ownsModel: (model) =>
    model.envKey === TOKEN_PLAN_ENV_KEY &&
    typeof model.baseUrl === 'string' &&
    (model.baseUrl === TOKEN_PLAN_CHINA_BASE_URL ||
      model.baseUrl === TOKEN_PLAN_GLOBAL_BASE_URL),
  uiGroup: 'alibaba',
  uiLabels: { flowTitle: 'Alibaba ModelStudio', baseUrlStepTitle: 'Region' },
};
