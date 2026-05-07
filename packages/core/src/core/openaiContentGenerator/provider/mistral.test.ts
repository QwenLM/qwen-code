/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { MistralOpenAICompatibleProvider } from './mistral.js';

describe('MistralOpenAICompatibleProvider', () => {
  const mockCliConfig = {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  function createConfig(
    overrides: Partial<ContentGeneratorConfig> = {},
  ): ContentGeneratorConfig {
    return {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'mistral-large-latest',
      ...overrides,
    } as ContentGeneratorConfig;
  }

  describe('isMistralProvider', () => {
    it('matches the official Mistral OpenAI-compatible API host', () => {
      expect(
        MistralOpenAICompatibleProvider.isMistralProvider(createConfig()),
      ).toBe(true);
    });

    it('matches Mistral models on self-hosted OpenAI-compatible endpoints', () => {
      expect(
        MistralOpenAICompatibleProvider.isMistralProvider(
          createConfig({
            baseUrl: 'https://my-vllm.example.com/v1',
            model: 'Mistral-7B-Instruct-v0.3',
          }),
        ),
      ).toBe(true);
    });

    it('does not match unrelated hosts and models', () => {
      expect(
        MistralOpenAICompatibleProvider.isMistralProvider(
          createConfig({
            baseUrl: 'https://api.example.com/v1',
            model: 'gpt-4o',
          }),
        ),
      ).toBe(false);
    });
  });

  it('is selected by the OpenAI-compatible provider factory', () => {
    const provider = determineProvider(createConfig(), mockCliConfig);

    expect(provider).toBeInstanceOf(MistralOpenAICompatibleProvider);
  });

  it('is selected by the factory for self-hosted Mistral models', () => {
    const provider = determineProvider(
      createConfig({
        baseUrl: 'https://my-vllm.example.com/v1',
        model: 'mistralai/Mistral-7B-Instruct-v0.3',
      }),
      mockCliConfig,
    );

    expect(provider).toBeInstanceOf(MistralOpenAICompatibleProvider);
  });

  it('removes reasoning_content from outbound assistant messages without mutating history', () => {
    const provider = new MistralOpenAICompatibleProvider(
      createConfig(),
      mockCliConfig,
    );
    const toolCalls: NonNullable<
      OpenAI.Chat.ChatCompletionAssistantMessageParam['tool_calls']
    > = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'glob', arguments: '{"pattern":"*.ts"}' },
      },
    ];
    const assistantMessage = {
      role: 'assistant',
      content: 'I found one file.',
      reasoning_content: 'hidden reasoning from a previous model',
      tool_calls: toolCalls,
    } as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
      reasoning_content: string;
    };
    const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'mistral-large-latest',
      messages: [
        { role: 'user', content: 'Find TypeScript files' },
        assistantMessage,
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'Found 1 matching file',
        },
      ],
    };

    const result = provider.buildRequest(originalRequest, 'prompt-123');
    const outboundAssistant = result.messages?.[1] as unknown as Record<
      string,
      unknown
    >;

    expect(outboundAssistant).not.toHaveProperty('reasoning_content');
    expect(outboundAssistant['content']).toBe('I found one file.');
    expect(outboundAssistant['tool_calls']).toBe(toolCalls);
    expect(
      (originalRequest.messages[1] as typeof assistantMessage)
        .reasoning_content,
    ).toBe('hidden reasoning from a previous model');
  });

  it('preserves assistant messages that do not contain reasoning_content', () => {
    const provider = new MistralOpenAICompatibleProvider(
      createConfig(),
      mockCliConfig,
    );
    const assistantMessage = {
      role: 'assistant',
      content: 'No reasoning field here.',
    } as OpenAI.Chat.ChatCompletionMessageParam;
    const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'Hello' }, assistantMessage],
    };

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toBe(assistantMessage);
  });
});
