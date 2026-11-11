/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildForkContextMessages,
  buildForkContextMessagesFromPrefix,
  completeForkContextMessages,
} from './forkContextUtils.js';
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  UserMessage,
} from '../protocol/transcript/message.js';
import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';

function userMsg(text: string): UserMessage {
  return {
    type: 'user',
    uuid: `user-${text}`,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: text },
  };
}

function assistantToolUseMsg(id: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: 'response-parallel-tools',

      model: 'test-model',
      stop_reason: 'tool_use',

      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { prompt: id },
        },
      ],
    },
  };
}

function toolResultMsg(id: string): UserMessage {
  return {
    type: 'user',
    uuid: `result-${id}`,
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: `completed ${id}`,
        },
      ],
    },
  };
}

describe('buildForkContextMessages', () => {
  function listingAttachment(): AttachmentMessage {
    return {
      type: 'attachment',
      attachment: {
        type: 'agent_listing_delta',
        addedTypes: ['Explore'],
        addedLines: ['- Explore: explores the codebase'],
        removedTypes: [],
        isInitial: true,
        showConcurrencyNote: false,
      },
      uuid: 'uuid-listing',
      timestamp: '2026-01-01T00:00:00Z',
    };
  }

  it('preserves reinjected reminder attachments for byte alignment', () => {
    const msgs = [userMsg('hello'), listingAttachment(), userMsg('world')];
    const out = buildForkContextMessages(msgs);
    // Reminders are kept so the fork's prefix matches the parent's actual
    // API request — every fork (memory, session-memory, run-agent, even
    // compaction) benefits from the prompt cache hit.
    const text = JSON.stringify(out);
    expect(text).toContain('Available agent types');
  });

  it('preserves inline images so fork prefixes stay cache-aligned', () => {
    const msgs: Message[] = [
      {
        type: 'user',
        uuid: 'user-image',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc123',
              },
            },
          ],
        },
      },
    ];

    const out = buildForkContextMessages(msgs);

    if (msgs[0].type !== 'user') {
      throw new Error('应保留用户图片消息');
    }
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'inspect this' },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
      },
    ]);
    expect(msgs[0].message.content).toMatchObject([
      { type: 'text', text: 'inspect this' },
      { type: 'image', source: { media_type: 'image/png' } },
    ]);
  });

  it('prepends the startup memory user message when context is provided', () => {
    const msgs = [userMsg('hello')];
    const out = buildForkContextMessages(msgs, {
      agentsMd: 'global memory body',
      currentDate: "Today's date is 2026-05-06.",
    });
    // Startup memory is prepended before normalization, so it merges with the
    // following user turn just like the main request path.
    expect(out.length).toBe(1);
    const first = JSON.stringify(out[0]);
    expect(first).toContain('# agentsMd');
    expect(first).toContain('# currentDate');
    expect(first).toContain('hello');
  });

  it('skips the prepend when startup memory context is empty', () => {
    const msgs = [userMsg('hello')];
    const before = buildForkContextMessages(msgs);
    const after = buildForkContextMessages(msgs, {});
    expect(after).toEqual(before);
  });

  it('normalizes an exact request prefix together with the fork history', () => {
    const prefix = [userMsg('exact startup prefix')];
    const history = [userMsg('parent request')];

    const projected = buildForkContextMessagesFromPrefix(history, prefix);
    const expected = buildForkContextMessages([...prefix, ...history]);

    expect(projected).toEqual(expected);
    expect(projected).toHaveLength(1);
    expect(JSON.stringify(projected[0])).toContain('exact startup prefix');
    expect(JSON.stringify(projected[0])).toContain('parent request');
  });

  it('preserves reasoning when a fork targets a different server model', () => {
    const source: AssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-reasoning',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        id: 'response-reasoning',

        model: 'source-model',
        stop_reason: 'end_turn',

        content: [
          {
            type: 'thinking',
            thinking: 'Visible reasoning.',
            signature: 'provider-signature',
          },
          { type: 'redacted_thinking', data: 'encrypted-reasoning' },
          { type: 'text', text: 'Visible answer.' },
        ],
      },
    };

    const out = buildForkContextMessages(
      [source, userMsg('continue')],
      undefined,
      { targetModel: 'target-model' },
    );

    expect(out[0]).toEqual({
      role: 'assistant',
      content: source.message.content,
    });
  });

  it('adds placeholders for every tool use in a split assistant turn', () => {
    const out = buildForkContextMessages([
      userMsg('run in parallel'),
      assistantToolUseMsg('tool-1'),
      assistantToolUseMsg('tool-2'),
    ]);

    expect(out).toHaveLength(4);
    expect(out[1]).toMatchObject({
      role: 'assistant',
      content: [],
      toolCalls: [
        { id: 'tool-1', name: 'Agent', arguments: '{"prompt":"tool-1"}' },
        { id: 'tool-2', name: 'Agent', arguments: '{"prompt":"tool-2"}' },
      ],
    });
    expect(out[2]).toMatchObject({ role: 'tool', toolCallId: 'tool-1' });
    expect(out[3]).toMatchObject({ role: 'tool', toolCallId: 'tool-2' });
  });

  it('does not duplicate a placeholder for an existing tool result', () => {
    const out = buildForkContextMessages([
      userMsg('run a task'),
      assistantToolUseMsg('tool-1'),
      toolResultMsg('tool-1'),
    ]);

    const toolResults = out.filter((message) => message.role === 'tool');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'tool-1',
      content: [{ type: 'text', text: 'completed tool-1' }],
    });
  });

  it('adds placeholders only for unfinished parallel tool uses', () => {
    const out = buildForkContextMessages([
      userMsg('run in parallel'),
      assistantToolUseMsg('tool-1'),
      assistantToolUseMsg('tool-2'),
      toolResultMsg('tool-1'),
    ]);

    const toolResults = out.filter((message) => message.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((message) => message.toolCallId)).toEqual([
      'tool-1',
      'tool-2',
    ]);
  });
});

describe('completeForkContextMessages', () => {
  it('completes a cache-safe snapshot ending in an Agent tool use', () => {
    const snapshot: readonly ModelStreamMessage[] = Object.freeze([
      Object.freeze({
        role: 'user' as const,
        content: Object.freeze([
          { type: 'text' as const, text: 'delegate this' },
        ]),
      }),
      Object.freeze({
        role: 'assistant' as const,
        content: [],
        toolCalls: Object.freeze([
          Object.freeze({
            id: 'agent-call-1',
            name: 'Agent',
            arguments: '{"prompt":"inspect the code"}',
          }),
        ]),
      }),
    ]);

    const completed = completeForkContextMessages(snapshot);

    expect(completed).toHaveLength(3);
    expect(completed[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'agent-call-1',
      isError: false,
      content: [
        { type: 'text', text: 'Fork started — processing in background' },
      ],
    });
    expect(completed[0]).toBe(snapshot[0]);
    expect(completed[1]).toBe(snapshot[1]);
    expect(snapshot).toHaveLength(2);
  });
});
