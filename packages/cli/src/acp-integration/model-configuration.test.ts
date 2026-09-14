/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ContentGeneratorConfig } from '@qwen-code/qwen-code-core';
import {
  buildInstallPlan,
  findProviderById,
  REASONING_EFFORT_TIERS,
  resolveBaseUrl,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { describe, expect, it, vi } from 'vitest';
import {
  applyReasoningSelection,
  buildModelReasoningConfigOption,
  buildModelReasoningConfigPreview,
  clearReasoningRequestOverrides,
  getConfiguredModelReasoning,
  getDefaultReasoningConfig,
  getModelConfiguration,
  getGptReasoningOverrideState,
  getReasoningEffortsForConfig,
  type ModelReasoningConfiguration,
  isReasoningSelectionSupported,
  resolvePersistedReasoningConfigState,
} from './model-configuration.js';

describe('default reasoning configuration', () => {
  it.each([
    [{ reasoning: false }, { effort: 'high' }, false, false],
    [{}, false, false, undefined],
    [undefined, false, false, false],
    [{ reasoning: { effort: 'max' } }, false, true, false],
  ] as const)(
    'resolves model defaults %j with legacy default %j and runtime %s',
    (generationConfig, legacyDefault, runtime, expected) => {
      const resolve = vi.fn(() =>
        generationConfig ? { generationConfig } : undefined,
      );
      const config = {
        getAuthType: () => 'openai',
        getModel: () => 'gpt-5.5',
        getCurrentModelRegistryBaseUrl: () => 'https://selected.example/v1',
        getActiveRuntimeModelSnapshot: () => (runtime ? {} : undefined),
        getResolvedModelConfig: resolve,
      } as unknown as Config;
      const settings = {
        merged: { model: { generationConfig: { reasoning: legacyDefault } } },
      } as unknown as LoadedSettings;
      expect(getDefaultReasoningConfig(config, settings)).toEqual(expected);
      if (runtime) {
        expect(resolve).not.toHaveBeenCalled();
      } else {
        expect(resolve).toHaveBeenCalledWith(
          'openai',
          'gpt-5.5',
          'https://selected.example/v1',
        );
      }
    },
  );
});

describe('model configuration manifest', () => {
  it.each([
    ['moonshot', 'kimi-k3', ['low', 'high', 'max'], 'max'],
    ['moonshot', 'kimi-k2.7-code', ['default'], 'default'],
    ['moonshot', 'kimi-k2.7-code-highspeed', ['default'], 'default'],
    ['moonshot', 'kimi-k2.6', ['none', 'default'], 'default'],
    ['deepseek', 'deepseek-v4-pro', ['none', 'low', 'high', 'max'], 'high'],
    ['deepseek', 'deepseek-v4-flash', ['none', 'low', 'high', 'max'], 'high'],
    [
      'alibabaStandard',
      'qwen3.8-max',
      ['none', 'low', 'medium', 'xhigh'],
      'xhigh',
    ],
    [
      'alibabaStandard',
      'qwen3.8-max-0902',
      ['none', 'low', 'medium', 'xhigh'],
      'xhigh',
    ],
    [
      'alibabaStandard',
      'qwen3.8-flash',
      ['none', 'low', 'medium', 'xhigh'],
      'xhigh',
    ],
    ['alibabaStandard', 'deepseek-v4-pro', ['none', 'high', 'max'], 'high'],
    [
      'alibabaStandard',
      'deepseek-v4-pro-0813',
      ['none', 'low', 'high', 'max'],
      'high',
    ],
    ['alibabaStandard', 'kimi-k3', ['low', 'high', 'max'], 'max'],
    ['token-plan', 'qwen3.8-max', ['low', 'medium', 'xhigh'], 'xhigh'],
    ['token-plan', 'qwen3.8-max-preview', ['low', 'medium', 'xhigh'], 'xhigh'],
    [
      'token-plan',
      'qwen3.8-flash',
      ['none', 'low', 'medium', 'xhigh'],
      'xhigh',
    ],
    [
      'token-plan',
      'deepseek-v4-flash-0731',
      ['none', 'low', 'high', 'max'],
      'high',
    ],
    ['coding-plan', 'qwen3.5-plus', ['none', 'default'], 'default'],
    ['coding-plan', 'kimi-k2.5', ['none', 'default'], 'default'],
  ] as const)(
    'projects installed %s / %s native choices',
    (providerId, model, values, currentValue) => {
      const preset = findProviderById(providerId)!;
      const installed = buildInstallPlan(preset, {
        baseUrl: resolveBaseUrl(preset),
        apiKey: 'test-key',
        modelIds: [model],
      }).modelProviders![0].models[0];
      const reasoning = installed.capabilities?.reasoning;
      expect(reasoning).toBeDefined();
      const option = buildModelReasoningConfigOption(model, {}, reasoning);
      expect(
        option?.options.map((item) =>
          'value' in item ? item.value : undefined,
        ),
      ).toEqual(values);
      expect(option?.currentValue).toBe(currentValue);
      const restored = buildModelReasoningConfigOption(
        model,
        { effort: 'high' },
        reasoning,
      );
      expect(restored?.currentValue).toBe(
        values.some((value) => value === 'high') ? 'high' : currentValue,
      );
    },
  );
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

  it.each([
    ['gpt-5.4', 'max', 'xhigh'],
    ['gpt-5.1', 'max', 'high'],
    ['gpt-5-pro', 'low', 'high'],
  ] as const)(
    'displays the same clamped %s tier as the provider',
    (model, effort, expected) => {
      expect(buildModelReasoningConfigOption(model, { effort })).toMatchObject({
        currentValue: expected,
      });
      expect(resolvePersistedReasoningConfigState(model, effort)).toEqual({
        enabled: true,
        effort: expected,
        thinkingMandatory: model === 'gpt-5-pro',
      });
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
  it('keeps configured GPT tiers and defaults ahead of the built-in fallback', () => {
    const reasoning = {
      thinking: true,
      efforts: ['medium', 'max'],
      defaultEffort: 'max',
      disableField: 'reasoning_effort',
    } as const;
    expect(
      buildModelReasoningConfigOption('gpt-5.4', {}, reasoning),
    ).toMatchObject({
      currentValue: 'max',
      options: [{ value: 'none' }, { value: 'medium' }, { value: 'max' }],
    });
    expect(
      resolvePersistedReasoningConfigState('gpt-5.4', 'max', false, reasoning),
    ).toEqual({ thinkingMandatory: false, enabled: true, effort: 'max' });
    expect(
      isReasoningSelectionSupported('gpt-5.4', 'low', false, reasoning),
    ).toBe(false);
    expect(
      buildModelReasoningConfigOption(
        'gpt-6-astra',
        { enabled: false },
        reasoning,
      ),
    ).toMatchObject({
      currentValue: 'max',
      options: [{ value: 'medium' }, { value: 'max' }],
      _meta: { 'qwenCode/reasoning': { thinkingMandatory: true } },
    });
  });

  it('projects reasoning declared by the resolved provider model', () => {
    const reasoning = {
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      disableField: 'thinking',
    } as const;
    const config = {
      getModel: () => 'deepseek-v4-pro',
      getAuthType: () => 'openai',
      getContentGeneratorConfig: () => ({
        model: 'deepseek-v4-pro',
        authType: 'openai',
        baseUrl: 'https://api.deepseek.com',
      }),
      getResolvedModelConfig: () => ({ capabilities: { reasoning } }),
    } as unknown as Config;

    expect(getConfiguredModelReasoning(config)).toBe(reasoning);
    for (const guarded of [
      { getActiveRuntimeModelSnapshot: () => ({ id: 'runtime-model' }) },
      { getModel: () => 'qwen-route:v1:opaque' },
    ]) {
      expect(
        getConfiguredModelReasoning({
          ...config,
          ...guarded,
        } as unknown as Config),
      ).toBeUndefined();
    }
    expect(
      buildModelReasoningConfigOption('deepseek-v4-pro', {}, reasoning),
    ).toMatchObject({
      currentValue: 'high',
      options: [{ value: 'none' }, { value: 'high' }, { value: 'max' }],
    });
    expect(
      isReasoningSelectionSupported('deepseek-v4-pro', 'low', false, reasoning),
    ).toBe(false);

    expect(
      buildModelReasoningConfigOption(
        'deepseek-v4-pro',
        {},
        {
          ...reasoning,
          canDisable: false,
        },
      )?.options,
    ).toMatchObject([{ value: 'high' }, { value: 'max' }]);
  });

  it('ignores an incomplete user-provided reasoning capability', () => {
    const config = {
      getModel: () => 'custom-model',
      getAuthType: () => 'openai',
      getResolvedModelConfig: () => ({
        capabilities: { reasoning: { thinking: true } },
      }),
    } as unknown as Config;
    expect(getConfiguredModelReasoning(config)).toBeUndefined();
  });

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

describe('GPT raw reasoning reporting', () => {
  it.each([
    [{ model: 'custom-model', extra_body: { reasoning: false } }, undefined],
    [{ reasoning: false, extra_body: { reasoning: false } }, undefined],
    [
      { extra_body: { reasoning: false } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: null } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { model: 'gpt-5.4', extra_body: { reasoning: { effort: 'high' } } },
      { enabled: false, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: { effort: 'high' } } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: false, reasoning_effort: 'none' } },
      { enabled: false, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning_effort: 'high' } },
      { enabled: true, effort: 'high', useDefaultEffort: false },
    ],
    [
      { samplingParams: { reasoning_effort: 'high' } },
      { enabled: true, effort: 'high', useDefaultEffort: false },
    ],
    [
      {
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: 'low' },
      },
      { enabled: true, effort: 'low', useDefaultEffort: false },
    ],
    [
      {
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: null },
      },
      undefined,
    ],
    [
      { model: 'gpt-6-astra', extra_body: { reasoning_effort: 'none' } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      {
        model: 'gpt-5.5',
        thinkingMandatory: true,
        extra_body: { reasoning_effort: 'none' },
      },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        extra_body: { reasoning_effort: 'high' },
      },
      undefined,
    ],
    [
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        samplingParams: { reasoning_effort: 'high' },
      },
      { enabled: true, effort: 'high', useDefaultEffort: false },
    ],
    [
      {
        model: 'gpt-5.4',
        baseUrl: 'https://openrouter.ai/api/v1',
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: 'low' },
      },
      { enabled: true, effort: 'low', useDefaultEffort: false },
    ],
    [
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        samplingParams: { reasoning_effort: 'none' },
      },
      { enabled: false, useDefaultEffort: true },
    ],
    [
      {
        model: 'gpt-6-astra',
        baseUrl: 'https://openrouter.ai/api/v1',
        samplingParams: { reasoning_effort: 'none' },
      },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: '' },
      },
      undefined,
    ],
  ] as const)(
    'reports effective raw precedence for %j',
    (overrides, expected) => {
      expect(
        getGptReasoningOverrideState({
          model: 'gpt-5.5',
          baseUrl: 'https://api.openai.com/v1',
          reasoning: { effort: 'xhigh' },
          ...overrides,
        } as ContentGeneratorConfig),
      ).toEqual(expected ? { ...expected, blocksTierChange: true } : undefined);
    },
  );

  it.each(['samplingParams', 'extra_body'] as const)(
    'projects OpenRouter nested overrides from %s',
    (layer) => {
      for (const [model, reasoning, expected] of [
        ['gpt-5.5', null, { enabled: true, useDefaultEffort: true }],
        ['gpt-5.5', false, { enabled: false, useDefaultEffort: true }],
        [
          'gpt-5.5',
          { enabled: false },
          { enabled: false, useDefaultEffort: true },
        ],
        [
          'gpt-5.5',
          { effort: 'none' },
          { enabled: false, useDefaultEffort: true },
        ],
        ['gpt-5.5', {}, { enabled: true, useDefaultEffort: true }],
        [
          'gpt-5.4',
          { enabled: true },
          { enabled: true, useDefaultEffort: true },
        ],
        [
          'gpt-5.4',
          { max_tokens: 1024 },
          { enabled: true, useDefaultEffort: true },
        ],
        [
          'gpt-5.4',
          { effort: 'high' },
          { enabled: true, effort: 'high', useDefaultEffort: false },
        ],
        ['gpt-5.4', {}, { enabled: false, useDefaultEffort: true }],
      ] as const) {
        expect(
          getGptReasoningOverrideState({
            model,
            baseUrl: 'https://openrouter.ai/api/v1',
            reasoning: { effort: 'xhigh' },
            [layer]: { reasoning, reasoning_effort: 'none' },
          } as ContentGeneratorConfig),
        ).toEqual({ ...expected, blocksTierChange: true });
      }
    },
  );

  it('allows configured capability injection past an OpenRouter sampling flat override', () => {
    expect(
      getGptReasoningOverrideState(
        {
          model: 'gpt-5.5',
          baseUrl: 'https://openrouter.ai/api/v1',
          reasoning: { effort: 'high' },
          samplingParams: { reasoning_effort: 'low' },
        } as ContentGeneratorConfig,
        {
          thinking: true,
          disableField: 'reasoning_effort',
          efforts: ['low', 'high'],
        } as ModelReasoningConfiguration,
      ),
    ).toBeUndefined();
  });
});

// `/effort` and a workflow agent's per-call effort share one tier rule (core's
// reasoningEffortsForCapability); these pin it at the `/effort` read site.
describe('getReasoningEffortsForConfig', () => {
  const configWith = (reasoning: unknown) =>
    ({
      getModel: () => 'custom-model',
      getAuthType: () => 'openai',
      getContentGeneratorConfig: () => ({
        model: 'custom-model',
        authType: 'openai',
        baseUrl: 'https://example.com',
      }),
      getResolvedModelConfig: () => ({ capabilities: { reasoning } }),
    }) as unknown as Config;

  it('offers nothing for a toggle-only model', () => {
    expect(
      getReasoningEffortsForConfig(
        configWith({
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        }),
      ),
    ).toEqual([]);
  });

  it('offers exactly the declared tiers', () => {
    expect(
      getReasoningEffortsForConfig(
        configWith({
          thinking: true,
          disableField: 'reasoning_effort',
          efforts: ['low', 'high'],
        }),
      ),
    ).toEqual(['low', 'high']);
  });

  it('offers every tier for a model that declares none', () => {
    expect(getReasoningEffortsForConfig(configWith(undefined))).toEqual(
      REASONING_EFFORT_TIERS,
    );
  });
});
