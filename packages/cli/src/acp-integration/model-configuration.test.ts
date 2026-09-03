/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type ContentGeneratorConfig,
  type ModelReasoningConfigInput,
} from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyReasoningSelection,
  buildModelReasoningConfigOption,
  buildModelReasoningConfigPreview,
  getModelConfiguration,
  isReasoningSelectionSupported,
  resolvePersistedReasoningConfigState,
} from './model-configuration.js';

const STANDARD = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const route = (
  modelId: string | undefined,
  baseUrl = STANDARD,
): ModelReasoningConfigInput => ({
  modelId,
  authType: AuthType.USE_OPENAI,
  baseUrl,
});

describe('model configuration manifest', () => {
  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration(route('qwen3.8-max'))).toMatchObject({
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
        endpointFamily: 'alibaba-standard',
        wireShape: 'qwen-effort',
      },
    });
  });

  it('builds the stable qwen3.8-max default reasoning option', () => {
    expect(buildModelReasoningConfigOption(route('qwen3.8-max'))).toMatchObject(
      {
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
      },
    );
  });

  it('omits Thinking off when qwen3.8-max requires thinking', () => {
    expect(
      buildModelReasoningConfigOption(route('qwen3.8-max'), {
        thinkingMandatory: true,
      }),
    ).toMatchObject({
      currentValue: 'xhigh',
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      _meta: {
        'qwenCode/reasoning': {
          defaultEffort: 'xhigh',
          canDisable: false,
        },
      },
    });
  });

  it.each(['high', 'max'] as const)(
    'falls back from stale %s to the qwen3.8-max model default',
    (effort) => {
      expect(
        buildModelReasoningConfigOption(route('qwen3.8-max'), { effort }),
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
    expect(buildModelReasoningConfigPreview(route(modelId))).toBeUndefined();
  });

  it('projects toggle-only reasoning on Welcome without effort tiers', () => {
    expect(buildModelReasoningConfigPreview(route('qwen3.7-plus'))).toEqual([
      buildModelReasoningConfigOption(route('qwen3.7-plus')),
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
        isReasoningSelectionSupported(
          route(modelId),
          selection,
          thinkingMandatory,
        ),
      ).toBe(supported);
    },
  );

  it('wraps the stable default option for workspace preview', () => {
    expect(buildModelReasoningConfigPreview(route('qwen3.8-max'))).toEqual([
      buildModelReasoningConfigOption(route('qwen3.8-max')),
    ]);
  });

  it('preserves mandatory thinking in the workspace preview', () => {
    expect(
      buildModelReasoningConfigPreview(route('qwen3.8-max'), {
        thinkingMandatory: true,
      }),
    ).toEqual([
      buildModelReasoningConfigOption(route('qwen3.8-max'), {
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
        resolvePersistedReasoningConfigState(
          route(modelId),
          selection,
          mandatory,
        ),
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
    expect(getModelConfiguration(route(modelId))).toMatchObject({
      reasoning: {
        thinking: true,
        toggleOnly: true,
        endpointFamily: 'alibaba-standard',
        wireShape: 'qwen-toggle',
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
    'qwen3-max-2026-01-23',
    'qwen3-coder-plus',
    'qwen3-coder-next',
  ])('does not broaden the manifest to %s', (modelId) => {
    expect(getModelConfiguration(route(modelId))).toBeUndefined();
  });

  it('matches an exact registered model ID case-insensitively', () => {
    expect(getModelConfiguration(route('QWEN3.7-PLUS'))).toBeDefined();
  });

  it('publishes canDisable=false for mandatory provider models', () => {
    const option = buildModelReasoningConfigOption(route('ZHIPU/GLM-5.3'));

    expect(option).toMatchObject({
      currentValue: 'max',
      options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      _meta: {
        'qwenCode/reasoning': {
          defaultEffort: 'max',
          canDisable: false,
        },
      },
    });
  });

  it('revalidates a persisted tier when the endpoint changes', () => {
    const standard = route(
      'glm-5.2',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const tokenPlan = route(
      'glm-5.2',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );

    expect(resolvePersistedReasoningConfigState(standard, 'high')).toEqual({
      enabled: true,
      effort: 'high',
      thinkingMandatory: false,
    });
    expect(resolvePersistedReasoningConfigState(tokenPlan, 'high')).toEqual({
      thinkingMandatory: false,
    });
  });

  it('falls back before exposing a stale off value for a mandatory model', () => {
    const mandatory = route('kimi-k3', 'https://api.moonshot.ai/v1');

    expect(resolvePersistedReasoningConfigState(mandatory, 'none')).toEqual({
      thinkingMandatory: false,
    });
    expect(buildModelReasoningConfigOption(mandatory)).toMatchObject({
      currentValue: 'max',
      options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    });
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

  it('records selections through Config when the lifecycle methods exist', () => {
    const setReasoningDisabled = vi.fn();
    const setReasoningEffort = vi.fn();
    const config = {
      setReasoningDisabled,
      setReasoningEffort,
    } as unknown as Config;

    applyReasoningSelection(config, 'none');
    expect(setReasoningDisabled).toHaveBeenLastCalledWith(true);

    applyReasoningSelection(config, 'medium');
    expect(setReasoningDisabled).toHaveBeenLastCalledWith(false);
    expect(setReasoningEffort).toHaveBeenLastCalledWith('medium');
  });
});
