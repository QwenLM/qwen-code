/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { grokProvider } from '../../presets/grok.js';
import { buildInstallPlan } from '../../provider-config.js';

describe('grokProvider', () => {
  it('has correct provider config', () => {
    expect(grokProvider).toMatchObject({
      id: 'grok',
      label: 'Grok (xAI) API Key',
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://api.x.ai/v1',
      envKey: 'XAI_API_KEY',
    });
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(grokProvider, {
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
      modelIds: ['grok-3', 'grok-4'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'grok-3',
      name: '[Grok] grok-3',
    });
    expect(models?.[0]?.generationConfig).toEqual({
      contextWindowSize: 131072,
    });
    expect(models?.[1]?.generationConfig).toEqual({
      extra_body: { enable_thinking: true },
      contextWindowSize: 256000,
    });
  });

  it('falls back gracefully for unknown model IDs', () => {
    const plan = buildInstallPlan(grokProvider, {
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
      modelIds: ['grok-4', 'grok-future'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[1]).toMatchObject({
      id: 'grok-future',
      name: '[Grok] grok-future',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });
});
