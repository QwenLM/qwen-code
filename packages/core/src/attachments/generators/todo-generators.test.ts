/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WRITE_TODOS_TOOL_NAME } from '../../tools/tool-names.js';
import type { Todo } from '../../tools/tools.js';
import type {
  Message,
  ContentBlock,
} from '../../protocol/transcript/message.js';
import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import {
  extractTodosFromHistory,
  getTodoReminderAttachments,
} from './todo-generators.js';

function assistantMessage(content: ContentBlock[]): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: crypto.randomUUID(),

      content,

      model: 'test-model',
      stop_reason: null,

      usage: cloneUsage(),
    },
  };
}

function todoWriteMessage(todos: Todo[]): Message {
  return assistantMessage([
    {
      type: 'tool_use',
      id: crypto.randomUUID(),
      name: WRITE_TODOS_TOOL_NAME,
      input: { todos },
    },
  ]);
}

function idleAssistantTurns(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    assistantMessage([{ type: 'text', text: `turn ${i}` }]),
  );
}

describe('getTodoReminderAttachments', () => {
  it('does not resurrect a todo list with only terminal items', () => {
    const terminalTodos: Todo[] = [
      { description: 'First task', status: 'completed' },
      { description: 'Second task', status: 'cancelled' },
    ];
    const messages = [
      todoWriteMessage(terminalTodos),
      ...idleAssistantTurns(10),
    ];

    expect(extractTodosFromHistory(messages)).toEqual([]);
    expect(getTodoReminderAttachments(messages, true)).toEqual([]);
  });

  it('only reminds for non-terminal items in a stale todo list', () => {
    const todos: Todo[] = [
      { description: 'Done task', status: 'completed' },
      { description: 'Next task', status: 'pending' },
      { description: 'Dropped task', status: 'cancelled' },
      { description: 'Blocked task', status: 'blocked' },
    ];
    const messages = [todoWriteMessage(todos), ...idleAssistantTurns(10)];
    const nonTerminalTodos: Todo[] = [
      { description: 'Next task', status: 'pending' },
      { description: 'Blocked task', status: 'blocked' },
    ];

    expect(getTodoReminderAttachments(messages, true)).toEqual([
      {
        type: 'todo_reminder',
        content: nonTerminalTodos,
        itemCount: 2,
      },
    ]);
  });
});
