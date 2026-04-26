/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { ToolCallStatus } from '../types.js';
import {
  getStickyTodos,
  getStickyTodoMaxVisibleItems,
  getStickyTodosLayoutKey,
  getStickyTodosRenderKey,
} from './todoSnapshot.js';

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

describe('getStickyTodos', () => {
  it('returns the latest todo snapshot from history', () => {
    const history = [
      makeTodoToolGroup('first task', 1),
      makeTodoToolGroup('latest history task', 2),
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toEqual([
      {
        id: 'todo-latest history task',
        content: 'latest history task',
        status: 'pending',
      },
    ]);
  });

  it('returns null when pending TodoWrite result is visible (avoids duplicate rendering)', () => {
    // This is the key fix for issue #3638:
    // When a TodoWrite tool has a result in the pending area,
    // the sticky panel should be hidden to avoid duplicate rendering
    // and layout reflows that cause flickering.
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      makeTodoToolGroup('pending task'),
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toBeNull();
  });

  it('returns null when pending TodoWrite result clears the list', () => {
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      makeEmptyTodoToolGroup(),
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toBeNull();
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
    ] as HistoryItem[];

    expect(getStickyTodos(history, [])).toBeNull();
  });

  it('shows history snapshot when pending has non-TodoWrite tool', () => {
    // When pending items don't contain a TodoWrite result,
    // we should show the history snapshot in the sticky panel.
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      {
        type: 'tool_group' as const,
        tools: [
          {
            callId: 'read-file-1',
            name: ToolNames.READ_FILE,
            description: 'Read a file',
            resultDisplay: 'File content here',
            status: ToolCallStatus.Success,
            confirmationDetails: undefined,
          },
        ],
      },
    ] as HistoryItemWithoutId[];

    expect(getStickyTodos(history, pendingHistoryItems)).toEqual([
      {
        id: 'todo-history task',
        content: 'history task',
        status: 'pending',
      },
    ]);
  });

  it('shows history snapshot when pending TodoWrite is executing without result', () => {
    // When TodoWrite is still executing (no result yet),
    // we should hide the sticky panel to prepare for the result.
    const history = [makeTodoToolGroup('history task', 1)] as HistoryItem[];
    const pendingHistoryItems = [
      {
        type: 'tool_group' as const,
        tools: [
          {
            callId: 'todo-executing',
            name: ToolNames.TODO_WRITE,
            description: 'Update todos',
            resultDisplay: undefined, // No result yet
            status: ToolCallStatus.Executing,
            confirmationDetails: undefined,
          },
        ],
      },
    ] as HistoryItemWithoutId[];

    // Should show history snapshot when TodoWrite is executing but no result yet
    expect(getStickyTodos(history, pendingHistoryItems)).toEqual([
      {
        id: 'todo-history task',
        content: 'history task',
        status: 'pending',
      },
    ]);
  });
});

describe('sticky todo render keys', () => {
  it('keeps the layout key stable for status-only updates', () => {
    const pendingTodos = [
      {
        id: 'todo-1',
        content: 'Run focused tests',
        status: 'pending' as const,
      },
    ];
    const inProgressTodos = [
      {
        id: 'todo-1',
        content: 'Run focused tests',
        status: 'in_progress' as const,
      },
    ];

    expect(getStickyTodosLayoutKey(pendingTodos, 64, 5)).toBe(
      getStickyTodosLayoutKey(inProgressTodos, 64, 5),
    );
    expect(getStickyTodosRenderKey(pendingTodos)).not.toBe(
      getStickyTodosRenderKey(inProgressTodos),
    );
  });

  it('changes the layout key when wrapping-sensitive inputs change', () => {
    const todos = [
      {
        id: 'todo-1',
        content: 'Run focused tests',
        status: 'pending' as const,
      },
    ];

    expect(getStickyTodosLayoutKey(todos, 64, 5)).not.toBe(
      getStickyTodosLayoutKey(todos, 40, 5),
    );
    expect(getStickyTodosLayoutKey(todos, 64, 5)).not.toBe(
      getStickyTodosLayoutKey(
        [{ ...todos[0], content: 'Run focused tests and build' }],
        64,
        5,
      ),
    );
    expect(getStickyTodosLayoutKey(todos, 64, 5)).not.toBe(
      getStickyTodosLayoutKey(todos, 64, 2),
    );
  });

  it('derives a bounded sticky todo item count from terminal height', () => {
    expect(getStickyTodoMaxVisibleItems(4)).toBe(1);
    expect(getStickyTodoMaxVisibleItems(12)).toBe(3);
    expect(getStickyTodoMaxVisibleItems(40)).toBe(5);
  });
});
