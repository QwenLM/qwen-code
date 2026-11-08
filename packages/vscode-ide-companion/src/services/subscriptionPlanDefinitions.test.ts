/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildProviderTemplate,
  codingPlanProvider,
  computeModelListVersion,
  getDefaultModelIds,
  tokenPlanProvider,
} from '@qwen-code/qwen-code-core';

import {
  CodingPlanRegion,
  getSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';

describe('subscription plan definitions', () => {
  it('keeps Token Plan on its dedicated model list, sourced from the core preset', () => {
    const tokenPlan = getSubscriptionPlanConfig('token');
    const codingPlan = getSubscriptionPlanConfig('coding');

    // Pinning ids here would let this copy drift from the preset the CLI reads
    // — which is how a renamed built-in stayed in the IDE's list. Assert the
    // shared source instead.
    expect(tokenPlan.template.map((model) => model.id)).toEqual(
      getDefaultModelIds(tokenPlanProvider),
    );
    expect(codingPlan.template.map((model) => model.id)).toEqual(
      getDefaultModelIds(codingPlanProvider),
    );
    expect(tokenPlan.template.map((model) => model.id)).not.toEqual(
      codingPlan.template.map((model) => model.id),
    );
    expect(codingPlan.template.map((model) => model.id)).not.toContain(
      'qwen3.7-max',
    );
  });

  it('records a version the CLI can reproduce from the same preset', () => {
    // The CLI recomputes this on every launch to detect a pending provider
    // update; a version it cannot reproduce shows the update prompt right
    // after signing in from the IDE.
    for (const [planId, provider] of [
      ['token', tokenPlanProvider],
      ['coding', codingPlanProvider],
    ] as const) {
      for (const region of [CodingPlanRegion.CHINA, CodingPlanRegion.GLOBAL]) {
        const plan = getSubscriptionPlanConfig(planId, region);
        const template = buildProviderTemplate(provider, plan.baseUrl);
        expect(plan.version).toBe(computeModelListVersion(template));
        expect(plan.template).toEqual(template);
      }
    }
  });

  it('defaults Token Plan to China and supports the Singapore region', () => {
    const china = getSubscriptionPlanConfig('token');
    const global = getSubscriptionPlanConfig('token', CodingPlanRegion.GLOBAL);

    expect(china.region).toBe(CodingPlanRegion.CHINA);
    expect(china.baseUrl).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );
    const firstChinaModel = china.template[0]!;
    expect(firstChinaModel).toMatchObject({
      name: `[ModelStudio Token Plan] ${firstChinaModel.id}`,
      baseUrl:
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    });

    expect(global.region).toBe(CodingPlanRegion.GLOBAL);
    expect(global.baseUrl).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    const firstGlobalModel = global.template[0]!;
    expect(firstGlobalModel).toMatchObject({
      name: `[ModelStudio Token Plan for Global/Intl] ${firstGlobalModel.id}`,
      baseUrl:
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    });
  });
});
