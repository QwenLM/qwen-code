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

type Request = OpenAI.Chat.ChatCompletionCreateParams;

function config(authType: AuthType, baseUrl?: string): ContentGeneratorConfig {
  return { model: 'test-model', authType, baseUrl };
}

const supportsPrefix = (authType: AuthType, baseUrl?: string) =>
  supportsOpenAIPrefixCaching(config(authType, baseUrl));

const isOfficial = (authType: AuthType, baseUrl?: string) =>
  isOfficialOpenAIEndpoint(config(authType, baseUrl));

/** Applies caching for session-123 to a `{ model, messages }` request. */
function applyCaching(
  model: string,
  cacheSharing: boolean,
  messages: unknown[],
  agentId?: string,
) {
  const request = { model, messages } as Request;
  const result = applyOfficialOpenAIPromptCaching(
    request,
    'session-123',
    cacheSharing,
    agentId,
  ) as Request & { prompt_cache_options?: unknown };
  return { request, result };
}

/** A text part carrying an explicit cache breakpoint. */
const breakpoint = (text: string) => ({
  type: 'text',
  text,
  prompt_cache_breakpoint: { mode: 'explicit' },
});

/** Automatic caching: only the session key is added. */
function expectOnlySessionKey({
  request,
  result,
}: ReturnType<typeof applyCaching>) {
  expect(result.prompt_cache_key).toBe('qwen-code:session-123');
  expect(result.prompt_cache_options).toBeUndefined();
  expect(result.messages).toEqual(request.messages);
}

describe('supportsOpenAIPrefixCaching', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://api.deepseek.com/v1',
    'https://proxy.example/v1',
  ])('accepts OpenAI-compatible endpoint %s', (baseUrl) => {
    expect(supportsPrefix(AuthType.USE_OPENAI, baseUrl)).toBe(true);
  });

  it('keeps non-OpenAI providers excluded', () => {
    expect(supportsPrefix(AuthType.USE_GEMINI)).toBe(false);
  });

  it('keeps Qwen OAuth on its existing DashScope path', () => {
    expect(
      supportsPrefix(
        AuthType.QWEN_OAUTH,
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe(true);
    expect(
      supportsPrefix(AuthType.QWEN_OAUTH, 'https://proxy.example/v1'),
    ).toBe(true);
  });
});

describe('official OpenAI prompt caching', () => {
  it('recognizes only the official OpenAI API origin', () => {
    expect(isOfficial(AuthType.USE_OPENAI)).toBe(false);
    expect(isOfficial(AuthType.USE_OPENAI, 'https://api.openai.com/v1')).toBe(
      true,
    );
    expect(
      isOfficial(AuthType.USE_OPENAI, 'https://api.openai.com.evil.test/v1'),
    ).toBe(false);
    expect(isOfficial(AuthType.QWEN_OAUTH, 'https://api.openai.com/v1')).toBe(
      false,
    );
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
    const { result } = applyCaching('gpt-5.6', true, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'main request' },
      { role: 'assistant', content: 'calling a tool' },
      { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
      { role: 'assistant', content: 'main response' },
      { role: 'user', content: 'compression directive' },
    ]);

    expect(result.prompt_cache_key).toBe('qwen-code:session-123');
    expect(result.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(result.messages[1]?.content).toEqual([breakpoint('main request')]);
    expect(result.messages[3]?.content).toEqual([breakpoint('tool result')]);
    expect(result.messages.at(-1)?.content).toBe('compression directive');
  });

  it('uses automatic caching without unsupported fields on older models', () => {
    expectOnlySessionKey(
      applyCaching('gpt-5.5', true, [
        { role: 'user', content: 'main request' },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'compression directive' },
      ]),
    );
  });

  it('does not enable explicit mode without a reusable boundary', () => {
    expectOnlySessionKey(
      applyCaching('gpt-5.6', true, [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'compression directive' },
      ]),
    );
  });

  it('partitions a session cache key by subagent identity', () => {
    const { result } = applyCaching(
      'gpt-5.6',
      false,
      [{ role: 'user', content: 'subagent request' }],
      'Explore-a1b2c3d4',
    );

    expect(result.prompt_cache_key).toBe(
      'qwen-code:session-123:Explore-a1b2c3d4',
    );
  });

  it('does not rewrite regular GPT-5.6 requests', () => {
    expectOnlySessionKey(
      applyCaching('gpt-5.6', false, [
        { role: 'user', content: 'main request' },
        { role: 'assistant', content: 'main response' },
        { role: 'user', content: 'next request' },
      ]),
    );
  });

  it('preserves an existing prompt cache key', () => {
    const request = {
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'main request' }],
      prompt_cache_key: 'custom-cache-key',
    } as Request & { prompt_cache_key: string };

    const result = applyOfficialOpenAIPromptCaching(
      request,
      'session-123',
      false,
    );

    expect(result.prompt_cache_key).toBe('custom-cache-key');
  });

  it('marks only the two most recent reusable boundaries', () => {
    const { result } = applyCaching('gpt-5.6', true, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old tool call' },
      { role: 'tool', tool_call_id: 'call-1', content: 'old tool result' },
      { role: 'assistant', content: 'middle response' },
      { role: 'user', content: 'recent request' },
      { role: 'assistant', content: 'recent tool call' },
      { role: 'tool', tool_call_id: 'call-2', content: 'recent tool result' },
      { role: 'user', content: 'compression directive' },
    ]);

    expect(result.messages[1]?.content).toBe('old request');
    expect(result.messages[3]?.content).toBe('old tool result');
    expect(result.messages[5]?.content).toEqual([breakpoint('recent request')]);
    expect(result.messages[7]?.content).toEqual([
      breakpoint('recent tool result'),
    ]);
  });

  it('marks the last part of array content at a reusable boundary', () => {
    const { result } = applyCaching('gpt-5.6', true, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first part' },
          { type: 'text', text: 'last part' },
        ],
      },
      { role: 'assistant', content: 'main response' },
      { role: 'user', content: 'compression directive' },
    ]);

    expect(result.messages[0]?.content).toEqual([
      { type: 'text', text: 'first part' },
      breakpoint('last part'),
    ]);
  });
});
