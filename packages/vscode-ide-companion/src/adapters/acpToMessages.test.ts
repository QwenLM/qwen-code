/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ToolCallData } from '@qwen-code/webui';
import type { TextMessage } from '../webview/hooks/message/useMessageHandling.js';
import type { PlanEntry } from '../types/chatTypes.js';
import { acpToMessages } from './acpToMessages.js';

/** Build a `TextMessage` fixture with the fields the tracer reads. */
function text(
  role: TextMessage['role'],
  content: string,
  timestamp: number,
): TextMessage {
  return { role, content, timestamp };
}

describe('acpToMessages (tracer)', () => {
  it('returns an empty array for no messages', () => {
    expect(acpToMessages({ messages: [] })).toEqual([]);
  });

  it('maps user / assistant / thinking to the shared contract in order', () => {
    const result = acpToMessages({
      messages: [
        text('user', 'hello', 1000),
        text('thinking', 'let me think', 1001),
        text('assistant', 'hi there', 1002),
      ],
    });

    expect(result).toEqual([
      {
        id: 'acp-user-1000-0',
        role: 'user',
        content: 'hello',
        timestamp: 1000,
      },
      {
        id: 'acp-thinking-1001-1',
        role: 'thinking',
        content: 'let me think',
        timestamp: 1001,
      },
      {
        id: 'acp-assistant-1002-2',
        role: 'assistant',
        content: 'hi there',
        timestamp: 1002,
      },
    ]);
  });

  it('derives ids from role + timestamp + index so React keys stay stable', () => {
    const result = acpToMessages({
      messages: [text('user', 'a', 5), text('user', 'b', 5)],
    });

    // Same role + timestamp are disambiguated by index, so keys never collide.
    expect(result.map((m) => m.id)).toEqual(['acp-user-5-0', 'acp-user-5-1']);
  });

  it('is pure — the same input yields deeply-equal output', () => {
    const input = { messages: [text('assistant', 'stable', 42)] };
    expect(acpToMessages(input)).toEqual(acpToMessages(input));
  });

  it('does not fold tool calls / plan into rows yet (tracer scope)', () => {
    // When WS3 folds these in, this assertion should change — that is the
    // signal to extend the golden coverage alongside the adapter.
    const toolCalls = new Map<string, ToolCallData>([
      ['call-1', { toolCallId: 'call-1' } as ToolCallData],
    ]);
    const planEntries = [{ content: 'step 1' } as PlanEntry];

    const result = acpToMessages({
      messages: [text('user', 'run a tool', 1)],
      toolCalls,
      planEntries,
    });

    expect(result).toHaveLength(1);
    expect(
      result.every((m) => m.role !== 'tool_group' && m.role !== 'plan'),
    ).toBe(true);
  });
});
