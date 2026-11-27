/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Model } from './model.js';
import { mergeModelConfig, resolveSelectedModelConfig } from './modelConfig.js';

const model: Model = {
  key: 'auto',
  source: 'qwen-provider',
  displayName: 'Auto',
  capabilities: {
    tools: true,
    vision: true,
    reasoning: {
      supported: true,
      supportedEfforts: ['none', 'low', 'medium', 'high'],
    },
    contextWindows: [{ tokens: 128000 }, { tokens: 256000 }],
  },
  limits: { maxContextTokens: 256000 },
};

describe('resolveSelectedModelConfig', () => {
  it('uses model defaults when there are no preferences', () => {
    expect(resolveSelectedModelConfig(model)).toEqual({
      reasoning: { effort: 'medium' },
      context: { contextWindow: 256000 },
    });
  });

  it('preserves an explicitly disabled thinking preference and a smaller tier', () => {
    expect(
      resolveSelectedModelConfig(model, {
        reasoning: { effort: 'none' },
        context: { contextWindow: 128000 },
      }),
    ).toEqual({ reasoning: { effort: 'none' }, context: { contextWindow: 128000 } });
  });

  it.each([0, -1, 192000, NaN, Infinity])(
    'rejects an unsupported window %s and falls back to the model tier',
    (contextWindow) => {
      expect(
        resolveSelectedModelConfig(model, { context: { contextWindow } }).context?.contextWindow,
      ).toBe(256000);
    },
  );

  it('does not invent a medium effort when the model only supports low/high', () => {
    const limited: Model = {
      ...model,
      capabilities: {
        ...model.capabilities,
        reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
      },
    };
    expect(
      resolveSelectedModelConfig(limited, { reasoning: { effort: 'max' } }),
    ).toMatchObject({ reasoning: {} });
  });

  it('uses supported catalog defaults before generic fallbacks', () => {
    expect(
      resolveSelectedModelConfig({
        ...model,
        defaultModelConfig: { reasoning: { effort: 'high' }, context: { contextWindow: 128000 } },
      }),
    ).toEqual({ reasoning: { effort: 'high' }, context: { contextWindow: 128000 } });
  });

  it('leaves fixed reasoning effort unspecified instead of sending an unsupported level', () => {
    expect(
      resolveSelectedModelConfig({
        ...model,
        capabilities: {
          ...model.capabilities,
          reasoning: { supported: true, supportedEfforts: [] },
        },
      }).reasoning?.effort,
    ).toBeUndefined();
  });

  it('merges grouped fields without erasing inherited values with undefined', () => {
    expect(mergeModelConfig(
      { reasoning: { effort: 'high', thinking: { type: 'adaptive' }, preserve: true }, context: { contextWindow: 128000, maxOutputTokens: 8192 }, sampling: { temperature: 0.4, topP: 0.9 } },
      { reasoning: { effort: undefined, preserve: false }, context: { contextWindow: undefined, maxOutputTokens: 4096 }, sampling: { temperature: 0 } },
    )).toEqual({
      reasoning: { effort: 'high', thinking: { type: 'adaptive' }, preserve: false },
      context: { contextWindow: 128000, maxOutputTokens: 4096 },
      sampling: { temperature: 0, topP: 0.9 },
    });
  });

  it('caps output budget and preserves sampling while dropping unsupported thinking', () => {
    expect(resolveSelectedModelConfig({
      ...model,
      limits: { ...model.limits, maxOutputTokens: 1024 },
      capabilities: { ...model.capabilities, reasoning: { supported: false, supportedEfforts: [] } },
    }, {
      context: { maxOutputTokens: 4096 },
      reasoning: { effort: 'high', thinking: { type: 'enabled', budgetTokens: 8192 }, preserve: false },
      sampling: { temperature: 0.2, stop: ['END'] },
    })).toEqual({
      reasoning: { effort: 'none', preserve: false },
      context: { contextWindow: 256000, maxOutputTokens: 1024 },
      sampling: { temperature: 0.2, stop: ['END'] },
    });
  });

  it('disables thinking for models without reasoning and accepts a bounded untiered window', () => {
    expect(
      resolveSelectedModelConfig(
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            reasoning: { supported: false, supportedEfforts: [] },
            contextWindows: [],
          },
        },
        { reasoning: { effort: 'high' }, context: { contextWindow: 64000 } },
      ),
    ).toEqual({ reasoning: { effort: 'none' }, context: { contextWindow: 64000 } });
  });
});
