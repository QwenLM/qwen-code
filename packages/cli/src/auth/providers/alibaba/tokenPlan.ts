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

export const TOKEN_PLAN_ENV_KEY = 'BAILIAN_TOKEN_PLAN_API_KEY';
export const TOKEN_PLAN_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const TOKEN_PLAN_MODELS: ModelSpec[] = [
  {
    id: 'qwen3.6-plus',
    contextWindowSize: 1000000,
    enableThinking: true,
    modalities: { image: true, video: true },
  },
  { id: 'deepseek-v3.2', contextWindowSize: 131072, enableThinking: true },
  { id: 'glm-5', contextWindowSize: 202752, enableThinking: true },
  { id: 'MiniMax-M2.5', contextWindowSize: 196608, enableThinking: true },
];

// ---------------------------------------------------------------------------
// Provider config (unified ProviderConfig)
// ---------------------------------------------------------------------------

export const tokenPlanProvider: ProviderConfig = {
  id: 'token-plan',
  label: 'Token Plan',
  description:
    'For teams and companies · Usage-based billing with dedicated endpoint',
  protocol: AuthType.USE_OPENAI,
  baseUrl: TOKEN_PLAN_BASE_URL,
  envKey: TOKEN_PLAN_ENV_KEY,
  authMethod: 'input',
  models: TOKEN_PLAN_MODELS,
  modelsEditable: true,
  modelNamePrefix: 'ModelStudio Token Plan',
  uiGroup: 'alibaba',
  uiLabels: { flowTitle: 'Alibaba ModelStudio' },
};
