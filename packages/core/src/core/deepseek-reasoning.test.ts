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
  isDeepSeekEstablishedHost,
  normalizeDeepSeekReasoningEffort,
} from './deepseek-reasoning.js';
import { getEffectiveReasoning } from './reasoning-overrides.js';
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
    ['https://model-proxy.alibaba-inc.com/v1', 'enable_thinking'],
    ['https://model-proxy.aliyun-inc.com/v1', 'enable_thinking'],
    ['https://model-proxy.alicloudapi.com/v1', 'enable_thinking'],
    [
      'https://gateway.cn-shanghai.pai-eas.aliyuncs.com/api/predict/demo/v1',
      'enable_thinking',
    ],
    ['https://my-vllm.example.com:8000/v1', 'enable_thinking'],
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

  it.each([undefined, 'invalid-url'])(
    'does not infer a wire contract without a parseable baseUrl (%s)',
    (baseUrl) => {
      expect(
        getBuiltinDeepSeekReasoning({ ...config, baseUrl }),
      ).toBeUndefined();
    },
  );

  it.each([
    'https://api.deepseek.com.evil.example/v1',
    'https://maas.aliyuncs.com.evil.example/v1',
    'https://notmaas.aliyuncs.com/v1',
    'https://vllm.example.com/v1',
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://coding-intl.dashscope.aliyuncs.com/v1',
    'https://unknown.dashscope.aliyuncs.com/compatible-mode/v1',
    'https://model-proxy.alibaba-inc.com.evil.example/v1',
    'https://model-proxy.aliyun-inc.com.evil.example/v1',
    'https://model-proxy.alicloudapi.com.evil.example/v1',
    'https://notalibaba-inc.com/v1',
    'https://evil.example/model-proxy.alibaba-inc.com/v1',
  ])('does not infer a host-gated contract on %s', (baseUrl) => {
    expect(
      getBuiltinDeepSeekReasoning({
        ...config,
        model: 'deepseek-flash',
        baseUrl,
      }),
    ).toBeUndefined();
  });

  it('does not grant the official contract to lookalike DeepSeek hostnames', () => {
    expect(
      getBuiltinDeepSeekReasoning({
        ...config,
        baseUrl: 'https://api.deepseek.com.evil.example/v1',
      }),
    ).toMatchObject({ disableField: 'enable_thinking' });
  });

  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash'])(
    'recognizes Flash alias %s',
    (model) => {
      expect(getBuiltinDeepSeekReasoning({ ...config, model })).toBeDefined();
    },
  );

  it.each([
    ['deepseek-v4.1-flash', true],
    ['deepseek-v4.1-flash-1017', true],
    ['DEEPSEEK-V4.1-FLASH', true],
    ['DeepSeek-V4-Pro', true],
    ['deepseek-v4-pro', true],
    ['deepseek-v4-pro-0813', true],
    ['deepseek-v4-flash', true],
    ['deepseek-v4-flash-0731', true],
    ['deepseek-v4.1-flash-custom', true],
    ['deepseek-flash', false],
    ['deepseek-r1', false],
    ['company-deepseek-v4.1-flash', false],
  ])(
    'limits third-party inference to the DeepSeek-V4 prefix: %s',
    (model, supported) => {
      expect(
        getBuiltinDeepSeekReasoning({
          ...config,
          model,
          baseUrl: 'https://gateway.example.com/v1',
        }) !== undefined,
      ).toBe(supported);
    },
  );

  it('recognizes the retired vision alias on every endpoint', () => {
    const model = 'deepseek-v4-flash-vision-exp';
    expect(getBuiltinDeepSeekReasoning({ ...config, model })).toMatchObject({
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      disableField: 'thinking',
    });
    expect(
      getBuiltinDeepSeekReasoning({ ...config, model, baseUrl: maas }),
    ).toMatchObject({ disableField: 'enable_thinking' });
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
    ['https://gateway.example.com/v1', 'DeepSeek-V4-Pro', ['high', 'max']],
    [
      'https://gateway.example.com/v1',
      'deepseek-v4.1-flash-1017',
      ['low', 'high', 'max'],
    ],
    [
      'https://gateway.example.com/v1',
      'deepseek-v4-pro-0813',
      ['low', 'high', 'max'],
    ],
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
    [
      'https://gateway.example.com/v1',
      'deepseek-v4.1-flash-custom',
      'xhigh',
      'high',
    ],
    ['https://gateway.example.com/v1', 'DeepSeek-V4-Pro', 'low', 'high'],
    [
      'https://gateway.example.com/v1',
      'deepseek-v4.1-flash-1017',
      'xhigh',
      'high',
    ],
    [official, 'deepseek-reasoner', 'low', 'high'],
    [official, 'deepseek-reasoner', 'xhigh', 'max'],
    [official, 'deepseek-flash', 'medium', 'high'],
    [official, 'deepseek-flash', 'max', 'max'],
  ])('maps %s / %s / %s to %s', (baseUrl, model, effort, expected) => {
    expect(normalizeDeepSeekReasoningEffort(effort, model, baseUrl)).toBe(
      expected,
    );
  });

  it('normalizes gateway Flash aliases identically to the stable Flash id', () => {
    const gateway = 'https://gateway.example.com/v1';
    for (const model of [
      'deepseek-v4.1-flash-1017',
      'deepseek-v4.1-flash-custom',
      'DEEPSEEK-V4.1-FLASH-ALIAS',
    ]) {
      expect(normalizeDeepSeekReasoningEffort('xhigh', model, gateway)).toBe(
        'high',
      );
      const generation: ContentGeneratorConfig = {
        model,
        authType: AuthType.USE_OPENAI,
        baseUrl: gateway,
        reasoning: { effort: 'xhigh' },
      };
      expect(
        getEffectiveReasoning(
          generation,
          getBuiltinDeepSeekReasoning(generation),
        ),
      ).toEqual({ effort: 'high' });
      expect(
        applyDeepSeekReasoningEffort(
          { model, reasoning: { effort: 'xhigh' } },
          gateway,
        ),
      ).toEqual({ model, reasoning_effort: 'high' });
    }
    expect(
      normalizeDeepSeekReasoningEffort('xhigh', 'deepseek-v4-flash', gateway),
    ).toBe('max');
    expect(
      normalizeDeepSeekReasoningEffort('xhigh', 'deepseek-v4-pro', gateway),
    ).toBe('max');
  });

  it('limits the established-route exemption to pre-PR model/host pairs', () => {
    expect(isDeepSeekEstablishedHost(maas, 'deepseek-v4.1-flash-1017')).toBe(
      true,
    );
    expect(isDeepSeekEstablishedHost(maas, 'DEEPSEEK-V4.1-FLASH-1017')).toBe(
      true,
    );
    expect(isDeepSeekEstablishedHost(maas, 'deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekEstablishedHost(maas, 'deepseek-v4.1-flash-custom')).toBe(
      false,
    );
    expect(
      isDeepSeekEstablishedHost(official, 'deepseek-v4.1-flash-custom'),
    ).toBe(false);
    expect(
      isDeepSeekEstablishedHost(official, 'deepseek-v4-flash-vision-exp'),
    ).toBe(true);
    expect(
      isDeepSeekEstablishedHost(maas, 'deepseek-v4-flash-vision-exp'),
    ).toBe(false);
    expect(
      isDeepSeekEstablishedHost(
        'https://model-proxy.alibaba-inc.com/v1',
        'deepseek-v4.1-flash-1017',
      ),
    ).toBe(true);
    expect(
      isDeepSeekEstablishedHost(
        'https://model-proxy.alibaba-inc.com/v1',
        'deepseek-v4.1-flash-custom',
      ),
    ).toBe(false);
    expect(
      isDeepSeekEstablishedHost(
        'https://gateway.example.com/v1',
        'deepseek-v4.1-flash-1017',
      ),
    ).toBe(false);
  });

  it('stands the state normalizer down for a declared third-party route', () => {
    const declaration = {
      thinking: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      disableField: 'reasoning_effort',
    } as const;
    const gatewayGeneration: ContentGeneratorConfig = {
      model: 'deepseek-v4-pro',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://gateway.example.com/v1',
    };
    expect(
      getDeepSeekReasoningState(gatewayGeneration, declaration),
    ).toBeUndefined();
    expect(
      getDeepSeekReasoningState(gatewayGeneration, {
        ...declaration,
        profile: 'deepseek-openai',
      }),
    ).toBeDefined();
    expect(
      getDeepSeekReasoningState(
        { ...gatewayGeneration, baseUrl: maas },
        declaration,
      ),
    ).toBeDefined();
    expect(
      getDeepSeekReasoningState(
        { ...gatewayGeneration, baseUrl: official },
        declaration,
      ),
    ).toMatchObject({ enabled: true, effort: 'medium' });
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
    expect(
      applyDeepSeekReasoningEffort(
        { model: config.model, reasoning: { effort: 'max' } },
        'https://proxy.example/v1',
      ),
    ).toEqual({ model: config.model, reasoning_effort: 'max' });
    const legacy = { model: 'deepseek-flash', reasoning: { effort: 'max' } };
    expect(
      applyDeepSeekReasoningEffort(legacy, 'https://proxy.example/v1'),
    ).toBe(legacy);
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
