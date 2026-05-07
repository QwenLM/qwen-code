/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig, ModelSpec } from '../../providerConfig.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';
export const CODING_PLAN_CHINA_BASE_URL =
  'https://coding.dashscope.aliyuncs.com/v1';
export const CODING_PLAN_GLOBAL_BASE_URL =
  'https://coding-intl.dashscope.aliyuncs.com/v1';

// keep in sync with packages/vscode-ide-companion/src/services/subscriptionPlanDefinitions.ts ALIBABA_SUBSCRIPTION_MODELS
const MODELSTUDIO_MODELS: ModelSpec[] = [
  {
    id: 'qwen3.5-plus',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'qwen3.6-plus',
    description: 'Currently available to Pro subscribers only.',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  { id: 'glm-5', contextWindowSize: 202752, enableThinking: true },
  {
    id: 'kimi-k2.5',
    contextWindowSize: 262144,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  { id: 'MiniMax-M2.5', contextWindowSize: 196608, enableThinking: true },
  { id: 'qwen3-coder-plus', contextWindowSize: 1000000 },
  { id: 'qwen3-coder-next', contextWindowSize: 262144 },
  {
    id: 'qwen3-max-2026-01-23',
    contextWindowSize: 262144,
    enableThinking: true,
  },
  { id: 'glm-4.7', contextWindowSize: 202752, enableThinking: true },
];

// ---------------------------------------------------------------------------
// Provider config (unified ProviderConfig)
// ---------------------------------------------------------------------------

export const codingPlanProvider: ProviderConfig = {
  id: 'coding-plan',
  label: 'Coding Plan',
  description: 'For individual developers · Weekly quota included',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'aliyun',
      label: 'China (Beijing)',
      url: CODING_PLAN_CHINA_BASE_URL,
      documentationUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    },
    {
      id: 'alibabacloud',
      label: 'Singapore (International)',
      url: CODING_PLAN_GLOBAL_BASE_URL,
      documentationUrl:
        'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    },
  ],
  envKey: CODING_PLAN_ENV_KEY,
  authMethod: 'input',
  models: MODELSTUDIO_MODELS,
  modelsEditable: true,
  modelNamePrefix: (baseUrl) =>
    baseUrl === CODING_PLAN_GLOBAL_BASE_URL
      ? 'ModelStudio Coding Plan for Global/Intl'
      : 'ModelStudio Coding Plan',
  apiKeyPlaceholder: 'sk-sp-...',
  validateApiKey: (key) =>
    !key.startsWith('sk-sp-')
      ? 'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.'
      : null,
  ownsModel: (model) =>
    model.envKey === CODING_PLAN_ENV_KEY &&
    typeof model.baseUrl === 'string' &&
    (model.baseUrl === CODING_PLAN_CHINA_BASE_URL ||
      model.baseUrl === CODING_PLAN_GLOBAL_BASE_URL),
  uiGroup: 'alibaba',
  uiLabels: { flowTitle: 'Alibaba ModelStudio', baseUrlStepTitle: 'Region' },
};
