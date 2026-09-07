/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ContentGeneratorConfig } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';
import {
  applyReasoningSelection,
  buildModelReasoningConfigOption,
  buildModelReasoningConfigPreview,
  clearReasoningRequestOverrides,
  getModelConfiguration,
  isReasoningSelectionSupported,
  resolvePersistedReasoningConfigState,
} from './model-configuration.js';

describe('model configuration manifest', () => {
  it.each([
    ['gpt-5.1', ['none', 'low', 'medium', 'high'], 'none'],
    ['gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
    ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
    ['gpt-5.6', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh'], 'medium'],
    ['gpt-5-pro', ['high'], 'high'],
  ] as const)(
    'previews the supported efforts and default for %s',
    (model, values, currentValue) => {
      const option = buildModelReasoningConfigOption(model);
      expect(option?.currentValue).toBe(currentValue);
      expect(
        option?.options.map((choice) =>
          'value' in choice ? choice.value : undefined,
        ),
      ).toEqual(values);
      expect(buildModelReasoningConfigPreview(model)).toEqual([option]);
    },
  );

  it('shows a selected effort when a GPT model defaults to thinking off', () => {
    expect(
      buildModelReasoningConfigOption('gpt-5.4', { effort: 'high' }),
    ).toMatchObject({ currentValue: 'high' });
    expect(
      buildModelReasoningConfigOption('gpt-5.4', {
        enabled: false,
        effort: 'high',
      }),
    ).toMatchObject({ currentValue: 'none' });
  });

  it.each(['gpt-5.3-codex', 'gpt-6-astra'])(
    'advertises mandatory thinking for %s even when the state does not require it',
    (model) => {
      expect(
        buildModelReasoningConfigOption(model, {
          enabled: false,
          thinkingMandatory: false,
        }),
      ).toMatchObject({
        currentValue: 'medium',
        _meta: { 'qwenCode/reasoning': { thinkingMandatory: true } },
      });
      expect(isReasoningSelectionSupported(model, 'none')).toBe(false);
      expect(resolvePersistedReasoningConfigState(model, 'none')).toEqual({
        thinkingMandatory: true,
      });
    },
  );

  it('validates persisted GPT tiers against model capabilities', () => {
    expect(isReasoningSelectionSupported('gpt-5.1', 'xhigh')).toBe(false);
    expect(isReasoningSelectionSupported('gpt-5.4', 'max')).toBe(false);
    expect(isReasoningSelectionSupported('gpt-5.6', 'max')).toBe(true);
    expect(isReasoningSelectionSupported('gpt-6-astra', 'max')).toBe(true);
    expect(resolvePersistedReasoningConfigState('gpt-5.4', 'high')).toEqual({
      thinkingMandatory: false,
      enabled: true,
      effort: 'high',
    });
  });

  it.each(['gpt-5.4', 'gpt-6-astra'])(
    'preserves explicit %s reasoning overrides',
    (model) => {
      const generation = {
        model,
        samplingParams: {
          max_completion_tokens: 1024,
          reasoning_effort: 'low',
        },
        extra_body: { reasoning: { effort: 'high' } },
      } as ContentGeneratorConfig;
      const original = structuredClone(generation);
      clearReasoningRequestOverrides(generation);
      expect(generation).toEqual(original);
    },
  );

  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration('qwen3.8-max')).toEqual({
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
      },
    });
  });

  it('builds the stable qwen3.8-max default reasoning option', () => {
    expect(buildModelReasoningConfigOption('qwen3.8-max')).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'xhigh',
      options: [
        { value: 'none' },
        { value: 'low' },
        { value: 'medium' },
        { value: 'xhigh' },
      ],
      _meta: {
        'qwenCode/reasoning': { defaultEffort: 'xhigh' },
      },
    });
  });

  it('omits Thinking off when qwen3.8-max requires thinking', () => {
    expect(
      buildModelReasoningConfigOption('qwen3.8-max', {
        thinkingMandatory: true,
      }),
    ).toMatchObject({
      currentValue: 'xhigh',
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      _meta: {
        'qwenCode/reasoning': {
          defaultEffort: 'xhigh',
          thinkingMandatory: true,
        },
      },
    });
  });

  it.each(['high', 'max'] as const)(
    'falls back from stale %s to the qwen3.8-max model default',
    (effort) => {
      expect(
        buildModelReasoningConfigOption('qwen3.8-max', { effort }),
      ).toMatchObject({ currentValue: 'xhigh' });
    },
  );

  it.each([
    undefined,
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'qwen-route:v1:stable',
    '$runtime|qwen-oauth|qwen3.8-max',
  ])('does not project a tiered welcome preview for %s', (modelId) => {
    expect(buildModelReasoningConfigPreview(modelId)).toBeUndefined();
  });

  it('projects toggle-only reasoning on Welcome without effort tiers', () => {
    expect(buildModelReasoningConfigPreview('qwen3.7-plus')).toEqual([
      buildModelReasoningConfigOption('qwen3.7-plus'),
    ]);
  });

  it.each([
    ['qwen3.8-max', 'low', false, true],
    ['qwen3.8-max', 'max', false, false],
    ['qwen3.8-max', 'none', false, true],
    ['qwen3.8-max', 'none', true, false],
    ['qwen3.7-plus', 'default', false, true],
    ['qwen3.7-plus', 'none', false, true],
    ['qwen3.7-plus', 'low', false, false],
    ['qwen-plus', 'max', false, false],
    ['claude-opus-4-6', 'max', false, true],
  ] as const)(
    'validates %s selection %s with mandatory=%s',
    (modelId, selection, thinkingMandatory, supported) => {
      expect(
        isReasoningSelectionSupported(modelId, selection, thinkingMandatory),
      ).toBe(supported);
    },
  );

  it('wraps the stable default option for workspace preview', () => {
    expect(buildModelReasoningConfigPreview('qwen3.8-max')).toEqual([
      buildModelReasoningConfigOption('qwen3.8-max'),
    ]);
  });

  it('preserves mandatory thinking in the workspace preview', () => {
    expect(
      buildModelReasoningConfigPreview('qwen3.8-max', {
        thinkingMandatory: true,
      }),
    ).toEqual([
      buildModelReasoningConfigOption('qwen3.8-max', {
        thinkingMandatory: true,
      }),
    ]);
  });

  it.each([
    ['qwen3.8-max', 'medium', false, { enabled: true, effort: 'medium' }],
    ['qwen3.8-max', 'none', false, { enabled: false }],
    ['qwen3.8-max', 'max', false, {}],
    ['qwen3.8-max', 'none', true, {}],
  ] as const)(
    'projects persisted %s selection %s with mandatory=%s',
    (modelId, selection, mandatory, expected) => {
      expect(
        resolvePersistedReasoningConfigState(modelId, selection, mandatory),
      ).toEqual({ ...expected, thinkingMandatory: mandatory });
    },
  );

  it.each([
    'qwen3.5-plus',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.7-plus',
    'qwen3.7-max',
  ])('registers toggle-only reasoning for %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toEqual({
      reasoning: {
        thinking: true,
        toggleOnly: true,
      },
    });
  });

  it.each([
    undefined,
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'vendor/qwen3.8-max',
    'qwen3.7-plus-latest',
    'vendor/qwen3.7-plus',
    'QWEN3.7-PLUS',
    'qwen3-max-2026-01-23',
    'qwen3-coder-plus',
    'qwen3-coder-next',
  ])('does not broaden the manifest to %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toBeUndefined();
  });

  it('preserves reasoning siblings when returning to the model default', () => {
    const live = {
      reasoning: { effort: 'high' as const, budget_tokens: 42_000 },
    };
    const rebuildable = {
      reasoning: { effort: 'high' as const, budget_tokens: 42_000 },
    };
    const config = {
      getContentGeneratorConfig: () => live,
      getModelsConfig: () => ({
        getGenerationConfig: () => rebuildable,
      }),
    } as unknown as Config;

    applyReasoningSelection(config, 'default');

    expect(live.reasoning).toEqual({ budget_tokens: 42_000 });
    expect(rebuildable.reasoning).toEqual({ budget_tokens: 42_000 });
  });

  it('restores configured reasoning siblings after thinking is turned off', () => {
    const live: Partial<ContentGeneratorConfig> = {
      reasoning: { effort: 'max', budget_tokens: 42_000 },
    };
    const rebuildable = { ...live };
    const config = {
      getContentGeneratorConfig: () => live,
      getModelsConfig: () => ({
        getGenerationConfig: () => rebuildable,
      }),
    } as unknown as Config;

    applyReasoningSelection(config, 'none');
    applyReasoningSelection(config, 'default', { budget_tokens: 42_000 });

    expect(live.reasoning).toEqual({ budget_tokens: 42_000 });
    expect(rebuildable.reasoning).toEqual({ budget_tokens: 42_000 });
  });

  it('resets to a configured default-off state instead of enabling thinking', () => {
    const live: Partial<ContentGeneratorConfig> = {
      reasoning: { effort: 'max' },
    };
    const config = {
      getContentGeneratorConfig: () => live,
    } as unknown as Config;

    applyReasoningSelection(config, 'default', false);

    expect(live.reasoning).toBe(false);
  });
});
