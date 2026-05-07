/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { minimaxProvider, buildInstallPlan } from '../../allProviders.js';

describe('minimaxProvider', () => {
  it('offers international and China endpoints', () => {
    expect(minimaxProvider).toMatchObject({
      id: 'minimax',
      label: 'MiniMax API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'MINIMAX_API_KEY',
    });

    expect(Array.isArray(minimaxProvider.baseUrl)).toBe(true);
    const urls = (minimaxProvider.baseUrl as Array<{ url: string }>).map(
      (o) => o.url,
    );
    expect(urls).toContain('https://api.minimax.io/v1');
    expect(urls).toContain('https://api.minimaxi.com/v1');
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(minimaxProvider, {
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-minimax',
      modelIds: ['MiniMax-M2.5'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      id: 'MiniMax-M2.5',
      name: '[MiniMax] MiniMax-M2.5',
      generationConfig: { contextWindowSize: 196608 },
    });
  });
});
