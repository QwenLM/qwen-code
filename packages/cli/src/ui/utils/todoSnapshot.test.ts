/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { ToolCallStatus } from '../types.js';
import { getStickyTodos } from './todoSnapshot.js';

function makeTodoToolGroup(
  content: string,
  withId?: number,
): HistoryItem | HistoryItemWithoutId {
  const item = {
    type: 'tool_group' as const,
    tools: [
      {
        callId: `todo-${content}`,
        name: 'TodoWrite',
        description: 'Update todos',
        resultDisplay: {
          type: 'todo_list' as const,
          todos: [
            {
              id: `todo-${content}`,
              content,
              status: 'pending' as const,
            },
          ],
        },
        status: ToolCallStatus.Success,
        confirmationDetails: undefined,
      },
    ],
  };

  if (withId !== undefined) {
    return { ...item, id: withId };
  }

  return item;
}

function makeCustomTodoToolGroup(
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>,
  withId?: number,
): HistoryItem | HistoryItemWithoutId {
  const item = {
    type: 'tool_group' as const,
    tools: [
      {
        callId: 'todo-custom',
        name: 'TodoWrite',
        description: 'Update todos',
        resultDisplay: {
          type: 'todo_list' as const,
          todos,
        },
        status: ToolCallStatus.Success,
        confirmationDetails: undefined,
      },
    ],
  };

  if (withId !== undefined) {
    return { ...item, id: withId };
  }

  return item;
}

function makeEmptyTodoToolGroup(
  withId?: number,
): HistoryItem | HistoryItemWithoutId {
  const item = {
    type: 'tool_group' as const,
    tools: [
      {
        callId: 'todo-clear',
        name: 'TodoWrite',
        description: 'Clear todos',
        resultDisplay: {
          type: 'todo_list' as const,
          todos: [],
        },
        status: ToolCallStatus.Success,
        confirmationDetails: undefined,
      },
    ],
  };

  if (withId !== undefined) {
    return { ...item, id: withId };
  }

  return item;
}

function makeGeminiHistoryItem(text: string, id: number): HistoryItem {
  return {
    type: 'gemini',
    id,
    text,
  };
}

describe('getStickyTodos', () => {
  it('returns the latest todo snapshot from history', () => {
    const history = [
      makeTodoToolGroup('first task', 1),
      makeTodoToolGroup('latest history task', 2),
      makeGeminiHistoryItem('First response after todo', 3),
      makeGeminiHistoryItem('Second response after todo', 4),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toEqual([
      {
        id: 'todo-latest history task',
        content: 'latest history task',
        status: 'pending',
      },
    ]);
  });

  it('does not show sticky todos while a pending todo snapshot is visible', () => {
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      makeTodoToolGroup('pending task'),
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toBeNull();
  });

  it('returns null when the latest todo snapshot clears the list', () => {
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      makeEmptyTodoToolGroup(),
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toBeNull();
  });

  it('keeps sticky todos hidden when the latest history todo is still the newest item', () => {
    const history = [
      makeGeminiHistoryItem('Earlier response', 1),
      makeTodoToolGroup('latest history task', 2),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toBeNull();
  });

  it('keeps sticky todos hidden when the latest history todo has only one following item', () => {
    const history = [
      makeTodoToolGroup('latest history task', 1),
      makeGeminiHistoryItem('One response after todo', 2),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toBeNull();
  });

  it('shows sticky todos once later history has likely moved the inline todo away', () => {
    const history = [
      makeTodoToolGroup('latest history task', 1),
      makeGeminiHistoryItem('First response after todo', 2),
      makeGeminiHistoryItem('Second response after todo', 3),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toEqual([
      {
        id: 'todo-latest history task',
        content: 'latest history task',
        status: 'pending',
      },
    ]);
  });

  it('returns null when the latest history todo snapshot is fully completed', () => {
    const history = [
      makeCustomTodoToolGroup(
        [
          {
            id: 'todo-1',
            content: 'Run tests',
            status: 'completed',
          },
          {
            id: 'todo-2',
            content: 'Summarize results',
            status: 'completed',
          },
        ],
        1,
      ),
      makeGeminiHistoryItem('First response after todo', 2),
      makeGeminiHistoryItem('Second response after todo', 3),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toBeNull();
  });

  it('keeps sticky todos hidden for a completed pending snapshot', () => {
    const history = [
      makeTodoToolGroup('older history task', 1),
    ] as HistoryItem[];
    const pendingHistoryItems = [
      makeCustomTodoToolGroup([
        {
          id: 'todo-1',
          content: 'Run tests',
          status: 'completed',
        },
        {
          id: 'todo-2',
          content: 'Summarize results',
          status: 'completed',
        },
      ]),
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toBeNull();
  });
});
