/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
// Re-import via the relative source path so this test exercises the
// in-tree implementation even before dist/ is rebuilt (the
// @qwen-code/qwen-code-core package main points at dist/ on a fresh
// branch). The provider was deleted from the CLI side in this PR and not
// rebuilt in core's test folder until now.
import { AuthType } from '../../../core/contentGenerator.js';
import { modelscopeProvider } from '../../presets/modelscope.js';
import { buildInstallPlan } from '../../provider-config.js';

describe('modelscopeProvider', () => {
  it('has correct provider config', () => {
    expect(modelscopeProvider).toMatchObject({
      id: 'modelscope',
      label: 'ModelScope API Key',
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
    // Known model: contextWindowSize is preserved, plus modelscope's
    // enableThinking=true adds extra_body.enable_thinking.
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
