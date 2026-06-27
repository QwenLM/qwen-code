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

function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function createProviderConfig(
  overrides: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    ...overrides,
  } as ContentGeneratorConfig;
}

function createReasoningRequest(): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Say OK' },
      {
        role: 'assistant',
        content: 'OK',
        reasoning_content: 'User asked for a short response.',
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
        reasoning_content: string;
      },
      { role: 'user', content: 'Say OK again' },
    ],
    max_tokens: 1000,
  };
}

describe('Mistral provider outbound compatibility filtering', () => {
  it('strips reasoning_content from outgoing requests for api.mistral.ai without mutating the source history', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'strict-chat-alias',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'OK',
    });
    expect(
      (originalRequest.messages[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });

  it('also strips reasoning_content when a Mistral model is served behind a custom base URL', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://strict-proxy.example.com/v1',
        model: 'Mistral-Large-Latest',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'OK',
    });
  });

  it('preserves reasoning_content for non-Mistral OpenAI-compatible providers', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });

  it('does not treat hostile hostnames containing api.mistral.ai as Mistral', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.mistral.ai.evil.example/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });
});
