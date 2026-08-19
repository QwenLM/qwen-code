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
  it('offers current regional endpoints', () => {
    expect(minimaxProvider).toMatchObject({
      id: 'minimax',
      label: 'MiniMax API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'MINIMAX_API_KEY',
    });

    expect(Array.isArray(minimaxProvider.baseUrl)).toBe(true);
    expect(minimaxProvider.baseUrl).toEqual([
      expect.objectContaining({
        id: 'global-standard',
        url: 'https://api.minimax.io/v1',
        documentationUrl: 'https://platform.minimax.io/docs',
      }),
      expect.objectContaining({
        id: 'global-messages',
        documentationUrl: 'https://platform.minimax.io/docs',
      }),
      expect.objectContaining({
        id: 'china-standard',
        url: 'https://api.minimaxi.com/v1',
        documentationUrl: 'https://platform.minimaxi.com/docs',
      }),
      expect.objectContaining({
        id: 'china-messages',
        documentationUrl: 'https://platform.minimaxi.com/docs',
      }),
    ]);
  });

  it('includes current context, modality, and thinking metadata', () => {
    expect(minimaxProvider.models?.[0]).toMatchObject({
      id: 'MiniMax-M3',
      contextWindowSize: 1000000,
      adaptiveThinking: true,
      modalities: { image: true, video: true },
    });
    expect(minimaxProvider.models?.[1]).toMatchObject({
      id: 'MiniMax-M2.7',
      contextWindowSize: 204800,
      thinkingMandatory: true,
    });
  });

  it('selects each endpoint transport and its model metadata', () => {
    const endpoints = minimaxProvider.baseUrl;
    if (!Array.isArray(endpoints)) throw new Error('Expected endpoint options');
    const adaptiveEndpoint = endpoints.find(
      ({ id }) => id === 'global-messages',
    );
    const mandatoryEndpoint = endpoints.find(
      ({ id }) => id === 'china-messages',
    );
    expect(adaptiveEndpoint?.protocol).toBeDefined();
    expect(mandatoryEndpoint?.protocol).toBeDefined();

    const adaptivePlan = buildInstallPlan(minimaxProvider, {
      baseUrl: adaptiveEndpoint?.url ?? '',
      apiKey: 'sk-minimax',
      modelIds: ['MiniMax-M3'],
    });
    expect(adaptivePlan.authType).toBe(adaptiveEndpoint?.protocol);
    expect(adaptivePlan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'MiniMax-M3',
      generationConfig: {
        adaptiveThinking: true,
        contextWindowSize: 1000000,
        modalities: { image: true, video: true },
      },
    });

    const mandatoryPlan = buildInstallPlan(minimaxProvider, {
      baseUrl: mandatoryEndpoint?.url ?? '',
      apiKey: 'sk-minimax',
      modelIds: ['MiniMax-M2.7'],
    });

    expect(mandatoryPlan.authType).toBe(mandatoryEndpoint?.protocol);
    const models = mandatoryPlan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      id: 'MiniMax-M2.7',
      name: '[MiniMax] MiniMax-M2.7',
      generationConfig: {
        contextWindowSize: 204800,
        thinkingMandatory: true,
      },
    });
  });
});
