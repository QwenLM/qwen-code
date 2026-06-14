import { describe, expect, it } from 'vitest';
import type { ACPToolCall, Message, TodoItem } from '../adapters/types';
import {
  computeTodoTimeline,
  extractTodosFromToolCall,
  getFloatingTodos,
  getTodoStatusIcon,
  getTodoWindow,
} from './todos';

function todo(id: string, status: TodoItem['status']): TodoItem {
  return { id, content: `task ${id}`, status };
}

function item(
  id: string,
  content: string,
  status: TodoItem['status'],
): TodoItem {
  return { id, content, status };
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
        toolName: 'todo_write',
        status: 'completed',
        kind: 'think',
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

describe('computeTodoTimeline', () => {
  it('emits started and completed events across snapshots', () => {
    const timeline = computeTodoTimeline([
      planMessage('p1', [todo('1', 'in_progress'), todo('2', 'pending')]),
      planMessage('p2', [todo('1', 'completed'), todo('2', 'in_progress')]),
    ]);

    expect(timeline.get('p1')).toEqual({
      events: [{ kind: 'started', id: '1', content: 'task 1' }],
    });
    expect(timeline.get('p2')).toEqual({
      events: [
        { kind: 'completed', id: '1', content: 'task 1' },
        { kind: 'started', id: '2', content: 'task 2' },
      ],
    });
  });

  it('emits a completed event when an item skips in_progress', () => {
    const timeline = computeTodoTimeline([
      planMessage('p1', [todo('1', 'pending')]),
      planMessage('p2', [todo('1', 'completed')]),
    ]);

    expect(timeline.get('p1')?.events).toEqual([]);
    expect(timeline.get('p2')?.events).toEqual([
      { kind: 'completed', id: '1', content: 'task 1' },
    ]);
  });

  it('does not replay completions for items first seen already completed', () => {
    const timeline = computeTodoTimeline([
      planMessage('p1', [todo('1', 'completed'), todo('2', 'in_progress')]),
    ]);

    expect(timeline.get('p1')).toEqual({
      events: [{ kind: 'started', id: '2', content: 'task 2' }],
    });
  });

  it('produces no events for an unchanged re-emitted snapshot', () => {
    const timeline = computeTodoTimeline([
      planMessage('p1', [todo('1', 'in_progress')]),
      planMessage('p2', [todo('1', 'in_progress')]),
    ]);

    expect(timeline.get('p2')?.events).toEqual([]);
  });

  it('tracks todo_write tool-call snapshots, keyed by callId', () => {
    const timeline = computeTodoTimeline([
      todoWriteMessage('m1', [todo('1', 'in_progress')]),
      todoWriteMessage('m2', [todo('1', 'completed')]),
    ]);

    expect(timeline.get('call-m1')?.events).toEqual([
      { kind: 'started', id: '1', content: 'task 1' },
    ]);
    expect(timeline.get('call-m2')?.events).toEqual([
      { kind: 'completed', id: '1', content: 'task 1' },
    ]);
  });

  it('ignores messages that carry no todo snapshot', () => {
    const timeline = computeTodoTimeline([
      userMessage('u1'),
      assistantMessage('a1'),
      todoWriteMessage('m1', [todo('1', 'in_progress')]),
    ]);

    expect(timeline.size).toBe(1);
    expect(timeline.get('call-m1')?.events).toEqual([
      { kind: 'started', id: '1', content: 'task 1' },
    ]);
  });

  it('does not diff a reused id against a previous, unrelated plan', () => {
    // Both plans number their first item "1" (positional/per-plan numbering),
    // but they are different tasks. Plan A leaves "1" in_progress; plan B's "1"
    // must still register its own start and completion rather than being
    // suppressed by plan A's stale id-"1" status.
    const timeline = computeTodoTimeline([
      planMessage('a', [item('1', 'Set up project', 'in_progress')]),
      userMessage('u1'),
      planMessage('b1', [item('1', 'Write the report', 'in_progress')]),
      planMessage('b2', [item('1', 'Write the report', 'completed')]),
    ]);

    expect(timeline.get('b1')?.events).toEqual([
      { kind: 'started', id: '1', content: 'Write the report' },
    ]);
    expect(timeline.get('b2')?.events).toEqual([
      { kind: 'completed', id: '1', content: 'Write the report' },
    ]);
  });

  it('tracks the same item across a tool call and a later plan snapshot', () => {
    const timeline = computeTodoTimeline([
      todoWriteMessage('m1', [todo('1', 'in_progress')]),
      planMessage('p1', [todo('1', 'completed')]),
    ]);

    expect(timeline.get('call-m1')?.events).toEqual([
      { kind: 'started', id: '1', content: 'task 1' },
    ]);
    expect(timeline.get('p1')?.events).toEqual([
      { kind: 'completed', id: '1', content: 'task 1' },
    ]);
  });
});

describe('extractTodosFromToolCall', () => {
  function toolCall(overrides: Partial<ACPToolCall>): ACPToolCall {
    return {
      callId: 'c1',
      toolName: 'todo_write',
      status: 'completed',
      kind: 'think',
      ...overrides,
    };
  }

  it('reads todos from args', () => {
    const todos = extractTodosFromToolCall(
      toolCall({ args: { todos: [item('1', 'A', 'pending')] } }),
    );
    expect(todos).toEqual([{ id: '1', content: 'A', status: 'pending' }]);
  });

  it('reads todos from rawOutput.todos', () => {
    const todos = extractTodosFromToolCall(
      toolCall({ rawOutput: { todos: [item('1', 'A', 'in_progress')] } }),
    );
    expect(todos?.map((t) => t.status)).toEqual(['in_progress']);
  });

  it('reads todos from rawOutput.entries', () => {
    const todos = extractTodosFromToolCall(
      toolCall({ rawOutput: { entries: [item('1', 'A', 'completed')] } }),
    );
    expect(todos?.map((t) => t.status)).toEqual(['completed']);
  });

  it('returns undefined for a non-todo tool even if it carries a todos array', () => {
    const todos = extractTodosFromToolCall(
      toolCall({
        toolName: 'read',
        kind: 'read',
        args: { todos: [item('1', 'A', 'pending')] },
      }),
    );
    expect(todos).toBeUndefined();
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
