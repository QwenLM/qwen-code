/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig } from './config.js';
import type { ConfigParameters } from './config.js';
import {
  AuthType,
  createContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { clampOutputTokensToWindow } from '../core/tokenLimits.js';
import { computeThresholds } from '../services/chatCompressionService.js';
import { runWithRuntimeContentGenerator } from '../agents/runtime/agent-context.js';

const makeConfig = (overrides: Partial<ConfigParameters> = {}) =>
  new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'large-window',
    authType: AuthType.USE_OPENAI,
    telemetry: { enabled: false },
    chatRecording: false,
    usageStatisticsEnabled: false,
    autoCompactThreshold: 0.85,
    modelProvidersConfig: {
      openai: [
        {
          id: 'large-window',
          generationConfig: {
            contextWindowSize: 1_000_000,
            autoCompactThreshold: 0.25,
          },
        },
        {
          id: 'small-window',
          generationConfig: { contextWindowSize: 262_144 },
        },
      ],
    },
    ...overrides,
  });

describe('model auto-compaction threshold', () => {
  it('follows model switches without reducing the context window or output budget', async () => {
    const config = makeConfig();
    for (const [model, ratio, window, auto, outputBudget] of [
      ['large-window', 0.25, 1_000_000, 250_000, 64_000],
      ['small-window', 0.85, 262_144, 222_822.4, 4_000],
      ['large-window', 0.25, 1_000_000, 250_000, 64_000],
    ] as const) {
      await config.setModel(model);
      const generationConfig = createContentGeneratorConfig(
        config,
        AuthType.USE_OPENAI,
        {
          ...config.getModelsConfig().getGenerationConfig(),
          apiKey: 'test-key',
        },
      );
      const resolvedWindow = generationConfig.contextWindowSize!;
      expect(config.getAutoCompactThreshold()).toBe(ratio);
      expect(resolvedWindow).toBe(window);
      expect(
        computeThresholds(
          resolvedWindow,
          config.getAutoCompactThreshold(generationConfig),
        ).auto,
      ).toBe(auto);
      expect(clampOutputTokensToWindow(64_000, resolvedWindow, 250_000)).toBe(
        outputBudget,
      );
    }
  });

  it.each([undefined, 0, -0.5, 1.1, Number.NaN, Infinity])(
    'falls back to the global ratio for provider value %s',
    async (autoCompactThreshold) => {
      const config = makeConfig({
        autoCompactThreshold: 0.6,
        modelProvidersConfig: {
          openai: [
            {
              id: 'large-window',
              generationConfig: { autoCompactThreshold },
            },
          ],
        },
      });
      await config.setModel('large-window');
      expect(config.getAutoCompactThreshold()).toBe(0.6);
    },
  );

  it('accepts one while retaining the absolute compaction ceiling', () => {
    const config = makeConfig({
      generationConfig: { autoCompactThreshold: 1 },
    });
    expect(config.getAutoCompactThreshold()).toBe(1);
    expect(
      computeThresholds(1_000_000, config.getAutoCompactThreshold()).auto,
    ).toBe(967_000);
  });

  it.each([undefined, 0, Number.NaN])(
    'retains the default ratio when neither level supplies a valid value (%s)',
    (autoCompactThreshold) => {
      const config = makeConfig({
        autoCompactThreshold,
        generationConfig: { autoCompactThreshold: -1 },
      });
      expect(config.getAutoCompactThreshold()).toBeUndefined();
      expect(
        computeThresholds(1_000_000, config.getAutoCompactThreshold()).auto,
      ).toBe(850_000);
    },
  );

  it('uses the selected endpoint for models with the same id', async () => {
    const endpoints = [
      ['https://one.example/v1', 0.25],
      ['https://two.example/v1', 0.5],
    ] as const;
    const config = makeConfig({
      modelProvidersConfig: {
        openai: endpoints.map(([baseUrl, autoCompactThreshold]) => ({
          id: 'shared',
          baseUrl,
          generationConfig: { autoCompactThreshold },
        })),
      },
    });
    for (const [baseUrl, ratio] of endpoints) {
      await config.switchModel(AuthType.USE_OPENAI, 'shared', { baseUrl });
      expect(config.getAutoCompactThreshold()).toBe(ratio);
    }
  });

  it.each([undefined, 0.5])(
    'uses the active child generator ratio (%s), without falling back to its parent model',
    async (autoCompactThreshold) => {
      const parent = makeConfig();
      await parent.setModel('large-window');
      const child = deriveConfig(parent);
      await runWithRuntimeContentGenerator(
        {
          contentGenerator: {
            generateContent: vi.fn(),
            generateContentStream: vi.fn(),
            embedContent: vi.fn(),
          },
          contentGeneratorConfig: {
            model: 'child-model',
            contextWindowSize: 262_144,
            autoCompactThreshold,
          },
        },
        async () => {
          expect(child.getModel()).toBe('child-model');
          expect(child.getAutoCompactThreshold()).toBe(
            autoCompactThreshold ?? 0.85,
          );
        },
      );
      expect(parent.getAutoCompactThreshold()).toBe(0.25);
    },
  );
});
