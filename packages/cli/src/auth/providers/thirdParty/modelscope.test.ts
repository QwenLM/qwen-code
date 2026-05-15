/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { modelscopeProvider, buildInstallPlan } from '../../allProviders.js';

describe('modelscopeProvider', () => {
  it('has correct provider config', () => {
    expect(modelscopeProvider).toMatchObject({
      id: 'modelscope',
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      envKey: 'MODELSCOPE_API_KEY',
    });
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(modelscopeProvider, {
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      apiKey: 'sk-modelscope',
      modelIds: ['deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3.5-397B-A17B'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'deepseek-ai/DeepSeek-V4-Flash',
      name: '[ModelScope] deepseek-ai/DeepSeek-V4-Flash',
      generationConfig: { contextWindowSize: 1000000 },
    });
    expect(models?.[1]).toMatchObject({
      id: 'Qwen/Qwen3.5-397B-A17B',
      name: '[ModelScope] Qwen/Qwen3.5-397B-A17B',
      generationConfig: { contextWindowSize: 1000000 },
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(modelscopeProvider, {
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      apiKey: 'sk-modelscope',
      modelIds: ['deepseek-ai/DeepSeek-V4-Flash', 'some-new-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig).toMatchObject({
      contextWindowSize: 1000000,
    });
    expect(models?.[1]).toMatchObject({
      id: 'some-new-model',
      name: '[ModelScope] some-new-model',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });
});
