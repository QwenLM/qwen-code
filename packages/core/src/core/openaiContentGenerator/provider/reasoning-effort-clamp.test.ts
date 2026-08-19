/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { DashScopeOpenAICompatibleProvider } from './dashscope.js';
import { DeepSeekOpenAICompatibleProvider } from './deepseek.js';
import { ZaiOpenAICompatibleProvider } from './zai.js';

const cliConfig = {} as Config;

function request(
  effort: string,
): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 128,
    reasoning: { effort, budget_tokens: 1024 },
  } as unknown as OpenAI.Chat.ChatCompletionCreateParams;
}

function reasoningOf(
  value: OpenAI.Chat.ChatCompletionCreateParams,
): Record<string, unknown> | undefined {
  return (value as unknown as Record<string, unknown>)['reasoning'] as
    | Record<string, unknown>
    | undefined;
}

class ProviderUsingInheritedOutputLimit extends DefaultOpenAICompatibleProvider {
  override buildRequest(
    value: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    return this.applyOutputTokenLimit(value);
  }
}

class MaxCapableProvider extends DefaultOpenAICompatibleProvider {
  protected override supportsMaxReasoningEffort(): boolean {
    return true;
  }
}

describe('OpenAI-compatible reasoning effort clamp', () => {
  it('clamps max to xhigh for a generic compatible provider', () => {
    const provider = new DefaultOpenAICompatibleProvider(
      { model: 'test-model' } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(request('max'), 'prompt');

    expect(reasoningOf(built)).toEqual({
      effort: 'xhigh',
      budget_tokens: 1024,
    });
  });

  it('clamps through the inherited output-limit path used by custom providers', () => {
    const provider = new ProviderUsingInheritedOutputLimit(
      { model: 'test-model' } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(request('max'), 'prompt');

    expect(reasoningOf(built)?.['effort']).toBe('xhigh');
  });

  it('clamps max on DashScope for non-Qwen compatible models', () => {
    const provider = new DashScopeOpenAICompatibleProvider(
      {
        model: 'glm-5.2',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        enableCacheControl: false,
      } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(
      { ...request('max'), model: 'glm-5.2' },
      'prompt',
    );

    expect(reasoningOf(built)?.['effort']).toBe('xhigh');
  });

  it('keeps max for providers that explicitly support it', () => {
    const provider = new MaxCapableProvider(
      { model: 'test-model' } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(request('max'), 'prompt');

    expect(reasoningOf(built)?.['effort']).toBe('max');
  });

  it('preserves max on the official DeepSeek wire shape', () => {
    const provider = new DeepSeekOpenAICompatibleProvider(
      {
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
      } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(request('max'), 'prompt') as unknown as Record<
      string,
      unknown
    >;

    expect(built['reasoning_effort']).toBe('max');
  });

  it('preserves max on the official Z.ai wire shape', () => {
    const provider = new ZaiOpenAICompatibleProvider(
      {
        model: 'glm-5.2',
        baseUrl: 'https://api.z.ai/v1',
      } as ContentGeneratorConfig,
      cliConfig,
    );

    const built = provider.buildRequest(request('max'), 'prompt') as unknown as Record<
      string,
      unknown
    >;

    expect(built['reasoning_effort']).toBe('max');
  });
});
