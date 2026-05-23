/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { idealabProvider, buildInstallPlan } from '../../allProviders.js';

describe('idealabProvider', () => {
  it('has correct provider config', () => {
    expect(idealabProvider).toMatchObject({
      id: 'idealab',
      label: 'Idealab API Key',
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
      envKey: 'IDEALAB_API_KEY',
      uiGroup: 'third-party',
    });
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(idealabProvider, {
      baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
      apiKey: 'sk-idealab',
      modelIds: ['Qwen3.6-Plus-DogFooding', 'bailian/deepseek-v4-pro'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'Qwen3.6-Plus-DogFooding',
      name: '[Idealab] Qwen3.6-Plus-DogFooding',
      generationConfig: { contextWindowSize: 1000000 },
    });
    expect(models?.[1]).toMatchObject({
      id: 'bailian/deepseek-v4-pro',
      name: '[Idealab] bailian/deepseek-v4-pro',
      generationConfig: { contextWindowSize: 1000000 },
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(idealabProvider, {
      baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
      apiKey: 'sk-idealab',
      modelIds: ['Qwen3.6-Plus-DogFooding', 'some-new-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'Qwen3.6-Plus-DogFooding',
      name: '[Idealab] Qwen3.6-Plus-DogFooding',
    });
    expect(models?.[1]).toMatchObject({
      id: 'some-new-model',
      name: '[Idealab] some-new-model',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });

  it('includes all four predefined models', () => {
    expect(idealabProvider.models).toHaveLength(4);
    expect(idealabProvider.models?.map((m) => m.id)).toEqual([
      'Qwen3.6-Plus-DogFooding',
      'bailian/deepseek-v4-pro',
      'bailian/deepseek-v4-flash',
      'bailian/kimi-k2.6',
    ]);
  });
});
