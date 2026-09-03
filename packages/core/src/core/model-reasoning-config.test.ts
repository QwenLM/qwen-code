/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from './contentGenerator.js';
import {
  classifyModelReasoningEndpoint,
  normalizeModelReasoningEffort,
  resolveModelReasoningConfiguration,
  supportsGenericReasoningEffort,
  usesMandatoryReasoningDefaultOnly,
  type ModelReasoningConfigInput,
} from './model-reasoning-config.js';

const OPENAI = AuthType.USE_OPENAI;
const STANDARD =
  'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const TOKEN_PLAN =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

describe('classifyModelReasoningEndpoint', () => {
  it.each([
    [{ authType: AuthType.QWEN_OAUTH }, 'qwen-oauth'],
    [{ authType: OPENAI, baseUrl: 'https://api.deepseek.com' }, 'deepseek'],
    [{ authType: OPENAI, baseUrl: 'https://api.moonshot.ai/v1' }, 'moonshot'],
    [{ authType: OPENAI, baseUrl: 'https://api.moonshot.cn/v1' }, 'moonshot'],
    [{ authType: OPENAI, baseUrl: 'https://api.z.ai/api/paas/v4' }, 'zai'],
    [
      { authType: OPENAI, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      'zai',
    ],
    [
      {
        authType: OPENAI,
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      },
      'alibaba-coding-plan',
    ],
    [
      {
        authType: OPENAI,
        baseUrl: 'https://coding-intl.dashscope-intl.aliyuncs.com/v1',
      },
      'alibaba-coding-plan',
    ],
    [{ authType: OPENAI, baseUrl: TOKEN_PLAN }, 'alibaba-token-plan'],
    [
      {
        authType: OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl:
          'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl:
          'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl:
          'https://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl:
          'https://workspace.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
    [
      {
        authType: OPENAI,
        baseUrl:
          'https://workspace.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      'alibaba-standard',
    ],
  ] satisfies Array<
    [
      Pick<ModelReasoningConfigInput, 'authType' | 'baseUrl'>,
      ReturnType<typeof classifyModelReasoningEndpoint>,
    ]
  >)('classifies %j as %s', (input, expected) => {
    expect(classifyModelReasoningEndpoint(input)).toBe(expected);
  });

  it.each([
    {},
    { authType: AuthType.USE_ANTHROPIC, baseUrl: STANDARD },
    { authType: OPENAI, baseUrl: 'not a URL' },
    { authType: OPENAI, baseUrl: 'https://api.deepseek.com.evil.test/v1' },
    { authType: OPENAI, baseUrl: 'https://moonshot.example/v1' },
    { authType: OPENAI, baseUrl: 'https://llm.example/v1' },
  ])('classifies an unsupported route as unknown: %j', (input) => {
    expect(classifyModelReasoningEndpoint(input)).toBe('unknown');
  });

  it('uses the built-in DashScope default when OpenAI has no base URL', () => {
    expect(classifyModelReasoningEndpoint({ authType: OPENAI })).toBe(
      'alibaba-standard',
    );
  });
});

describe('resolveModelReasoningConfiguration', () => {
  it.each([
    ['qwen3.5-plus', true, undefined, undefined],
    ['qwen3.6-plus', true, undefined, undefined],
    ['qwen3.6-flash', true, undefined, undefined],
    ['qwen3.7-plus', true, undefined, undefined],
    ['qwen3.7-max', true, undefined, undefined],
    ['qwen3.8-max', false, ['low', 'medium', 'xhigh'], 'xhigh'],
    ['qwen3.8-max-0902', false, ['low', 'medium', 'xhigh'], 'xhigh'],
    ['qwen3.8-flash', false, ['low', 'medium', 'xhigh'], 'xhigh'],
  ])(
    'resolves Qwen model %s',
    (modelId, toggleOnly, efforts, defaultEffort) => {
      const resolved = resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl: STANDARD,
      });
      expect(resolved).toMatchObject({
        thinking: true,
        toggleOnly,
        endpointFamily: 'alibaba-standard',
        wireShape: toggleOnly ? 'qwen-toggle' : 'qwen-effort',
      });
      if (!toggleOnly) {
        expect(resolved).toMatchObject({ efforts, defaultEffort });
      }
    },
  );

  it.each([
    [
      'deepseek-v4-pro',
      'https://api.deepseek.com',
      ['high', 'max'],
      'high',
      'thinking-effort',
    ],
    ['deepseek-v4-flash', STANDARD, ['high', 'max'], 'high', 'alibaba-effort'],
    [
      'deepseek-v4-pro-0813',
      TOKEN_PLAN,
      ['low', 'high', 'max'],
      'high',
      'alibaba-effort',
    ],
    [
      'deepseek-v4-flash-0731',
      STANDARD,
      ['low', 'high', 'max'],
      'high',
      'alibaba-effort',
    ],
    [
      'GLM-5.2',
      'https://api.z.ai/api/paas/v4',
      ['high', 'max'],
      'max',
      'thinking-effort',
    ],
    ['glm-5.2', STANDARD, ['high', 'max'], 'high', 'alibaba-effort'],
    [
      'kimi-k3',
      'https://api.moonshot.ai/v1',
      ['low', 'high', 'max'],
      'max',
      'thinking-effort',
    ],
    [
      'ZHIPU/GLM-5.3',
      STANDARD,
      ['low', 'high', 'max'],
      'max',
      'alibaba-effort',
    ],
    [
      'ZHIPU/GLM-5.3-Flash',
      STANDARD,
      ['low', 'high', 'max'],
      'max',
      'alibaba-effort',
    ],
  ])(
    'resolves tiered model %s on %s',
    (modelId, baseUrl, efforts, defaultEffort, wireShape) => {
      expect(
        resolveModelReasoningConfiguration({
          modelId,
          authType: OPENAI,
          baseUrl,
        }),
      ).toMatchObject({
        thinking: true,
        efforts,
        defaultEffort,
        wireShape,
      });
    },
  );

  it.each([
    ['kimi-k2.6', 'https://api.moonshot.cn/v1', 'thinking-toggle'],
    ['kimi-k2.5', TOKEN_PLAN, 'alibaba-toggle'],
    ['kimi-k2.6', TOKEN_PLAN, 'alibaba-toggle'],
    ['glm-5.2', TOKEN_PLAN, 'alibaba-toggle'],
    ['kimi-k2.5', 'https://coding.dashscope.aliyuncs.com/v1', 'alibaba-toggle'],
  ])('resolves toggle-only model %s on %s', (modelId, baseUrl, wireShape) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl,
      }),
    ).toMatchObject({ thinking: true, toggleOnly: true, wireShape });
  });

  it.each([
    ['kimi-k3', 'https://api.moonshot.ai/v1'],
    ['kimi-k3', STANDARD],
    ['ZHIPU/GLM-5.3', STANDARD],
    ['ZHIPU/GLM-5.3-Flash', STANDARD],
  ])('marks %s on %s as mandatory', (modelId, baseUrl) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl,
      }),
    ).toMatchObject({ canDisable: false });
  });

  it('matches model IDs case-insensitively', () => {
    const configuration = resolveModelReasoningConfiguration({
      modelId: 'QWEN3.8-MAX-0902',
      authType: OPENAI,
      baseUrl: STANDARD,
    });
    expect(configuration?.toggleOnly).toBe(false);
    expect(
      configuration && !configuration.toggleOnly
        ? configuration.defaultEffort
        : undefined,
    ).toBe('xhigh');
  });

  it.each([
    [
      {
        modelId: 'qwen3.7-plus',
        authType: AuthType.QWEN_OAUTH,
      },
      'qwen-toggle',
    ],
    [
      {
        modelId: 'qwen3.8-flash',
        authType: AuthType.QWEN_OAUTH,
      },
      'qwen-effort',
    ],
    [
      {
        modelId: 'qwen3.8-flash',
        authType: OPENAI,
        baseUrl:
          'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      'qwen-effort',
    ],
    [
      {
        modelId: 'qwen3.7-plus',
        authType: OPENAI,
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      },
      'qwen-toggle',
    ],
  ] satisfies Array<
    [ModelReasoningConfigInput, 'qwen-effort' | 'qwen-toggle']
  >)('resolves Qwen across the supported route %j', (input, wireShape) => {
    expect(resolveModelReasoningConfiguration(input)).toMatchObject({
      wireShape,
    });
  });

  it('does not add Qwen 3.8 to Alibaba Coding Plan', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'qwen3.8-flash',
        authType: OPENAI,
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      }),
    ).toBeUndefined();
  });

  it.each([
    ['qwen3.8-max-preview', STANDARD],
    ['qwen3.8-max-latest', STANDARD],
    ['qwen3.8-max-0902-extra', STANDARD],
    ['vendor/qwen3.8-max', STANDARD],
    ['deepseek-v4-pro-0813-extra', STANDARD],
    ['ZHIPU/GLM-5.3', 'https://api.z.ai/api/paas/v4'],
    ['GLM-5.3', 'https://api.z.ai/api/paas/v4'],
    ['kimi/kimi-k3', STANDARD],
    ['deepseek-v4-pro', 'https://llm.example/v1'],
  ])('does not infer unsupported model %s on %s', (modelId, baseUrl) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl,
      }),
    ).toBeUndefined();
  });

  it('keeps same-name models route-specific', () => {
    const standard = resolveModelReasoningConfiguration({
      modelId: 'glm-5.2',
      authType: OPENAI,
      baseUrl: STANDARD,
    });
    const tokenPlan = resolveModelReasoningConfiguration({
      modelId: 'glm-5.2',
      authType: OPENAI,
      baseUrl: TOKEN_PLAN,
    });
    const zai = resolveModelReasoningConfiguration({
      modelId: 'glm-5.2',
      authType: OPENAI,
      baseUrl: 'https://api.z.ai/api/paas/v4',
    });

    expect(standard).toMatchObject({
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
    expect(tokenPlan).toMatchObject({ toggleOnly: true });
    expect(zai).toMatchObject({
      efforts: ['high', 'max'],
      defaultEffort: 'max',
    });
  });
});

describe('normalizeModelReasoningEffort', () => {
  const qwen = resolveModelReasoningConfiguration({
    modelId: 'qwen3.8-max',
    authType: OPENAI,
    baseUrl: STANDARD,
  })!;

  it('keeps only a native tier and otherwise uses the provider default', () => {
    expect(normalizeModelReasoningEffort(qwen, 'medium')).toBe('medium');
    expect(normalizeModelReasoningEffort(qwen, 'high')).toBeUndefined();
    expect(normalizeModelReasoningEffort(qwen, 'max')).toBeUndefined();
  });
});

describe('usesMandatoryReasoningDefaultOnly', () => {
  it('distinguishes a preset-only mandatory model from a tiered one', () => {
    expect(
      usesMandatoryReasoningDefaultOnly({
        modelId: 'kimi-k2.7-code',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
        thinkingMandatory: true,
      }),
    ).toBe(true);
    expect(
      usesMandatoryReasoningDefaultOnly({
        modelId: 'kimi-k3',
        authType: OPENAI,
        baseUrl: STANDARD,
        thinkingMandatory: true,
      }),
    ).toBe(false);
  });
});

describe('supportsGenericReasoningEffort', () => {
  it('keeps generic providers without inferring Qwen aliases', () => {
    expect(supportsGenericReasoningEffort('claude-opus-4-6')).toBe(true);
    expect(supportsGenericReasoningEffort('qwen3.8-max-preview')).toBe(false);
    expect(supportsGenericReasoningEffort('coder-model')).toBe(false);
  });
});
