/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { zaiProvider, buildInstallPlan } from '../../allProviders.js';

describe('zaiProvider', () => {
  it('offers standard API key and Coding Plan endpoints', () => {
    expect(zaiProvider).toMatchObject({
      id: 'zai',
      label: 'Z.AI API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'ZAI_API_KEY',
    });

    expect(Array.isArray(zaiProvider.baseUrl)).toBe(true);
    const urls = (zaiProvider.baseUrl as Array<{ url: string }>).map(
      (o) => o.url,
    );
    expect(urls).toContain('https://api.z.ai/api/paas/v4');
    expect(urls).toContain('https://api.z.ai/api/coding/paas/v4');
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(zaiProvider, {
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'sk-zai',
      modelIds: ['GLM-5.1', 'GLM-5'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'GLM-5.1',
      name: '[Z.AI] GLM-5.1',
      generationConfig: {
        contextWindowSize: 204800,
        extra_body: { enable_thinking: true },
      },
    });
    expect(models?.[1]).toMatchObject({
      id: 'GLM-5',
      generationConfig: { contextWindowSize: 204800 },
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(zaiProvider, {
      baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKey: 'sk-zai',
      modelIds: ['glm-new-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]).toMatchObject({
      id: 'glm-new-model',
      name: '[Z.AI] glm-new-model',
    });
    expect(models?.[0]?.generationConfig).toBeUndefined();
  });
});
