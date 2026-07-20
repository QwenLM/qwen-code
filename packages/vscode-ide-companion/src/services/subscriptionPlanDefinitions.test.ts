/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  CodingPlanRegion,
  getSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';

describe('subscription plan definitions', () => {
  it('keeps Token Plan on its dedicated model list', () => {
    const tokenPlan = getSubscriptionPlanConfig('token');
    const codingPlan = getSubscriptionPlanConfig('coding');

    expect(tokenPlan.template.map((model) => model.id)).toEqual([
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.7-max',
      'qwen3.8-max-preview',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v3.2',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'MiniMax-M2.5',
    ]);
    expect(codingPlan.template.map((model) => model.id)).not.toContain(
      'qwen3.7-max',
    );
    expect(
      tokenPlan.template.find((model) => model.id === 'deepseek-v4-pro')
        ?.generationConfig,
    ).toEqual({ contextWindowSize: 1000000 });
  });

  it('defaults Token Plan to China and supports the Singapore region', () => {
    const china = getSubscriptionPlanConfig('token');
    const global = getSubscriptionPlanConfig('token', CodingPlanRegion.GLOBAL);

    expect(china.region).toBe(CodingPlanRegion.CHINA);
    expect(china.baseUrl).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );
    expect(china.template[0]).toMatchObject({
      name: '[ModelStudio Token Plan] qwen3.6-plus',
      baseUrl:
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    });

    expect(global.region).toBe(CodingPlanRegion.GLOBAL);
    expect(global.baseUrl).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    expect(global.template[0]).toMatchObject({
      name: '[ModelStudio Token Plan for Global/Intl] qwen3.6-plus',
      baseUrl:
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    });
  });
});
