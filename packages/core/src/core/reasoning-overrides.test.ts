/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthType, type ContentGeneratorConfig } from './contentGenerator.js';
import { Config } from '../config/config.js';
import {
  captureReasoningSnapshot,
  getEffectiveReasoning,
  resolveReasoningCapabilities,
  resolveReasoningForModel,
} from './reasoning-overrides.js';
import type { AvailableModel } from '../models/types.js';

const route: ContentGeneratorConfig = {
  model: 'alias',
  authType: AuthType.USE_OPENAI,
  baseUrl: 'https://one.example/v1',
};
const declaration = {
  profile: 'openai-effort' as const,
  efforts: ['low', 'medium', 'high'] as const,
  defaultEffort: 'medium' as const,
};
const model = (
  id = 'alias',
  defaultEffort: 'low' | 'medium' | 'high' = 'medium',
): AvailableModel => ({
  id,
  label: id,
  authType: AuthType.USE_OPENAI,
  baseUrl: route.baseUrl,
  registryBaseUrl: route.baseUrl,
  capabilities: { reasoning: { ...declaration, defaultEffort } },
});

describe('reasoning declarations', () => {
  it('overrides a known default without persisting a user choice', () => {
    const resolved = resolveReasoningCapabilities(
      {
        ...route,
        model: 'qwen3.8-max',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      { defaultEffort: 'medium' },
    );
    expect(resolved).toMatchObject({
      profile: 'dashscope-effort',
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'medium',
    });
    expect(getEffectiveReasoning(route, resolved)).toEqual({
      effort: 'medium',
    });
    expect(route.reasoning).toBeUndefined();
    expect(
      getEffectiveReasoning({ reasoning: { effort: 'high' } }, resolved),
    ).toEqual({ effort: 'xhigh' });
    expect(getEffectiveReasoning({ reasoning: false }, resolved)).toBe(false);
  });

  it('inherits mandatory thinking while changing a known model format', () => {
    const capability = resolveReasoningCapabilities(
      { ...route, model: 'gpt-5' },
      declaration,
    );
    expect(capability?.canDisable).toBe(false);
    expect(getEffectiveReasoning({ reasoning: false }, capability)).toEqual({
      effort: 'medium',
    });
  });

  it('inherits default-off until an explicit default is supplied', () => {
    const known = { ...route, model: 'gpt-5.2' };
    const override = { efforts: ['low', 'medium', 'high'] };
    expect(
      getEffectiveReasoning({}, resolveReasoningCapabilities(known, override)),
    ).toBe(false);
    expect(
      getEffectiveReasoning(
        {},
        resolveReasoningCapabilities(known, {
          ...override,
          defaultEffort: 'medium',
        }),
      ),
    ).toEqual({ effort: 'medium' });
  });

  it('preserves undeclared and malformed legacy inputs', () => {
    expect(resolveReasoningCapabilities(route, undefined)).toBeUndefined();
    expect(
      resolveReasoningCapabilities(route, { thinking: true }),
    ).toBeUndefined();
    const reasoning = { effort: 'high' as const, budget_tokens: 5000 };
    expect(getEffectiveReasoning({ reasoning })).toBe(reasoning);
  });

  it.each([
    {},
    { defaultEffort: 'medium' },
    { ...declaration, profile: 'unknown' },
    { ...declaration, efforts: [] },
    { ...declaration, efforts: 'medium' },
    { ...declaration, defaultEffort: null },
    { ...declaration, efforts: ['low', 'low'] },
    { ...declaration, defaultEffort: 'max' },
    { ...declaration, profile: 'gemini' },
    { profile: 'dashscope-thinking', defaultEffort: 'medium' },
  ])('rejects an invalid declaration %j', (value) => {
    expect(() => resolveReasoningCapabilities(route, value)).toThrow(
      'capabilities.reasoning',
    );
  });

  it('clamps an inherited default when replacing the tier set', () => {
    expect(
      resolveReasoningCapabilities(
        { ...route, model: 'gpt-5.5' },
        { efforts: ['low', 'high'] },
      ),
    ).toMatchObject({ defaultEffort: 'high' });
  });

  it('inherits Claude native tiers and adaptive mode for a default-only override', () => {
    expect(
      resolveReasoningCapabilities(
        {
          ...route,
          model: 'claude-opus-4-6',
          authType: AuthType.USE_ANTHROPIC,
        },
        { defaultEffort: 'medium' },
      ),
    ).toMatchObject({
      profile: 'anthropic-adaptive',
      efforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'medium',
    });
  });

  it('ignores misleading Qwen hosts during inference', () => {
    expect(() =>
      resolveReasoningCapabilities(
        {
          ...route,
          model: 'qwen3.8-max',
          baseUrl: 'https://evil.example/dashscope.aliyuncs.com',
        },
        { defaultEffort: 'medium' },
      ),
    ).toThrow();
  });
});

describe('prompt reasoning snapshots', () => {
  it('uses the captured capability for existing DashScope override controls', () => {
    const config = Object.create(Config.prototype) as Config;
    const generation = {
      ...route,
      model: 'qwen3.8-max',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      reasoningRouteBaseUrl: route.baseUrl,
      extra_body: { reasoning_effort: 'high' },
      reasoningSnapshot: captureReasoningSnapshot([model('qwen3.8-max')]),
    };
    Object.assign(config, {
      getContentGeneratorConfig: () => generation,
      getReasoningEffort: () => undefined,
      getResolvedModelConfig: () => {
        throw new Error('must not read live reasoning');
      },
    });
    expect(config.getReasoningEffortOverride()).toEqual({
      source: 'extra_body',
      field: 'reasoning_effort',
    });
  });

  it('is immutable, exact-route scoped, and never falls through to a changed registry', () => {
    const models = [
      model(),
      {
        ...model('alias', 'high'),
        baseUrl: 'https://two.example/v1',
        registryBaseUrl: 'https://two.example/v1',
      },
    ];
    const snapshot = captureReasoningSnapshot(models);
    models[0]!.capabilities = {
      reasoning: { ...declaration, defaultEffort: 'low' },
    };
    const getResolvedModelConfig = vi.fn();
    const config = { getResolvedModelConfig };
    expect(
      resolveReasoningForModel(config, {
        ...route,
        reasoningSnapshot: snapshot,
      }),
    ).toMatchObject({ defaultEffort: 'medium' });
    expect(
      resolveReasoningForModel(config, {
        ...route,
        baseUrl: 'https://two.example/v1',
        reasoningSnapshot: snapshot,
      }),
    ).toMatchObject({ defaultEffort: 'high' });
    expect(
      resolveReasoningForModel(config, {
        ...route,
        baseUrl: 'https://third.example/v1',
        reasoningSnapshot: snapshot,
      }),
    ).toBeUndefined();
    expect(
      resolveReasoningForModel(
        config,
        { ...route, reasoningSnapshot: snapshot },
        'missing-child',
      ),
    ).toBeUndefined();
    expect(getResolvedModelConfig).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]!.reasoning!.efforts)).toBe(true);
  });

  it('distinguishes implicit and explicit entries sharing the default endpoint', () => {
    const snapshot = captureReasoningSnapshot([
      { ...model('alias', 'low'), registryBaseUrl: undefined },
      model('alias', 'high'),
    ]);
    expect(
      resolveReasoningForModel(undefined, {
        ...route,
        reasoningSnapshot: snapshot,
        reasoningRouteBaseUrl: null,
      }),
    ).toMatchObject({ defaultEffort: 'low' });
    expect(
      resolveReasoningForModel(undefined, {
        ...route,
        reasoningSnapshot: snapshot,
        reasoningRouteBaseUrl: route.baseUrl,
      }),
    ).toMatchObject({ defaultEffort: 'high' });
  });

  it('adopts the latest table only at admission and retains a child table', () => {
    let models = [model(), model('child', 'low')];
    const generation = {
      ...route,
      reasoningSnapshot: captureReasoningSnapshot(models),
    };
    const child = { ...generation, model: 'child' };
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      reasoningSnapshot: generation.reasoningSnapshot,
      getAllConfiguredModels: () => models,
      getContentGeneratorConfig: () => generation,
      notifyModelChangeListeners: vi.fn(),
      debugLogger: { error: vi.fn() },
    });
    models = [model('alias', 'low'), model('child', 'medium')];
    models = [model('alias', 'high'), model('child', 'high')];
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'medium',
    });
    expect(config.applyReasoningOverrides()).toBe(true);
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'high',
    });
    expect(resolveReasoningForModel(config, child)).toMatchObject({
      defaultEffort: 'low',
    });
    models[0]!.capabilities = {
      reasoning: { ...declaration, efforts: ['low'], defaultEffort: 'high' },
    };
    expect(config.applyReasoningOverrides()).toBe(false);
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'high',
    });
  });
  it.each([false, true])(
    'retains a valid observed update after invalid input (inactive implicit route: %s)',
    (inactive) => {
      let models = [model('alias', 'low')];
      const generation = {
        ...route,
        reasoningSnapshot: captureReasoningSnapshot(models),
      };
      const config = Object.create(Config.prototype) as Config;
      Object.assign(config, {
        reasoningSnapshot: generation.reasoningSnapshot,
        getAllConfiguredModels: () => models,
        getContentGeneratorConfig: () => generation,
        modelsConfig: { reloadModelProvidersConfig: vi.fn() },
        notifyModelChangeListeners: vi.fn(),
        debugLogger: { error: vi.fn() },
      });
      models = [model('alias', 'high')];
      config.reloadModelProvidersConfig();
      if (inactive) {
        models.push({
          ...model('child'),
          registryBaseUrl: undefined,
          capabilities: {
            reasoning: { efforts: ['low'], defaultEffort: 'high' },
          },
        });
      } else {
        models[0]!.capabilities = {
          reasoning: {
            ...declaration,
            efforts: ['low'],
            defaultEffort: 'high',
          },
        };
      }
      config.reloadModelProvidersConfig();
      expect(resolveReasoningForModel(config, generation)).toMatchObject({
        defaultEffort: 'low',
      });
      expect(config.applyReasoningOverrides()).toBe(true);
      expect(resolveReasoningForModel(config, generation)).toMatchObject({
        defaultEffort: 'high',
      });
      expect(
        config.getContentGeneratorConfig()?.reasoningSnapshot,
      ).toHaveLength(1);
    },
  );
});
