/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildSessionConditionNamespace,
  type SessionConditionConfigView,
} from './session-context.js';

const fullConfig = (
  contextWindowSize: number | undefined,
  lastPromptTokenCount: number,
): SessionConditionConfigView => ({
  getContentGeneratorConfig: () => ({ contextWindowSize }),
  getGeminiClient: () => ({
    getChat: () => ({ getLastPromptTokenCount: () => lastPromptTokenCount }),
  }),
});

describe('buildSessionConditionNamespace (§8.3 session.*)', () => {
  it('snapshots all four fields with the exact subtraction', () => {
    expect(
      buildSessionConditionNamespace(fullConfig(131072, 20000), 8192),
    ).toEqual({
      reservedOutputTokens: 8192,
      contextWindowTokens: 131072,
      promptTokenCount: 20000,
      availableContextTokens: 131072 - 20000 - 8192,
    });
  });

  it('clamps availableContextTokens at 0 when the window is exhausted', () => {
    expect(buildSessionConditionNamespace(fullConfig(1000, 900), 200)).toEqual({
      reservedOutputTokens: 200,
      contextWindowTokens: 1000,
      promptTokenCount: 900,
      availableContextTokens: 0,
    });
  });

  it('treats a fresh chat (0 prompt tokens) as a real value, not absence', () => {
    expect(buildSessionConditionNamespace(fullConfig(1000, 0), 200)).toEqual({
      reservedOutputTokens: 200,
      contextWindowTokens: 1000,
      promptTokenCount: 0,
      availableContextTokens: 800,
    });
  });

  it.each([
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -5],
    ['non-finite', Number.POSITIVE_INFINITY],
  ])(
    'omits contextWindowTokens AND availableContextTokens for a %s window',
    (_name, windowSize) => {
      expect(
        buildSessionConditionNamespace(fullConfig(windowSize, 20000), 8192),
      ).toEqual({ reservedOutputTokens: 8192, promptTokenCount: 20000 });
    },
  );

  it('omits promptTokenCount AND availableContextTokens when getChat throws', () => {
    const config: SessionConditionConfigView = {
      getContentGeneratorConfig: () => ({ contextWindowSize: 131072 }),
      getGeminiClient: () => ({
        getChat: () => {
          throw new Error('Chat not initialized');
        },
      }),
    };
    expect(buildSessionConditionNamespace(config, 8192)).toEqual({
      reservedOutputTokens: 8192,
      contextWindowTokens: 131072,
    });
  });

  it('omits promptTokenCount for a negative or non-finite chat count', () => {
    expect(buildSessionConditionNamespace(fullConfig(1000, -1), 200)).toEqual({
      reservedOutputTokens: 200,
      contextWindowTokens: 1000,
    });
    expect(
      buildSessionConditionNamespace(fullConfig(1000, Number.NaN), 200),
    ).toEqual({ reservedOutputTokens: 200, contextWindowTokens: 1000 });
  });

  it('yields only reservedOutputTokens on a bare stub config', () => {
    expect(buildSessionConditionNamespace({}, 8192)).toEqual({
      reservedOutputTokens: 8192,
    });
  });
});
