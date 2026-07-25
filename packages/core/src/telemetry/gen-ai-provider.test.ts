/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveGenAiOperationName,
  resolveGenAiOutputType,
  resolveGenAiProviderName,
} from './gen-ai-provider.js';

describe('GenAI provider resolution', () => {
  it('always identifies Qwen OAuth as DashScope', () => {
    expect(
      resolveGenAiProviderName({
        authType: 'qwen-oauth',
        baseUrl: 'https://proxy.example.com/v1',
        apiKeyEnvKey: 'OPENAI_API_KEY',
      }),
    ).toBe('dashscope');
  });

  it.each([
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope'],
    ['https://DASHSCOPE-INTL.ALIYUNCS.COM/v1/', 'dashscope'],
    ['https://user:secret@cn-hongkong.dashscope.aliyuncs.com/v1', 'dashscope'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'dashscope'],
    [
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'dashscope',
    ],
    ['https://idealab.alibaba-inc.com/api/openai/v1', 'dashscope'],
    ['https://gateway.alibaba-inc.com/dashscope/v1', 'dashscope'],
    ['https://model-gateway.aliyun-inc.com/dashscope/v1', 'dashscope'],
    ['https://example.openai.azure.com/openai/v1', 'azure.ai.openai'],
    ['https://example.services.ai.azure.com/models/v1', 'azure.ai.openai'],
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://api.x.ai/v1', 'x_ai'],
    ['https://api.mistral.ai/v1', 'mistral_ai'],
    ['https://api.minimax.io/v1', 'minimax'],
    ['https://api.minimaxi.com/v1', 'minimax'],
    ['https://api.z.ai/api/paas/v4', 'z_ai'],
    ['https://open.bigmodel.cn/api/paas/v4', 'z_ai'],
    ['https://api-inference.modelscope.cn/v1', 'modelscope'],
    ['https://api.xiaomimimo.com/v1', 'mimo'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://router.requesty.ai/v1', 'requesty'],
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.anthropic.com/v1', 'anthropic'],
  ])('recognizes %s as %s', (baseUrl, expected) => {
    expect(resolveGenAiProviderName({ authType: 'openai', baseUrl })).toBe(
      expected,
    );
  });

  it('rejects forged hostname suffixes and falls back to the protocol', () => {
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://api.deepseek.com.attacker.example/v1',
      }),
    ).toBe('openai');
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://dashscope.aliyuncs.com.attacker.example/v1',
      }),
    ).toBe('openai');
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://gateway.alibaba-inc.com.attacker.example/v1',
      }),
    ).toBe('openai');
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://example.openai.azure.com.attacker.example/v1',
      }),
    ).toBe('openai');
  });

  it('uses a normalized exact DashScope proxy match without exposing its host', () => {
    expect(
      resolveGenAiProviderName(
        {
          authType: 'openai',
          baseUrl: 'https://private-proxy.example/v1/',
        },
        'https://private-proxy.example/v1',
      ),
    ).toBe('dashscope');
    expect(
      resolveGenAiProviderName(
        {
          authType: 'openai',
          baseUrl: 'https://other-proxy.example/v1',
        },
        'https://private-proxy.example/v1',
      ),
    ).toBe('openai');
  });

  it('prefers a recognized host over a conflicting environment hint', () => {
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnvKey: 'OPENROUTER_API_KEY',
      }),
    ).toBe('deepseek');
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['BAILIAN_CODING_PLAN_API_KEY', 'dashscope'],
    ['BAILIAN_TOKEN_PLAN_API_KEY', 'dashscope'],
    ['DASHSCOPE_API_KEY', 'dashscope'],
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['IDEALAB_API_KEY', 'dashscope'],
    ['XAI_API_KEY', 'x_ai'],
    ['MISTRAL_API_KEY', 'mistral_ai'],
    ['MINIMAX_API_KEY', 'minimax'],
    ['MIMO_API_KEY', 'mimo'],
    ['ZAI_API_KEY', 'z_ai'],
    ['MODELSCOPE_API_KEY', 'modelscope'],
    ['OPENAI_API_KEY', 'openai'],
    ['XIAOMI_MIMO_API_KEY', 'mimo'],
    ['OPENROUTER_API_KEY', 'openrouter'],
    ['REQUESTY_API_KEY', 'requesty'],
  ])('uses %s as a provider hint for an unknown endpoint', (key, expected) => {
    expect(
      resolveGenAiProviderName({
        authType: 'openai',
        baseUrl: 'https://proxy.example/v1',
        apiKeyEnvKey: key,
      }),
    ).toBe(expected);
  });

  it.each([
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['gemini', 'gcp.gemini'],
    ['vertex-ai', 'gcp.vertex_ai'],
  ] as const)(
    'falls back from invalid URLs by protocol: %s',
    (authType, name) => {
      expect(resolveGenAiProviderName({ authType, baseUrl: 'not a URL' })).toBe(
        name,
      );
    },
  );
});

describe('GenAI operation and output type resolution', () => {
  it.each([
    ['openai', 'chat'],
    ['anthropic', 'chat'],
    ['qwen-oauth', 'chat'],
    ['gemini', 'generate_content'],
    ['vertex-ai', 'generate_content'],
  ] as const)('maps %s to %s', (authType, operation) => {
    expect(resolveGenAiOperationName(authType)).toBe(operation);
  });

  it.each([
    ['application/json', 'json'],
    ['application/problem+json; charset=utf-8', 'json'],
    ['text/plain', 'text'],
    ['image/png', 'image'],
    ['audio/wav', 'speech'],
  ] as const)('maps explicit MIME %s to %s', (responseMimeType, outputType) => {
    expect(resolveGenAiOutputType('gemini', { responseMimeType })).toBe(
      outputType,
    );
  });

  it.each([
    ['TEXT', 'text'],
    ['IMAGE', 'image'],
    ['AUDIO', 'speech'],
  ] as const)('maps one response modality %s to %s', (modality, outputType) => {
    expect(
      resolveGenAiOutputType('vertex-ai', {
        responseMimeType: 'application/octet-stream',
        responseModalities: [modality],
      }),
    ).toBe(outputType);
  });

  it('omits ambiguous, video, unknown, and non-Google output types', () => {
    expect(
      resolveGenAiOutputType('gemini', {
        responseModalities: ['TEXT', 'IMAGE'],
      }),
    ).toBeUndefined();
    expect(
      resolveGenAiOutputType('gemini', { responseModalities: ['VIDEO'] }),
    ).toBeUndefined();
    expect(resolveGenAiOutputType('gemini', undefined)).toBeUndefined();
    expect(
      resolveGenAiOutputType('openai', {
        responseMimeType: 'application/json',
      }),
    ).toBeUndefined();
  });
});
