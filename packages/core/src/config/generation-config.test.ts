/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  generationConfigFromLegacyFields,
  generationConfigFromWireParameters,
  mergeLlmGenerationConfigs,
  normalizeLlmGenerationConfig,
  normalizeReasoningConfig,
  resolveEffectiveReasoningEffort,
  toCustomProviderWireFields,
  toRemoteWireParameters,
  withReasoningEffortOverride,
} from './generation-config.js';

describe('normalizeReasoningConfig', () => {
  it('treats enabled:false and effort:none as synonymous (thinking off)', () => {
    expect(normalizeReasoningConfig({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(normalizeReasoningConfig({ effort: 'none' })).toEqual({
      enabled: false,
    });
    // Disabling drops budget.
    expect(
      normalizeReasoningConfig({ enabled: false, budgetTokens: 1000 }),
    ).toEqual({ enabled: false });
  });

  it('keeps an explicit effort independent from thinking', () => {
    expect(normalizeReasoningConfig({ effort: 'high' })).toEqual({
      effort: 'high',
    });
  });

  it('keeps budgetTokens when only a budget is provided', () => {
    expect(normalizeReasoningConfig({ budgetTokens: 2048 })).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2048 },
    });
  });

  it('passes preserve through independently', () => {
    expect(normalizeReasoningConfig({ effort: 'low', preserve: true })).toEqual(
      { effort: 'low', preserve: true },
    );
  });

  it('normalizes disabled/off aliases to none → enabled:false', () => {
    expect(normalizeReasoningConfig({ effort: 'off' })).toEqual({
      enabled: false,
    });
  });

  it('normalizes explicit thinking modes', () => {
    expect(
      normalizeReasoningConfig({
        thinking: { type: 'enabled', budgetTokens: 4096 },
        effort: 'high',
      }),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 4096 },
      effort: 'high',
    });
    expect(
      normalizeReasoningConfig({ thinking: { type: 'adaptive' } }),
    ).toEqual({ thinking: { type: 'adaptive' } });
  });

  it('returns undefined for empty/invalid input', () => {
    expect(normalizeReasoningConfig(undefined)).toBeUndefined();
    expect(normalizeReasoningConfig({})).toBeUndefined();
  });
});

describe('resolveEffectiveReasoningEffort', () => {
  it('returns none when reasoning disabled', () => {
    expect(
      resolveEffectiveReasoningEffort({ reasoning: { enabled: false } }),
    ).toBe('none');
  });
  it('prefers explicit effort', () => {
    expect(
      resolveEffectiveReasoningEffort({ reasoning: { effort: 'high' } }),
    ).toBe('high');
  });
  it('derives a compatibility effort from a fixed token budget', () => {
    expect(
      resolveEffectiveReasoningEffort({ reasoning: { budgetTokens: 2048 } }),
    ).toBe('medium');
  });
  it('returns undefined without reasoning', () => {
    expect(resolveEffectiveReasoningEffort({ temperature: 1 })).toBeUndefined();
  });
});

describe('normalizeLlmGenerationConfig', () => {
  it('validates and drops invalid fields', () => {
    expect(
      normalizeLlmGenerationConfig({
        temperature: 0.7,
        topP: 0.95,
        topK: 20,
        maxTokens: 1000,
        topKBad: -1,
      }),
    ).toEqual({ temperature: 0.7, topP: 0.95, topK: 20, maxTokens: 1000 });
  });
  it('drops non-positive integers', () => {
    expect(
      normalizeLlmGenerationConfig({ topK: 0, maxTokens: -5 }),
    ).toBeUndefined();
  });

  it('rejects fractional values for integer-only fields', () => {
    expect(
      normalizeLlmGenerationConfig({
        topK: 0.1,
        maxTokens: 0.9,
        reasoning: { budgetTokens: 0.5 },
      }),
    ).toBeUndefined();
  });

  it('rejects topP outside the probability range', () => {
    expect(normalizeLlmGenerationConfig({ topP: 1.01 })).toBeUndefined();
    expect(normalizeLlmGenerationConfig({ topP: 1 })).toEqual({ topP: 1 });
  });
});

describe('mergeLlmGenerationConfigs', () => {
  it('uses last-writer-wins for sampling and deep-merges reasoning', () => {
    expect(
      mergeLlmGenerationConfigs(
        {
          temperature: 0.2,
          topK: 20,
          reasoning: { enabled: true, effort: 'high', budgetTokens: 8192 },
        },
        { temperature: 1, reasoning: { preserve: false } },
      ),
    ).toEqual({
      temperature: 1,
      topK: 20,
      reasoning: {
        thinking: { type: 'enabled', budgetTokens: 8192 },
        effort: 'high',
        preserve: false,
      },
    });
  });

  it('keeps effort independent when a higher-priority layer disables thinking', () => {
    expect(
      mergeLlmGenerationConfigs(
        { reasoning: { effort: 'high', budgetTokens: 8192, preserve: true } },
        { reasoning: { enabled: false } },
      ),
    ).toEqual({
      reasoning: {
        enabled: false,
        effort: 'high',
        preserve: true,
      },
    });
  });

  it('lets a higher-priority budget re-enable inherited disabled reasoning', () => {
    expect(
      mergeLlmGenerationConfigs(
        { reasoning: { enabled: false, preserve: true } },
        { reasoning: { budgetTokens: 8192 } },
      ),
    ).toEqual({
      reasoning: {
        thinking: { type: 'enabled', budgetTokens: 8192 },
        preserve: true,
      },
    });
  });

  it('does not let a preserve-only override re-enable reasoning', () => {
    expect(
      mergeLlmGenerationConfigs(
        { reasoning: { enabled: false } },
        { reasoning: { preserve: false } },
      ),
    ).toEqual({
      reasoning: { enabled: false, preserve: false },
    });
  });
});

describe('wire projection', () => {
  it('projects a fixed budget for remote and custom provider transports', () => {
    expect(
      toRemoteWireParameters({ reasoning: { budgetTokens: 63_000 } }),
    ).toEqual({
      reasoning_effort: 'max',
      enable_thinking: true,
      reasoning_budget_tokens: 63_000,
    });
    expect(
      toCustomProviderWireFields({ reasoning: { budgetTokens: 63_000 } }),
    ).toEqual({ enable_thinking: true, thinking_budget: 63_000 });
  });

  it('projects remote wire parameter names', () => {
    expect(
      toRemoteWireParameters({
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        maxTokens: 2000,
        reasoning: {
          enabled: true,
          effort: 'high',
          budgetTokens: 6000,
          preserve: true,
        },
      }),
    ).toEqual({
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 2000,
      reasoning_effort: 'high',
      enable_thinking: true,
      reasoning_budget_tokens: 6000,
      preserve_thinking: true,
    });
  });

  it('projects custom provider wire names (thinking_budget)', () => {
    expect(
      toCustomProviderWireFields({
        topK: 40,
        reasoning: { enabled: true, effort: 'low', budgetTokens: 1000 },
      }),
    ).toEqual({
      top_k: 40,
      enable_thinking: true,
      thinking_budget: 1000,
      reasoning_effort: 'low',
    });
  });

  it('round-trips through wire parameters', () => {
    const gen = {
      temperature: 0.7,
      topP: 0.9,
      topK: 20,
      maxTokens: 500,
      reasoning: { enabled: true, effort: 'high' as const },
    };
    const wire = toRemoteWireParameters(gen);
    expect(generationConfigFromWireParameters(wire)).toEqual(gen);
  });

  it('omits undefined fields', () => {
    expect(toRemoteWireParameters({ temperature: 1 })).toEqual({
      temperature: 1,
    });
    expect(toRemoteWireParameters(undefined)).toEqual({});
  });
});

describe('withReasoningEffortOverride', () => {
  it('overrides effort and enables thinking', () => {
    expect(withReasoningEffortOverride({ temperature: 1 }, 'high')).toEqual({
      temperature: 1,
      reasoning: { enabled: true, effort: 'high' },
    });
  });
  it('none override disables thinking', () => {
    expect(withReasoningEffortOverride({ temperature: 1 }, 'none')).toEqual({
      temperature: 1,
      reasoning: { enabled: false },
    });
  });
  it('non-none override re-enables a disabled persisted config', () => {
    expect(
      withReasoningEffortOverride(
        { temperature: 1, reasoning: { enabled: false, preserve: false } },
        'high',
      ),
    ).toEqual({
      temperature: 1,
      reasoning: {
        enabled: true,
        effort: 'high',
        preserve: false,
      },
    });
  });
  it('drops an inherited budget when an explicit effort overrides it', () => {
    expect(
      withReasoningEffortOverride(
        { reasoning: { budgetTokens: 8192, preserve: true } },
        'low',
      ),
    ).toEqual({
      reasoning: { enabled: true, effort: 'low', preserve: true },
    });
  });
  it('undefined effort leaves config unchanged', () => {
    const gen = { temperature: 1 };
    expect(withReasoningEffortOverride(gen, undefined)).toBe(gen);
  });
});

describe('generationConfigFromLegacyFields', () => {
  it('maps a legacy reasoning effort into generation.reasoning', () => {
    expect(
      generationConfigFromLegacyFields({ reasoningEffort: 'high' }),
    ).toEqual({ reasoning: { effort: 'high' } });
  });
  it('returns undefined for missing/invalid effort', () => {
    expect(generationConfigFromLegacyFields({})).toBeUndefined();
    expect(
      generationConfigFromLegacyFields({ reasoningEffort: 'bogus' }),
    ).toBeUndefined();
  });
});
