import { describe, expect, it } from 'vitest';
import type { Message, TodoItem } from '../adapters/types';
import { getFloatingTodos, getTodoStatusIcon, getTodoWindow } from './todos';

function todo(id: string, status: TodoItem['status']): TodoItem {
  return { id, content: `task ${id}`, status };
}

function planMessage(id: string, todos: TodoItem[]): Message {
  return { id, role: 'plan', todos };
}

function todoWriteMessage(id: string, todos: TodoItem[]): Message {
  return {
    id,
    role: 'tool_group',
    tools: [
      {
        callId: `call-${id}`,
        toolName: 'TodoWrite',
        status: 'completed',
        args: { todos },
      },
    ],
  };
}

function userMessage(id: string): Message {
  return { id, role: 'user', content: 'hello' };
}

function assistantMessage(id: string): Message {
  return { id, role: 'assistant', content: 'working on it' };
}

describe('getFloatingTodos', () => {
  it('returns the empty state when no messages carry todos', () => {
    expect(
      getFloatingTodos([userMessage('u1'), assistantMessage('a1')]),
    ).toEqual({
      todos: [],
      allCompleted: false,
      sourceMessageId: null,
      sourceCallId: null,
    });
  });

  it('returns the latest active list with its source ids', () => {
    const first = [todo('1', 'in_progress')];
    const second = [todo('1', 'completed'), todo('2', 'in_progress')];
    const state = getFloatingTodos([
      todoWriteMessage('m1', first),
      todoWriteMessage('m2', second),
    ]);
    expect(state.todos.map((t) => t.id)).toEqual(['1', '2']);
    expect(state.allCompleted).toBe(false);
    expect(state.sourceMessageId).toBe('m2');
    expect(state.sourceCallId).toBe('call-m2');
  });

  it('uses a null sourceCallId for plan messages', () => {
    const state = getFloatingTodos([planMessage('p1', [todo('1', 'pending')])]);
    expect(state.sourceMessageId).toBe('p1');
    expect(state.sourceCallId).toBeNull();
  });

  it('keeps an active list visible across later user messages', () => {
    const state = getFloatingTodos([
      todoWriteMessage('m1', [todo('1', 'in_progress')]),
      userMessage('u1'),
    ]);
    expect(state.todos).toHaveLength(1);
    expect(state.allCompleted).toBe(false);
  });

  it('returns an all-completed list until the next user message', () => {
    const done = [todo('1', 'completed'), todo('2', 'completed')];
    const visible = getFloatingTodos([
      todoWriteMessage('m1', done),
      assistantMessage('a1'),
    ]);
    expect(visible.todos).toHaveLength(2);
    expect(visible.allCompleted).toBe(true);

    const hidden = getFloatingTodos([
      todoWriteMessage('m1', done),
      userMessage('u1'),
    ]);
    expect(hidden.todos).toHaveLength(0);
  });

  it('shows a new active list started after a finished one', () => {
    const state = getFloatingTodos([
      todoWriteMessage('m1', [todo('1', 'completed')]),
      userMessage('u1'),
      todoWriteMessage('m2', [todo('2', 'pending')]),
    ]);
    expect(state.todos.map((t) => t.id)).toEqual(['2']);
    expect(state.sourceMessageId).toBe('m2');
  });

  it('ignores user messages sent before the todo update', () => {
    const state = getFloatingTodos([
      userMessage('u1'),
      todoWriteMessage('m1', [todo('1', 'completed')]),
    ]);
    expect(state.todos).toHaveLength(1);
    expect(state.allCompleted).toBe(true);
  });

  it('clears the panel when a plan message empties the list', () => {
    const state = getFloatingTodos([
      todoWriteMessage('m1', [todo('1', 'in_progress')]),
      planMessage('p1', []),
    ]);
    expect(state.todos).toHaveLength(0);
  });

  it('returns a completed list from a plan with all-completed todos', () => {
    // Unlike the old App.tsx helper (which cleared the panel for an
    // all-completed plan), the list is retained so the "all done" moment can
    // render; App's todoPanelMode then decides whether to show it.
    const state = getFloatingTodos([
      planMessage('p1', [todo('1', 'completed'), todo('2', 'completed')]),
    ]);
    expect(state.todos).toHaveLength(2);
    expect(state.allCompleted).toBe(true);
    expect(state.sourceMessageId).toBe('p1');
  });
});

describe('getTodoStatusIcon', () => {
  it('maps each status to its glyph', () => {
    expect(getTodoStatusIcon('completed')).toBe('●');
    expect(getTodoStatusIcon('in_progress')).toBe('◐');
    expect(getTodoStatusIcon('pending')).toBe('○');
  });
});

describe('getTodoWindow', () => {
  const statuses = (list: Array<TodoItem['status']>): TodoItem[] =>
    list.map((status, i) => todo(String(i + 1), status));

  it('shows everything when the list fits', () => {
    const todos = statuses(['completed', 'in_progress', 'pending']);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 0, end: 3 });
  });

  it('anchors on the in_progress item with one completed line above', () => {
    const todos = statuses([
      'completed',
      'completed',
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 2, end: 7 });
  });

  it('starts at the top when the anchor is the first item', () => {
    const todos = statuses([
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 0, end: 5 });
  });

  it('backfills the window when the anchor is near the end', () => {
    const todos = statuses([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'in_progress',
    ]);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 3, end: 8 });
  });

  it('anchors on the first pending item when nothing is in progress', () => {
    const todos = statuses([
      'completed',
      'completed',
      'completed',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 2, end: 7 });
  });

  it('falls back to the head of the list when everything is completed', () => {
    const todos = statuses([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(getTodoWindow(todos, 5)).toEqual({ start: 0, end: 5 });
  });
});
