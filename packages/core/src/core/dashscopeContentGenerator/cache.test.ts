/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { planCacheMarkers } from './cache.js';
import type { DashScopeMessage } from './types.js';

describe('planCacheMarkers', () => {
  it('marks the system message and the last message when streaming', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ text: 'hi' }] },
      { role: 'assistant', content: [{ text: 'hello' }] },
      { role: 'user', content: [{ text: 'bye' }] },
    ];

    const result = planCacheMarkers(messages, {
      enabled: true,
      streaming: true,
    });

    expect(result[0]!.content).toEqual([
      { text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2]).toEqual(messages[2]);
    expect(result[3]!.content).toEqual([
      { text: 'bye', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks only the system message when not streaming', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ text: 'hi' }] },
    ];

    const result = planCacheMarkers(messages, {
      enabled: true,
      streaming: false,
    });

    expect(result[0]!.content).toEqual([
      { text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(result[1]).toEqual(messages[1]);
  });

  it('marks the last text block of a trailing tool message', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ text: 'call a tool' }] },
      {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: 'call_1',
            index: 0,
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [{ text: '22C sunny' }],
      },
    ];

    const result = planCacheMarkers(messages, {
      enabled: true,
      streaming: true,
    });

    const lastMessage = result[result.length - 1]!;
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.content).toEqual([
      { text: '22C sunny', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('promotes a plain string system message to array content', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: [{ text: 'hi' }] },
    ];

    const result = planCacheMarkers(messages, {
      enabled: true,
      streaming: false,
    });

    expect(result[0]!.content).toEqual([
      { text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('skips a media-only last message without throwing', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ image: 'data:image/png;base64,abc' }] },
    ];

    const result = planCacheMarkers(messages, {
      enabled: true,
      streaming: true,
    });

    expect(result[1]).toEqual(messages[1]);
    expect(JSON.stringify(result[1])).not.toContain('cache_control');
  });

  it('returns the input unchanged when disabled', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ text: 'hi' }] },
    ];

    const result = planCacheMarkers(messages, {
      enabled: false,
      streaming: true,
    });

    expect(result).toBe(messages);
    expect(JSON.stringify(result)).not.toContain('cache_control');
  });

  it('never mutates the input messages or their blocks', () => {
    const messages: DashScopeMessage[] = [
      { role: 'system', content: [{ text: 'system prompt' }] },
      { role: 'user', content: [{ text: 'hi' }] },
    ];
    const before = JSON.parse(JSON.stringify(messages));

    planCacheMarkers(messages, {
      enabled: true,
      streaming: true,
    });

    expect(messages).toEqual(before);
  });
});
