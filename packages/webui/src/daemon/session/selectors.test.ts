/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  extractDaemonTodosFromToolBlock,
  isDaemonSubAgentToolBlock,
  selectDaemonActiveTodoList,
  selectDaemonLatestTodoList,
  selectDaemonPendingPermissions,
  selectDaemonSubAgentToolBlocks,
  selectDaemonStreamingState,
  selectDaemonTodoLists,
  selectDaemonTranscriptStreamingState,
} from './selectors.js';

describe('daemon selectors', () => {
  it('selects only unresolved permission blocks', () => {
    const pending = block({ kind: 'permission', requestId: 'pending' });
    const resolved = block({
      kind: 'permission',
      requestId: 'resolved',
      resolved: 'selected',
    });

    expect(selectDaemonPendingPermissions([pending, resolved])).toEqual([
      pending,
    ]);
  });

  it('extracts todo lists from plan and TodoWrite tool blocks', () => {
    const completed = block({
      kind: 'tool',
      id: 'tool-block-1',
      toolCallId: 'tool-1',
      title: 'Updated Plan',
      status: 'completed',
      toolName: 'TodoWrite',
      toolKind: 'updated_plan',
      rawOutput: {
        entries: [
          {
            content: 'first',
            status: 'completed',
            priority: 'high',
            _meta: {
              qwenTodo: { id: 'todo-1', blockedBy: ['prepare'] },
            },
          },
        ],
        plan: { id: 'plan-1', sourceCallId: 'todo-call-1' },
      },
    });
    const active = block({
      kind: 'tool',
      id: 'tool-block-2',
      toolCallId: 'tool-2',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          {
            id: 'todo-2',
            content: 'second',
            status: 'in_progress',
            priority: 'medium',
          },
        ],
      },
    });

    expect(extractDaemonTodosFromToolBlock(asToolBlock(active))).toEqual([
      {
        id: 'todo-2',
        content: 'second',
        status: 'in_progress',
        priority: 'medium',
      },
    ]);
    expect(selectDaemonTodoLists([completed, active])).toHaveLength(2);
    expect(selectDaemonTodoLists([completed])[0]).toMatchObject({
      planId: 'plan-1',
      sourceCallId: 'todo-call-1',
      items: [{ id: 'todo-1', blockedBy: ['prepare'] }],
    });
    expect(selectDaemonLatestTodoList([completed, active])).toMatchObject({
      toolCallId: 'tool-2',
      items: [{ content: 'second' }],
    });
    expect(selectDaemonActiveTodoList([completed, active])).toMatchObject({
      toolCallId: 'tool-2',
    });
  });

  it('keeps an empty latest plan so it clears the active list', () => {
    const active = block({
      kind: 'tool',
      id: 'active',
      toolCallId: 'active-call',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [{ id: 'one', content: 'one', status: 'in_progress' }],
      },
    });
    const cleared = block({
      kind: 'tool',
      id: 'cleared',
      toolCallId: 'clear-call',
      title: 'Updated Plan',
      status: 'completed',
      toolName: 'TodoWrite',
      rawOutput: {
        entries: [],
        plan: { id: 'plan-1', sourceCallId: 'clear-call' },
      },
    });

    expect(selectDaemonLatestTodoList([active, cleared])).toMatchObject({
      planId: 'plan-1',
      items: [],
    });
    expect(selectDaemonActiveTodoList([active, cleared])).toBeUndefined();
  });

  it('ignores an empty output from a non-todo tool', () => {
    const other = block({
      kind: 'tool',
      id: 'other',
      toolCallId: 'other-call',
      title: 'List records',
      status: 'completed',
      toolName: 'mcp__example__list',
      toolKind: 'other',
      rawOutput: { entries: [], plan: {} },
    });

    expect(extractDaemonTodosFromToolBlock(asToolBlock(other))).toBeUndefined();
    expect(selectDaemonTodoLists([other])).toEqual([]);
  });

  it('does not resurrect stale active todos after the latest list completes', () => {
    const active = block({
      kind: 'tool',
      id: 'tool-block-1',
      toolCallId: 'tool-1',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          {
            id: 'todo-1',
            content: 'active',
            status: 'in_progress',
          },
        ],
      },
    });
    const completed = block({
      kind: 'tool',
      id: 'tool-block-2',
      toolCallId: 'tool-2',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          {
            id: 'todo-1',
            content: 'active',
            status: 'completed',
          },
        ],
      },
    });

    expect(selectDaemonActiveTodoList([active, completed])).toBeUndefined();
  });

  it('ignores earlier active todo lists when the latest list is complete', () => {
    const earlierActive = block({
      kind: 'tool',
      id: 'tool-block-1',
      toolCallId: 'tool-1',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          {
            id: 'todo-1',
            content: 'older active work',
            status: 'in_progress',
          },
        ],
      },
    });
    const latestCompleted = block({
      kind: 'tool',
      id: 'tool-block-2',
      toolCallId: 'tool-2',
      title: 'TodoWrite',
      status: 'completed',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          {
            id: 'todo-2',
            content: 'newer finished work',
            status: 'completed',
          },
        ],
      },
    });

    expect(
      selectDaemonActiveTodoList([earlierActive, latestCompleted]),
    ).toBeUndefined();
  });

  it('identifies sub-agent tool blocks from daemon metadata and raw output', () => {
    const parent = block({
      kind: 'tool',
      toolCallId: 'agent-1',
      title: 'Agent',
      status: 'in_progress',
      toolName: 'agent',
    });
    const child = block({
      kind: 'tool',
      toolCallId: 'child-1',
      title: 'Read',
      status: 'completed',
      toolName: 'read_file',
      parentToolCallId: 'agent-1',
    });
    const rawTask = block({
      kind: 'tool',
      toolCallId: 'task-1',
      title: 'Task',
      status: 'completed',
      toolName: 'other',
      rawOutput: { type: 'task_execution' },
    });

    expect(isDaemonSubAgentToolBlock(asToolBlock(parent))).toBe(true);
    expect(isDaemonSubAgentToolBlock(asToolBlock(child))).toBe(true);
    expect(selectDaemonSubAgentToolBlocks([parent, child, rawTask])).toEqual([
      parent,
      child,
      rawTask,
    ]);
  });

  it('derives transcript streaming state from active text and tool blocks', () => {
    expect(
      selectDaemonTranscriptStreamingState([
        block({ kind: 'thought', text: 'thinking', streaming: true }),
      ]),
    ).toBe('thinking');
    expect(
      selectDaemonTranscriptStreamingState([
        block({ kind: 'assistant', text: 'answer', streaming: true }),
      ]),
    ).toBe('responding');
    expect(
      selectDaemonTranscriptStreamingState([
        block({ kind: 'tool', status: 'in_progress' }),
      ]),
    ).toBe('responding');
    expect(
      selectDaemonTranscriptStreamingState([
        block({ kind: 'tool', status: 'failed' }),
      ]),
    ).toBe('idle');
    expect(
      selectDaemonTranscriptStreamingState([
        block({ kind: 'tool', status: 'completed' }),
      ]),
    ).toBe('idle');
  });

  it('falls back to prompt status when transcript is idle', () => {
    expect(selectDaemonStreamingState([], 'waiting')).toBe('waiting');
    expect(selectDaemonStreamingState([], 'streaming')).toBe('responding');
    expect(
      selectDaemonStreamingState([block({ kind: 'tool', status: 'running' })]),
    ).toBe('responding');
    expect(
      selectDaemonStreamingState(
        [block({ kind: 'tool', status: 'running' })],
        'idle',
      ),
    ).toBe('idle');
    expect(
      selectDaemonStreamingState(
        [block({ kind: 'thought', text: 'thinking', streaming: true })],
        'waiting',
      ),
    ).toBe('thinking');
  });
});

function block(
  input: Partial<DaemonTranscriptBlock> & Pick<DaemonTranscriptBlock, 'kind'>,
): DaemonTranscriptBlock {
  return {
    id: 'block',
    text: '',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  } as DaemonTranscriptBlock;
}

function asToolBlock(block: DaemonTranscriptBlock): DaemonToolTranscriptBlock {
  return block as DaemonToolTranscriptBlock;
}
