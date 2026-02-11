/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProviderModelConfig as ModelConfig } from '@qwen-code/qwen-code-core';

/**
 * Coding plan template - array of model configurations
 * When user provides an api-key, these configs will be cloned with envKey pointing to the stored api-key
 */
export type CodingPlanTemplate = ModelConfig[];

/**
 * Environment variable key for storing the coding plan API key
 */
export const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';

/**
 * CODING_PLAN_TEMPLATE defines the model configurations for coding-plan mode.
 */
export const CODING_PLAN_TEMPLATE: CodingPlanTemplate = [
  {
    id: 'qwen3-coder-plus',
    name: 'qwen3-coder-plus',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    description: 'qwen3-coder-plus model from Bailian Coding Plan',
    envKey: CODING_PLAN_ENV_KEY,
  },
  {
    id: 'qwen3-max-2026-01-23',
    name: 'qwen3-max-2026-01-23',
    description:
      'qwen3 max model from Bailian Coding Plan with thinking enabled',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    envKey: CODING_PLAN_ENV_KEY,
    generationConfig: {
      extra_body: {
        enable_thinking: true,
      },
    },
  },
];
