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
  usesMandatoryReasoningDefaultOnly,
} from './model-reasoning-config.js';

const OPENAI = AuthType.USE_OPENAI;
const STANDARD = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const TOKEN_PLAN =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const CODING_PLAN = 'https://coding.dashscope.aliyuncs.com/v1';

describe('resolveModelReasoningConfiguration', () => {
  it.each(
    ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].flatMap((modelId) =>
      [
        'https://api.moonshot.cn/v1',
        'https://api.moonshot.ai/v1',
        TOKEN_PLAN,
      ].map((baseUrl) => ({ modelId, baseUrl })),
    ),
  )(
    'uses only the mandatory provider default for $modelId on $baseUrl',
    ({ modelId, baseUrl }) => {
      expect(
        usesMandatoryReasoningDefaultOnly({
          modelId,
          authType: OPENAI,
          baseUrl,
          thinkingMandatory: true,
        }),
      ).toBe(true);
    },
  );

  it('keeps the tiered wire control for mandatory qwen3.8-max-preview', () => {
    expect(
      usesMandatoryReasoningDefaultOnly({
        modelId: 'qwen3.8-max-preview',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
        thinkingMandatory: true,
      }),
    ).toBe(false);
  });

  it.each([
    {},
    { authType: OPENAI, baseUrl: 'https://self-hosted.example/v1' },
    { authType: OPENAI, baseUrl: STANDARD },
  ])('keeps the Qwen manifest independent of provider route', (route) => {
    const expected = {
      thinking: true,
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    };
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'qwen3.8-max',
        ...route,
      }),
    ).toEqual(expected);
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'Qwen3.8-Max',
        ...route,
      }),
    ).toEqual(expected);
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'qwen3.8-max-preview',
        ...route,
      }),
    ).toBeUndefined();
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'does not read inherited registry entry %s',
    (modelId) => {
      expect(resolveModelReasoningConfiguration({ modelId })).toBeUndefined();
    },
  );

  it.each([
    ['DEEPSEEK-V4-PRO', 'https://api.deepseek.com', 'high'],
    ['Kimi-K3', 'https://api.moonshot.cn/v1', 'max'],
    ['GlM-5.2', 'https://api.z.ai/api/paas/v4', 'max'],
  ])(
    'normalizes the complete model ID %s',
    (modelId, baseUrl, defaultEffort) => {
      expect(
        resolveModelReasoningConfiguration({
          modelId,
          authType: OPENAI,
          baseUrl,
        }),
      ).toMatchObject({ thinking: true, defaultEffort });
    },
  );

  it.each([
    ['deepseek-v4-pro', ['high', 'max']],
    ['deepseek-v4-flash', ['high', 'max']],
  ])('registers direct DeepSeek controls for %s', (modelId, efforts) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toEqual({
      thinking: true,
      efforts,
      defaultEffort: 'high',
    });
  });

  it('uses the documented Alibaba DeepSeek tiers', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'deepseek-v4-flash-0731',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
      }),
    ).toEqual({
      thinking: true,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    });
  });

  it.each([
    {
      modelId: 'deepseek-v4-pro',
      baseUrl: TOKEN_PLAN,
      efforts: ['high', 'max'],
    },
    {
      modelId: 'deepseek-v4-flash',
      baseUrl: TOKEN_PLAN,
      efforts: ['high', 'max'],
    },
    {
      modelId: 'deepseek-v4-flash-0731',
      baseUrl: STANDARD,
      efforts: ['low', 'high', 'max'],
    },
    {
      modelId: 'deepseek-v4-pro',
      baseUrl: STANDARD,
      efforts: ['high', 'max'],
    },
    {
      modelId: 'deepseek-v4-flash',
      baseUrl: STANDARD,
      efforts: ['high', 'max'],
    },
  ])(
    'registers $modelId on its Alibaba route',
    ({ modelId, baseUrl, efforts }) => {
      expect(
        resolveModelReasoningConfiguration({
          modelId,
          authType: OPENAI,
          baseUrl,
        }),
      ).toEqual({ thinking: true, efforts, defaultEffort: 'high' });
    },
  );

  it('does not register DeepSeek on Coding Plan', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'deepseek-v4-pro',
        authType: OPENAI,
        baseUrl: CODING_PLAN,
      }),
    ).toBeUndefined();
  });

  it('separates direct and Alibaba GLM capabilities', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'GLM-5.2',
        authType: OPENAI,
        baseUrl: 'https://api.z.ai/api/paas/v4',
      }),
    ).toEqual({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'max',
    });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl: STANDARD,
      }),
    ).toEqual({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl:
          'https://workspace-id.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      }),
    ).toEqual({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl:
          'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toBeUndefined();
  });

  it('registers GLM 5.2 on an international standard endpoint', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      }),
    ).toEqual({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
  });

  it('does not register GLM 5.2 on Alibaba Coding Plan', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl: CODING_PLAN,
      }),
    ).toBeUndefined();
  });

  it.each([
    'cn-beijing',
    'ap-southeast-1',
    'eu-central-1',
    'us-east-1',
    'ap-northeast-1',
  ])('registers GLM 5.2 on the %s workspace endpoint', (region) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'glm-5.2',
        authType: OPENAI,
        baseUrl: `https://workspace-id.${region}.maas.aliyuncs.com/compatible-mode/v1`,
      }),
    ).toEqual({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
  });

  it.each([
    ['GLM-5.1', 'https://api.z.ai/api/paas/v4'],
    ['GLM-5', 'https://api.z.ai/api/paas/v4'],
    ['GLM-4.7', 'https://api.z.ai/api/paas/v4'],
    ['glm-5.1', STANDARD],
    ['glm-5', STANDARD],
    ['glm-4.7', STANDARD],
    ['glm-5.1', TOKEN_PLAN],
    ['glm-5', TOKEN_PLAN],
    ['glm-4.7', TOKEN_PLAN],
    ['glm-5.1', CODING_PLAN],
    ['glm-5', CODING_PLAN],
    ['glm-4.7', CODING_PLAN],
  ])('ignores out-of-scope GLM model %s on %s', (modelId, baseUrl) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId,
        authType: OPENAI,
        baseUrl,
      }),
    ).toBeUndefined();
  });

  it('registers Kimi hybrid switches and mandatory K3 efforts', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.6',
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.5',
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toBeUndefined();
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.5',
        authType: OPENAI,
        baseUrl: CODING_PLAN,
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.5',
        authType: OPENAI,
        baseUrl: 'https://coding-intl.dashscope-intl.aliyuncs.com/v1',
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k3',
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toEqual({
      thinking: true,
      canDisable: false,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
  });

  it('registers the same Kimi capabilities on the international Moonshot host', () => {
    // The built-in Kimi preset defaults to the international baseUrl, so the
    // first-party host gate must cover it exactly like the China host.
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.6',
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.ai/v1',
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k3',
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.ai/v1',
      }),
    ).toEqual({
      thinking: true,
      canDisable: false,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
  });

  it('keeps route-specific Kimi inclusions and exclusions', () => {
    for (const modelId of ['kimi-k2.5', 'kimi-k2.6', 'kimi-k3']) {
      expect(
        resolveModelReasoningConfiguration({
          modelId,
          authType: OPENAI,
          baseUrl: STANDARD,
        }),
      ).toBeUndefined();
    }
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.6',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.5',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
      }),
    ).toEqual({ thinking: true, toggleOnly: true });
    for (const baseUrl of [TOKEN_PLAN, CODING_PLAN]) {
      expect(
        resolveModelReasoningConfiguration({
          modelId: 'kimi-k3',
          authType: OPENAI,
          baseUrl,
        }),
      ).toBeUndefined();
    }
  });

  it('does not add controls for thinking-only K2.7', () => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'kimi-k2.7-code',
        authType: OPENAI,
        baseUrl: TOKEN_PLAN,
      }),
    ).toBeUndefined();
  });

  it.each([
    [AuthType.USE_ANTHROPIC, 'https://api.deepseek.com/anthropic'],
    [OPENAI, 'https://api.deepseek.com.evil.example/v1'],
    [OPENAI, 'https://api.moonshot.cn.evil.example/v1'],
    [OPENAI, 'https://self-hosted.example/v1'],
  ])('does not leak provider controls to %s %s', (authType, baseUrl) => {
    expect(
      resolveModelReasoningConfiguration({
        modelId: 'deepseek-v4-pro',
        authType,
        baseUrl,
      }),
    ).toBeUndefined();
  });

  it.each(['https://evilz.ai/v1', 'https://api.bigmodel.cn.evil.example/v1'])(
    'does not leak ZAI controls to the lookalike host %s',
    (baseUrl) => {
      expect(
        resolveModelReasoningConfiguration({
          modelId: 'glm-5.2',
          authType: OPENAI,
          baseUrl,
        }),
      ).toBeUndefined();
    },
  );
});

describe('classifyModelReasoningEndpoint', () => {
  it.each([
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.moonshot.cn/v1', 'moonshot'],
    ['https://api.moonshot.ai/v1', 'moonshot'],
    ['https://api.z.ai/api/paas/v4', 'zai'],
    ['https://z.ai/api/paas/v4', 'zai'],
    ['https://custom.bigmodel.cn/api/paas/v4', 'zai'],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'zai'],
    [STANDARD, 'alibaba-standard'],
    [
      'https://workspace-id.cn-beijing.maas.aliyuncs.com/v1',
      'alibaba-standard',
    ],
    [TOKEN_PLAN, 'alibaba-token-plan'],
    [CODING_PLAN, 'alibaba-coding-plan'],
    ['https://coding-intl.dashscope.aliyuncs.com/v1', 'alibaba-coding-plan'],
    [
      'https://coding-intl.dashscope-intl.aliyuncs.com/v1',
      'alibaba-coding-plan',
    ],
    [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'alibaba-standard',
    ],
    [
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      'alibaba-standard',
    ],
    ['not a url', 'unknown'],
    ['http://', 'unknown'],
  ])('classifies %s as %s', (baseUrl, family) => {
    expect(classifyModelReasoningEndpoint({ authType: OPENAI, baseUrl })).toBe(
      family,
    );
  });
});

describe('normalizeModelReasoningEffort', () => {
  it('canonicalizes compatibility aliases for high/max models', () => {
    const configuration = resolveModelReasoningConfiguration({
      modelId: 'deepseek-v4-pro',
      authType: OPENAI,
      baseUrl: 'https://api.deepseek.com',
    })!;
    expect(normalizeModelReasoningEffort(configuration, 'medium')).toBe('high');
    expect(normalizeModelReasoningEffort(configuration, 'xhigh')).toBe('max');
    expect(normalizeModelReasoningEffort(configuration, 'high')).toBe('high');
    expect(normalizeModelReasoningEffort(configuration, 'max')).toBe('max');
  });

  it('drops toggle-only efforts and clamps tiered models', () => {
    const toggle = resolveModelReasoningConfiguration({
      modelId: 'kimi-k2.6',
      authType: OPENAI,
      baseUrl: 'https://api.moonshot.cn/v1',
    })!;
    const kimiK3 = resolveModelReasoningConfiguration({
      modelId: 'kimi-k3',
      authType: OPENAI,
      baseUrl: 'https://api.moonshot.cn/v1',
    })!;
    expect(normalizeModelReasoningEffort(toggle, 'high')).toBeUndefined();
    expect(normalizeModelReasoningEffort(kimiK3, 'low')).toBe('low');
    expect(normalizeModelReasoningEffort(kimiK3, 'medium')).toBe('high');
    expect(normalizeModelReasoningEffort(kimiK3, 'max')).toBe('max');
  });
});
