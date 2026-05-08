/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { deepseekProvider, buildInstallPlan } from '../../allProviders.js';

describe('deepseekProvider', () => {
  it('has correct provider config', () => {
    expect(deepseekProvider).toMatchObject({
      id: 'deepseek',
      label: 'DeepSeek API Key',
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://api.deepseek.com',
      envKey: 'DEEPSEEK_API_KEY',
    });
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(deepseekProvider, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek',
      modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      name: '[DeepSeek] deepseek-v4-flash',
      generationConfig: { contextWindowSize: 1000000 },
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(deepseekProvider, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek',
      modelIds: ['deepseek-v4-flash', 'some-new-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig).toEqual({
      contextWindowSize: 1000000,
    });
    expect(models?.[1]).toMatchObject({
      id: 'some-new-model',
      name: '[DeepSeek] some-new-model',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });
});
