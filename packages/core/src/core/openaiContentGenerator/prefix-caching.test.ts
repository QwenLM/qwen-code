/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import {
  applyOfficialOpenAIPromptCaching,
  isOfficialOpenAIEndpoint,
  supportsExplicitOpenAIPromptCaching,
  supportsOpenAIPrefixCaching,
} from './prefix-caching.js';

function config(authType: AuthType, baseUrl?: string): ContentGeneratorConfig {
  return { model: 'test-model', authType, baseUrl };
}

describe('supportsOpenAIPrefixCaching', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://api.deepseek.com/v1',
    'https://proxy.example/v1',
  ])('accepts OpenAI-compatible endpoint %s', (baseUrl) => {
    expect(
      supportsOpenAIPrefixCaching(config(AuthType.USE_OPENAI, baseUrl)),
    ).toBe(true);
  });

  it('keeps non-OpenAI providers excluded', () => {
    expect(supportsOpenAIPrefixCaching(config(AuthType.USE_GEMINI))).toBe(
      false,
    );
  });

  it('keeps Qwen OAuth on its existing DashScope path', () => {
    expect(
      supportsOpenAIPrefixCaching(
        config(
          AuthType.QWEN_OAUTH,
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ),
      ),
    ).toBe(true);
    expect(
      supportsOpenAIPrefixCaching(
        config(AuthType.QWEN_OAUTH, 'https://proxy.example/v1'),
      ),
    ).toBe(true);
  });
});

describe('official OpenAI prompt caching', () => {
  it('recognizes only the official OpenAI API origin', () => {
    expect(
      isOfficialOpenAIEndpoint(
        config(AuthType.USE_OPENAI, 'https://api.openai.com/v1'),
      ),
    ).toBe(true);
    expect(
      isOfficialOpenAIEndpoint(
        config(AuthType.USE_OPENAI, 'https://api.openai.com.evil.test/v1'),
      ),
    ).toBe(false);
    expect(
      isOfficialOpenAIEndpoint(
        config(AuthType.QWEN_OAUTH, 'https://api.openai.com/v1'),
      ),
    ).toBe(false);
  });

  it.each([
    ['gpt-5.5', false],
    ['gpt-5.6', true],
    ['gpt-5.6-2026-08-01', true],
    ['gpt-6', true],
    ['o4-mini', false],
  ])('classifies explicit caching support for %s', (model, expected) => {
    expect(supportsExplicitOpenAIPromptCaching(model)).toBe(expected);
  });

  it('adds a stable key and marks reusable boundaries for GPT-5.6 compression', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'main request' },
        { role: 'assistant', content: 'calling a tool' },
        { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'compression directive' },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      true,
    ) as OpenAI.Chat.ChatCompletionCreateParams & {
      prompt_cache_options?: { mode?: string };
    };

    expect(result.prompt_cache_key).toBe('qwen-code:session-123');
    expect(result.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(result.messages[1]?.content).toEqual([
      {
        type: 'text',
        text: 'main request',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
    expect(result.messages[3]?.content).toEqual([
      {
        type: 'text',
        text: 'tool result',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
    expect(result.messages.at(-1)?.content).toBe('compression directive');
  });

  it('uses automatic caching without unsupported fields on older models', () => {
    const request = {
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'main request' },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'compression directive' },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      true,
    ) as OpenAI.Chat.ChatCompletionCreateParams & {
      prompt_cache_options?: unknown;
    };

    expect(result.prompt_cache_key).toBe('qwen-code:session-123');
    expect(result.prompt_cache_options).toBeUndefined();
    expect(result.messages).toEqual(request.messages);
  });
});
