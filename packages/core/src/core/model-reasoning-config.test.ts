/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType, type ContentGeneratorConfig } from './contentGenerator.js';
import {
  resolveEffectiveReasoning,
  resolveModelReasoningConfig,
  getModelReasoningConfig,
} from './model-reasoning-config.js';
import { ModelRegistry } from '../models/modelRegistry.js';

const route: ContentGeneratorConfig = {
  model: 'unknown-alias',
  authType: AuthType.USE_OPENAI,
  baseUrl: 'https://proxy.example/v1',
  reasoningConfig: {
    profile: 'dashscope-effort',
    supportedEfforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'medium',
  },
};

describe('external model reasoning configuration', () => {
  it('leaves unconfigured routes untouched', () => {
    expect(
      resolveModelReasoningConfig({ model: 'qwen3.8-max' }),
    ).toBeUndefined();
    const legacy = { reasoning: { effort: 'max' as const } };
    expect(resolveEffectiveReasoning(legacy, undefined)).toBe(legacy.reasoning);
  });

  it('applies a default without persisting it as a user selection', () => {
    const resolved = resolveModelReasoningConfig(route);
    expect(resolveEffectiveReasoning(route, resolved)).toEqual({
      effort: 'medium',
    });
    expect(route.reasoning).toBeUndefined();
    expect(
      resolveEffectiveReasoning(
        { reasoning: { effort: 'high', budget_tokens: 2048 } },
        resolved,
      ),
    ).toEqual({ effort: 'xhigh', budget_tokens: 2048 });
    expect(resolveEffectiveReasoning({ reasoning: false }, resolved)).toBe(
      false,
    );
  });

  it('restores the declared default when thinking is mandatory', () => {
    const resolved = resolveModelReasoningConfig({
      ...route,
      thinkingMandatory: true,
    });
    expect(resolveEffectiveReasoning({ reasoning: false }, resolved)).toEqual({
      effort: 'medium',
    });
  });

  it('overrides a known name and host, including mandatory name inference', () => {
    const resolved = resolveModelReasoningConfig({
      ...route,
      model: 'gpt-6-astra',
      reasoningConfig: {
        profile: 'openai-reasoning',
        supportedEfforts: ['max'],
        defaultEffort: 'max',
      },
    });
    expect(resolved).toMatchObject({
      profile: 'openai-reasoning',
      efforts: ['max'],
      defaultEffort: 'max',
    });
    expect(resolved?.canDisable).toBeUndefined();
  });

  it('inherits existing capabilities when only a default is overridden', () => {
    const resolved = resolveModelReasoningConfig(
      { ...route, reasoningConfig: { defaultEffort: 'max' } },
      {
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        disableField: 'thinking',
        canDisable: false,
      },
    );
    expect(resolved).toMatchObject({
      profile: 'deepseek-openai',
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      canDisable: false,
    });
  });

  it.each([
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://gateway.alibaba-inc.com/v1',
  ])(
    'reuses existing DashScope detection at %s when profile is omitted',
    (baseUrl) => {
      const resolved = resolveModelReasoningConfig({
        ...route,
        model: 'qwen3.8-max',
        baseUrl,
        reasoningConfig: { defaultEffort: 'medium' },
      });
      expect(resolved?.profile).toBe('dashscope-effort');
    },
  );

  it('allows explicit thinkingMandatory false to override a legacy constraint', () => {
    const resolved = resolveModelReasoningConfig(
      { ...route, thinkingMandatory: false },
      {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        disableField: 'reasoning_effort',
        canDisable: false,
      },
    );
    expect(resolved?.canDisable).toBeUndefined();
  });

  it.each([
    { profile: 'not-a-profile' },
    { profile: null },
    { supportedEfforts: null },
    { defaultEffort: null },
    { supportedEfforts: ['high', 'high'] },
    { supportedEfforts: [] },
    { supportedEfforts: ['ultra'] },
    { supportedEfforts: ['high'], defaultEffort: 'low' },
    { profile: 'qwen-chat-template', defaultEffort: 'high' },
    { profile: 'anthropic-adaptive' },
    { budgetTokensByEffort: { high: 9000 } },
  ])(
    'rejects invalid declaration %j with a model and field',
    (reasoningConfig) => {
      expect(() =>
        resolveModelReasoningConfig({
          ...route,
          reasoningConfig,
        } as ContentGeneratorConfig),
      ).toThrow(/unknown-alias.*reasoningConfig\./);
    },
  );

  it('rejects native Gemini tiers that its adapter cannot map', () => {
    expect(() =>
      resolveModelReasoningConfig({
        model: 'alias',
        authType: AuthType.USE_GEMINI,
        reasoningConfig: { profile: 'gemini', supportedEfforts: ['max'] },
      }),
    ).toThrow('Gemini supports');
  });

  it('keeps exact same-name endpoints separate and clears an unknown request override', () => {
    const registry = new ModelRegistry({
      openai: [
        {
          id: route.model,
          baseUrl: route.baseUrl,
          generationConfig: { reasoningConfig: route.reasoningConfig },
        },
        {
          id: route.model,
          baseUrl: 'https://second.example/v1',
          generationConfig: {
            reasoningConfig: { profile: 'openai-effort', defaultEffort: 'max' },
          },
        },
      ],
    });
    const config = { getResolvedModelConfig: registry.getModel.bind(registry) };
    expect(getModelReasoningConfig(config, route)?.profile).toBe(
      'dashscope-effort',
    );
    expect(
      getModelReasoningConfig(config, route, 'unregistered'),
    ).toBeUndefined();
    const second = registry.getModel(
      AuthType.USE_OPENAI,
      route.model,
      'https://second.example/v1',
    )!;
    expect(
      getModelReasoningConfig(config, {
        ...second.generationConfig,
        model: second.id,
        authType: second.authType,
        baseUrl: second.baseUrl,
      })?.profile,
    ).toBe('openai-effort');
  });
});
