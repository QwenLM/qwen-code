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
import { MiMoOpenAICompatibleProvider } from './mimo.js';

function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function createProviderConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    ...overrides,
  } as ContentGeneratorConfig;
}

describe('MiMoOpenAICompatibleProvider', () => {
  it('is selected for Xiaomi MiMo hostnames', () => {
    const provider = determineProvider(
      createProviderConfig(),
      createCliConfig(),
    );

    expect(provider).toBeInstanceOf(MiMoOpenAICompatibleProvider);
  });

  it('is selected for official API hostnames', () => {
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'custom-model-alias',
      }),
      createCliConfig(),
    );

    expect(provider).toBeInstanceOf(MiMoOpenAICompatibleProvider);
  });

  it('is selected for MiMo model names behind custom gateways', () => {
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://gateway.example.com/v1',
        model: 'MiMo-V2.5-Pro',
      }),
      createCliConfig(),
    );

    expect(provider).toBeInstanceOf(MiMoOpenAICompatibleProvider);
  });

  it('does not match hostile hostnames containing xiaomimimo.com', () => {
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.xiaomimimo.com.evil.example/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    expect(provider).not.toBeInstanceOf(MiMoOpenAICompatibleProvider);
  });

  it('splits tool-result media by default for strict MiMo chat requests', () => {
    const provider = determineProvider(
      createProviderConfig(),
      createCliConfig(),
    );

    expect(provider.getRequestContextOverrides?.()).toEqual({
      splitToolMedia: true,
    });
  });

  it('preserves an explicit splitToolMedia override', () => {
    const provider = determineProvider(
      createProviderConfig({ splitToolMedia: false }),
      createCliConfig(),
    );

    expect(provider.getRequestContextOverrides?.()).toEqual({
      splitToolMedia: false,
    });
  });

  it('injects empty reasoning_content on tool-calling assistant turns missing it', () => {
    const provider = determineProvider(
      createProviderConfig(),
      createCliConfig(),
    );
    const request: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: 'list markdown files' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Found 2 files' },
      ],
    };

    const result = provider.buildRequest(request, 'prompt-123');
    const assistant = result.messages?.[1] as {
      reasoning_content?: string;
    };

    expect(assistant.reasoning_content).toBe('');
  });

  it('preserves existing reasoning_content on tool-calling assistant turns', () => {
    const provider = determineProvider(
      createProviderConfig(),
      createCliConfig(),
    );
    const request = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user' as const, content: 'list markdown files' },
        {
          role: 'assistant' as const,
          content: '',
          reasoning_content: 'I should search the repository.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'glob', arguments: '{"pattern":"**/*.md"}' },
            },
          ],
        },
      ],
    } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

    const result = provider.buildRequest(request, 'prompt-123');
    const assistant = result.messages?.[1] as {
      reasoning_content?: string;
    };

    expect(assistant.reasoning_content).toBe('I should search the repository.');
  });

  it('injects empty reasoning_content on assistant turns without tool calls', () => {
    const provider = determineProvider(
      createProviderConfig(),
      createCliConfig(),
    );
    const request: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };

    const result = provider.buildRequest(request, 'prompt-123');
    const assistant = result.messages?.[1] as {
      reasoning_content?: string;
    };

    expect(assistant.reasoning_content).toBe('');
  });
});
