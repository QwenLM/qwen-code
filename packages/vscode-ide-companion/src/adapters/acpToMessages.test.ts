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

/** Build a `TextMessage` fixture with the fields the adapter reads. */
function text(
  role: TextMessage['role'],
  content: string,
  timestamp: number,
): TextMessage {
  return { role, content, timestamp };
}

/** Build a `ToolCallData` fixture, overriding any field. */
function tool(
  over: Partial<ToolCallData> & { toolCallId: string },
): ToolCallData {
  return {
    kind: 'read_file',
    title: 'Read file',
    status: 'completed',
    ...over,
  };
}

/** Map a tool-call map preserving insertion order. */
function toolMap(...tools: ToolCallData[]): Map<string, ToolCallData> {
  return new Map(tools.map((t) => [t.toolCallId, t]));
}

describe('acpToMessages', () => {
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

    expect(result.map((m) => m.id)).toEqual(['acp-user-5-0', 'acp-user-5-1']);
  });

  it('is pure — the same input yields deeply-equal output', () => {
    const input = { messages: [text('assistant', 'stable', 42)] };
    expect(acpToMessages(input)).toEqual(acpToMessages(input));
  });

  it('folds consecutive tool calls into a single tool_group', () => {
    const result = acpToMessages({
      messages: [text('assistant', 'working', 10)],
      toolCalls: toolMap(
        tool({ toolCallId: 'a', timestamp: 11 }),
        tool({ toolCallId: 'b', timestamp: 12 }),
      ),
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'assistant' });
    expect(result[1]).toMatchObject({
      id: 'acp-tools-a',
      role: 'tool_group',
      timestamp: 11,
    });
    const group = result[1] as Extract<
      (typeof result)[number],
      { role: 'tool_group' }
    >;
    expect(group.tools.map((t) => t.callId)).toEqual(['a', 'b']);
  });

  it('interleaves tool groups with text by timestamp, splitting groups on text', () => {
    const result = acpToMessages({
      messages: [text('user', 'do it', 1), text('assistant', 'mid', 3)],
      toolCalls: toolMap(
        tool({ toolCallId: 'first', timestamp: 2 }),
        tool({ toolCallId: 'second', timestamp: 4 }),
      ),
    });

    expect(result.map((m) => m.role)).toEqual([
      'user',
      'tool_group',
      'assistant',
      'tool_group',
    ]);
    expect((result[1] as { id: string }).id).toBe('acp-tools-first');
    expect((result[3] as { id: string }).id).toBe('acp-tools-second');
  });

  it('maps ToolCallData fields onto the shared ACPToolCall shape', () => {
    const result = acpToMessages({
      messages: [],
      toolCalls: toolMap(
        tool({
          toolCallId: 'call-1',
          kind: 'edit_file',
          title: 'Edit src/x.ts',
          status: 'cancelled',
          rawInput: { path: 'src/x.ts' },
          locations: [{ path: 'src/x.ts', line: null }],
          content: [
            { type: 'diff', path: 'src/x.ts', oldText: null, newText: 'b' },
          ],
        }),
      ),
    });

    const group = result[0] as Extract<
      (typeof result)[number],
      { role: 'tool_group' }
    >;
    expect(group.tools[0]).toEqual({
      callId: 'call-1',
      toolName: 'edit_file',
      title: 'Edit src/x.ts',
      // `cancelled` has no shared equivalent → terminal failure.
      status: 'failed',
      args: { path: 'src/x.ts' },
      rawOutput: undefined,
      // path → file, null line → undefined.
      locations: [{ file: 'src/x.ts', line: undefined }],
      // null oldText → undefined.
      content: [
        {
          type: 'diff',
          content: undefined,
          path: 'src/x.ts',
          oldText: undefined,
          newText: 'b',
        },
      ],
      startTime: undefined,
    });
  });

  it('flattens an object tool title to a JSON string', () => {
    const result = acpToMessages({
      messages: [],
      toolCalls: toolMap(
        tool({ toolCallId: 't', title: { label: 'x' } as unknown as string }),
      ),
    });
    const group = result[0] as Extract<
      (typeof result)[number],
      { role: 'tool_group' }
    >;
    expect(group.tools[0].title).toBe('{"label":"x"}');
  });

  it('folds plan entries into a plan row appended after the conversation', () => {
    const planEntries: PlanEntry[] = [
      { content: 'step 1', status: 'completed', priority: 'high' },
      { content: 'step 2', status: 'in_progress' },
    ];
    const result = acpToMessages({
      messages: [text('user', 'plan it', 1)],
      planEntries,
    });

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      id: 'acp-plan',
      role: 'plan',
      todos: [
        {
          id: 'acp-plan-0',
          content: 'step 1',
          status: 'completed',
          priority: 'high',
        },
        {
          id: 'acp-plan-1',
          content: 'step 2',
          status: 'in_progress',
          priority: undefined,
        },
      ],
    });
  });

  it('appends insight progress and ready rows', () => {
    const result = acpToMessages({
      messages: [],
      insight: { stage: 'analyzing', progress: 0.5, detail: 'reading' },
      insightReportPath: '/tmp/report.md',
    });

    expect(result).toEqual([
      {
        id: 'acp-insight-progress',
        role: 'insight_progress',
        stage: 'analyzing',
        progress: 0.5,
        detail: 'reading',
      },
      {
        id: 'acp-insight-ready',
        role: 'insight_ready',
        path: '/tmp/report.md',
      },
    ]);
  });

  it('omits plan / insight rows when their state is absent', () => {
    const result = acpToMessages({
      messages: [text('user', 'hi', 1)],
      planEntries: [],
      insight: null,
      insightReportPath: null,
    });
    expect(result.map((m) => m.role)).toEqual(['user']);
  });
});
