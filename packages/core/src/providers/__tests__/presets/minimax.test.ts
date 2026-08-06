/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AuthType,
  minimaxProvider,
  buildInstallPlan,
} from '@qwen-code/qwen-code-core';

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

  it('keeps MiniMax-M3 modalities available to setup displays', () => {
    expect(minimaxProvider.models?.[0]).toMatchObject({
      id: 'MiniMax-M3',
      contextWindowSize: 1000000,
    });
    expect(minimaxProvider.models?.[0]?.modalities).toEqual({
      image: true,
      video: true,
    });
  });

  it('creates an install plan with per-model metadata for known IDs', () => {
    const plan = buildInstallPlan(minimaxProvider, {
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-minimax',
      modelIds: ['MiniMax-M3', 'MiniMax-M2.5'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig?.modalities).toBeUndefined();
    expect(models?.[1]).toMatchObject({
      id: 'MiniMax-M2.5',
      name: '[MiniMax] MiniMax-M2.5',
      generationConfig: { contextWindowSize: 196608 },
    });
  });
});
