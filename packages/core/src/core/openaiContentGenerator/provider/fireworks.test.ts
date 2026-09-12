/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { FireworksOpenAICompatibleProvider } from './fireworks.js';

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
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/qwen3p8-max',
    ...overrides,
  } as ContentGeneratorConfig;
}

type AssistantWithReasoning =
  OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    reasoning_content?: string;
    reasoning?: string;
  };

/** A tool-call continuation: the assistant's thinking turn followed by the tool result. */
function createToolContinuationRequest(
  model = 'accounts/fireworks/models/qwen3p8-max',
): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model,
    messages: [
      { role: 'user', content: 'list the files here' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'I should list the directory.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_directory', arguments: '{"path":"."}' },
          },
        ],
      } as AssistantWithReasoning,
      { role: 'tool', tool_call_id: 'call_1', content: 'README.md' },
    ],
    max_tokens: 1000,
  };
}

describe('Fireworks provider detection', () => {
  it.each([
    ['https://api.fireworks.ai/inference/v1', true],
    ['https://API.Fireworks.AI/inference/v1', true],
    ['https://proxy.api.fireworks.ai/inference/v1', true],
    ['https://api.fireworks.ai.example.com/v1', false],
    ['https://openrouter.ai/api/v1', false],
    ['https://api.openai.com/v1', false],
    ['', false],
    ['not a url', false],
  ])('classifies baseUrl %s as fireworks=%s', (baseUrl, expected) => {
    expect(
      FireworksOpenAICompatibleProvider.isFireworksProvider(
        createProviderConfig({ baseUrl }),
      ),
    ).toBe(expected);
  });

  it('is selected by determineProvider for api.fireworks.ai', () => {
    const provider = determineProvider(
      createProviderConfig({}),
      createCliConfig(),
    );
    expect(provider).toBeInstanceOf(FireworksOpenAICompatibleProvider);
  });
});

describe('Fireworks qwen3 tool-call continuation (issue #11657)', () => {
  it('keeps reasoning_content and does not add the mirrored reasoning field', () => {
    const originalRequest = createToolContinuationRequest();
    const provider = determineProvider(
      createProviderConfig({}),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');
    const assistant = result.messages[1] as AssistantWithReasoning;

    expect(assistant.reasoning_content).toBe('I should list the directory.');
    expect('reasoning' in assistant).toBe(false);
    expect(assistant.tool_calls).toHaveLength(1);
    expect(result.messages[2]).toEqual(originalRequest.messages[2]);
    // The caller's request is left untouched.
    expect(originalRequest.messages[1]).not.toHaveProperty('reasoning');
  });

  it('still mirrors reasoning_content for qwen3 models on other OpenAI-compatible endpoints', () => {
    const originalRequest = createToolContinuationRequest('qwen3-coder-plus');
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen3-coder-plus',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');
    const assistant = result.messages[1] as AssistantWithReasoning;

    expect(assistant.reasoning_content).toBe('I should list the directory.');
    expect(assistant.reasoning).toBe('I should list the directory.');
  });
});
