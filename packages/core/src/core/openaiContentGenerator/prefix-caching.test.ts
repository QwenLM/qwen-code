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
    expect(isOfficialOpenAIEndpoint(config(AuthType.USE_OPENAI))).toBe(false);
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
    ['gpt-5', false],
    ['gpt-5.5', false],
    ['gpt-5.6', true],
    ['gpt-5.6.1', true],
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

  it('does not enable explicit mode without a reusable boundary', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'system' },
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

  it('partitions a session cache key by subagent identity', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'subagent request' }],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      false,
      'Explore-a1b2c3d4',
    );

    expect(result.prompt_cache_key).toBe(
      'qwen-code:session-123:Explore-a1b2c3d4',
    );
  });

  it('does not rewrite regular GPT-5.6 requests', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [
        { role: 'user', content: 'main request' },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'next request' },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      false,
    ) as OpenAI.Chat.ChatCompletionCreateParams & {
      prompt_cache_options?: unknown;
    };

    expect(result.prompt_cache_key).toBe('qwen-code:session-123');
    expect(result.prompt_cache_options).toBeUndefined();
    expect(result.messages).toEqual(request.messages);
  });

  it('preserves an existing prompt cache key', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'main request' }],
      prompt_cache_key: 'custom-cache-key',
    } as OpenAI.Chat.ChatCompletionCreateParams & {
      prompt_cache_key: string;
    };

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      false,
    );

    expect(result.prompt_cache_key).toBe('custom-cache-key');
  });

  it('marks only the two most recent reusable boundaries', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: 'old tool call' },
        { role: 'tool', tool_call_id: 'call-1', content: 'old tool result' },
        { role: 'assistant', content: 'middle response' },
        { role: 'user', content: 'recent request' },
        { role: 'assistant', content: 'recent tool call' },
        {
          role: 'tool',
          tool_call_id: 'call-2',
          content: 'recent tool result',
        },
        { role: 'user', content: 'compression directive' },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      true,
    );

    expect(result.messages[1]?.content).toBe('old request');
    expect(result.messages[3]?.content).toBe('old tool result');
    expect(result.messages[5]?.content).toEqual([
      {
        type: 'text',
        text: 'recent request',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
    expect(result.messages[7]?.content).toEqual([
      {
        type: 'text',
        text: 'recent tool result',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
  });

  it('marks the last part of array content at a reusable boundary', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'last part' },
          ],
        },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'compression directive' },
      ],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      true,
    );

    expect(result.messages[0]?.content).toEqual([
      { type: 'text', text: 'first part' },
      {
        type: 'text',
        text: 'last part',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
    ]);
  });
});
