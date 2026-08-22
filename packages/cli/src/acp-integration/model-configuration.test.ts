/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { getModelConfiguration } from './model-configuration.js';

const OPENAI = AuthType.USE_OPENAI;

describe('model configuration manifest', () => {
  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration('qwen3.8-max')).toEqual({
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
      },
    });
    expect(getModelConfiguration('Qwen3.8-Max')).toEqual(
      getModelConfiguration('qwen3.8-max'),
    );
  });

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

  it('registers provider-aware DeepSeek, GLM, and Kimi controls', () => {
    expect(
      getModelConfiguration('deepseek-v4-pro', {
        authType: OPENAI,
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toEqual({
      reasoning: {
        thinking: true,
        efforts: ['high', 'max'],
        defaultEffort: 'high',
      },
    });
    expect(
      getModelConfiguration('glm-5.2', {
        authType: OPENAI,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      }),
    ).toEqual({
      reasoning: { thinking: true, toggleOnly: true },
    });
    expect(
      getModelConfiguration('kimi-k3', {
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toEqual({
      reasoning: {
        thinking: true,
        canDisable: false,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      },
    });
    expect(
      getModelConfiguration('Kimi-K3', {
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    ).toEqual(
      getModelConfiguration('kimi-k3', {
        authType: OPENAI,
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
    );
  });

  it('requires a supported OpenAI endpoint for non-Qwen controls', () => {
    expect(getModelConfiguration('deepseek-v4-pro')).toBeUndefined();
    expect(
      getModelConfiguration('deepseek-v4-pro', {
        authType: AuthType.USE_ANTHROPIC,
        baseUrl: 'https://api.deepseek.com/anthropic',
      }),
    ).toBeUndefined();
    expect(
      getModelConfiguration('deepseek-v4-pro', {
        authType: OPENAI,
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      }),
    ).toBeUndefined();
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
    expect(getModelConfiguration(modelId)).toBeUndefined();
  });
});
