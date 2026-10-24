/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import {
  applyDeepSeekReasoningEffort,
  getBuiltinDeepSeekReasoning,
  getDeepSeekReasoningState,
  normalizeDeepSeekReasoningEffort,
} from './deepseek-reasoning.js';
import { AuthType } from '../utils/auth-type.js';

const official = 'https://api.deepseek.com/v1';
const maas =
  'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const config: ContentGeneratorConfig = {
  model: 'deepseek-v4.1-flash-1017',
  authType: AuthType.USE_OPENAI,
  baseUrl: official,
};

describe('built-in DeepSeek reasoning', () => {
  it.each([
    [official, 'thinking'],
    ['https://us.api.deepseek.com/v1', 'thinking'],
    [maas, 'enable_thinking'],
    [
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'enable_thinking',
    ],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'enable_thinking'],
    [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'enable_thinking',
    ],
    ['https://dashscope-us.aliyuncs.com/compatible-mode/v1', 'enable_thinking'],
    [
      'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      'enable_thinking',
    ],
  ])('uses the Flash contract on %s', (baseUrl, disableField) => {
    expect(getBuiltinDeepSeekReasoning({ ...config, baseUrl })).toEqual({
      profile: 'deepseek-openai',
      thinking: true,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      disableField,
    });
  });

  it.each([
    undefined,
    'invalid-url',
    'https://api.deepseek.com.evil.example/v1',
    'https://maas.aliyuncs.com.evil.example/v1',
    'https://notmaas.aliyuncs.com/v1',
    'https://vllm.example.com/v1',
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://coding-intl.dashscope.aliyuncs.com/v1',
    'https://unknown.dashscope.aliyuncs.com/compatible-mode/v1',
  ])('does not infer a wire contract for %s', (baseUrl) => {
    expect(getBuiltinDeepSeekReasoning({ ...config, baseUrl })).toBeUndefined();
  });

  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash'])(
    'recognizes Flash alias %s',
    (model) => {
      expect(getBuiltinDeepSeekReasoning({ ...config, model })).toBeDefined();
    },
  );

  it('recognizes the retired vision alias only on the official endpoint', () => {
    const model = 'deepseek-v4-flash-vision-exp';
    expect(getBuiltinDeepSeekReasoning({ ...config, model })).toMatchObject({
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      disableField: 'thinking',
    });
    expect(
      getBuiltinDeepSeekReasoning({ ...config, model, baseUrl: maas }),
    ).toBeUndefined();
  });

  it.each(['deepseek-r1', 'company-deepseek-v4.1-flash', 'qwen3.8-max'])(
    'does not infer a contract for unknown model %s',
    (model) => {
      expect(getBuiltinDeepSeekReasoning({ ...config, model })).toBeUndefined();
    },
  );

  it('requires the OpenAI protocol and carries mandatory thinking', () => {
    expect(
      getBuiltinDeepSeekReasoning({
        ...config,
        authType: AuthType.USE_ANTHROPIC,
      }),
    ).toBeUndefined();
    expect(
      getBuiltinDeepSeekReasoning({ ...config, thinkingMandatory: true }),
    ).toMatchObject({ canDisable: false });
  });

  it.each([
    [official, 'deepseek-v4-pro', ['low', 'high', 'max']],
    [maas, 'deepseek-v4-pro', ['high', 'max']],
    [maas, 'deepseek-v4-flash', ['high', 'max']],
    [maas, 'deepseek-v4-pro-0813', ['low', 'high', 'max']],
    [maas, 'deepseek-v4-flash-0731', ['low', 'high', 'max']],
  ])('recognizes the distinct tiers on %s / %s', (baseUrl, model, efforts) => {
    expect(
      getBuiltinDeepSeekReasoning({ ...config, baseUrl, model }),
    ).toMatchObject({
      efforts,
    });
  });

  it.each([
    [official, 'deepseek-flash', 'low', 'low'],
    [official, 'deepseek-v4-pro', 'xhigh', 'high'],
    [official, 'deepseek-v4-flash-vision-exp', 'low', 'low'],
    [official, 'deepseek-v4-flash-vision-exp', 'xhigh', 'high'],
    [maas, 'deepseek-v4.1-flash-1017', 'xhigh', 'high'],
    [maas, 'deepseek-v4-pro', 'low', 'high'],
    [maas, 'deepseek-v4-pro', 'xhigh', 'max'],
    [maas, 'deepseek-v4-flash', 'low', 'high'],
    [maas, 'deepseek-v4-flash', 'xhigh', 'max'],
    [maas, 'deepseek-v4-pro-0813', 'low', 'low'],
    [maas, 'deepseek-v4-pro-0813', 'xhigh', 'max'],
    [maas, 'deepseek-v4-flash-0731', 'xhigh', 'max'],
    [official, 'deepseek-reasoner', 'low', 'high'],
    [official, 'deepseek-reasoner', 'xhigh', 'max'],
    [official, 'deepseek-flash', 'medium', 'high'],
    [official, 'deepseek-flash', 'max', 'max'],
  ])('maps %s / %s / %s to %s', (baseUrl, model, effort, expected) => {
    expect(normalizeDeepSeekReasoningEffort(effort, model, baseUrl)).toBe(
      expected,
    );
  });

  it('flattens static nested effort while preserving flat overrides and siblings', () => {
    expect(
      applyDeepSeekReasoningEffort(
        {
          model: config.model,
          reasoning_effort: 'low',
          reasoning: { effort: 'max', budget_tokens: 1234 },
        },
        maas,
      ),
    ).toEqual({
      model: config.model,
      reasoning_effort: 'low',
      reasoning: { budget_tokens: 1234 },
    });
    const request = { model: config.model, reasoning: { effort: 'max' } };
    expect(
      applyDeepSeekReasoningEffort(request, 'https://proxy.example/v1'),
    ).toBe(request);
  });
});

describe('DeepSeek effective reasoning state', () => {
  it.each<{
    settings: Partial<ContentGeneratorConfig>;
    expected: { enabled: boolean; effort?: string };
  }>([
    { settings: {}, expected: { enabled: true, effort: undefined } },
    {
      settings: { reasoning: { effort: 'low' } },
      expected: { enabled: true, effort: 'low' },
    },
    {
      settings: { extra_body: { reasoning: { effort: 'max' } } },
      expected: { enabled: true, effort: 'max' },
    },
    {
      settings: { reasoning: false },
      expected: { enabled: false, effort: undefined },
    },
  ])(
    'does not synthesize a legacy default for $settings',
    ({ settings, expected }) => {
      expect(
        getDeepSeekReasoningState(
          { ...config, ...settings },
          {
            thinking: true,
            efforts: ['low', 'max'],
            disableField: 'thinking',
          },
        ),
      ).toEqual(expected);
    },
  );

  it.each<{
    settings: Partial<ContentGeneratorConfig>;
    expected: { enabled: boolean; effort: string };
  }>([
    { settings: {}, expected: { enabled: true, effort: 'high' } },
    {
      settings: {
        reasoning: { effort: 'low' },
        samplingParams: { max_tokens: 64 },
      },
      expected: { enabled: true, effort: 'low' },
    },
    {
      settings: { reasoning: { effort: 'xhigh' } },
      expected: { enabled: true, effort: 'high' },
    },
    {
      settings: {
        reasoning: { effort: 'low' },
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: 'max' },
      },
      expected: { enabled: true, effort: 'max' },
    },
    {
      settings: {
        reasoning: { effort: 'low' },
        extra_body: { reasoning: { effort: 'max' } },
      },
      expected: { enabled: true, effort: 'max' },
    },
    {
      settings: {
        samplingParams: { reasoning_effort: 'low' },
        extra_body: { reasoning: { effort: 'max' } },
      },
      expected: { enabled: true, effort: 'low' },
    },
    {
      settings: { reasoning: false, extra_body: { reasoning_effort: 'max' } },
      expected: { enabled: false, effort: 'high' },
    },
    {
      settings: { extra_body: { thinking: { type: 'disabled' } } },
      expected: { enabled: false, effort: 'high' },
    },
    {
      settings: { extra_body: { reasoning_effort: 'none' } },
      expected: { enabled: false, effort: 'high' },
    },
    {
      settings: { baseUrl: maas, extra_body: { enable_thinking: false } },
      expected: { enabled: false, effort: 'high' },
    },
    {
      settings: { reasoning: false, thinkingMandatory: true },
      expected: { enabled: true, effort: 'high' },
    },
  ])('resolves $settings to $expected', ({ settings, expected }) => {
    const generation = { ...config, ...settings };
    expect(
      getDeepSeekReasoningState(
        generation,
        getBuiltinDeepSeekReasoning(generation),
      ),
    ).toEqual(expected);
  });

  it('respects an explicit profile and its own tiers and default', () => {
    const capability = {
      profile: 'deepseek-openai' as const,
      thinking: true as const,
      efforts: ['medium', 'max'] as const,
      defaultEffort: 'medium' as const,
      disableField: 'thinking' as const,
    };
    expect(getDeepSeekReasoningState(config, capability)).toEqual({
      enabled: true,
      effort: 'medium',
    });
    expect(
      getDeepSeekReasoningState(config, {
        ...capability,
        profile: 'openai-effort',
      }),
    ).toBeUndefined();
    expect(
      getDeepSeekReasoningState(config, { ...capability, profile: undefined }),
    ).toEqual({ enabled: true, effort: 'medium' });
    expect(getDeepSeekReasoningState(config, undefined)).toBeUndefined();
  });
});
