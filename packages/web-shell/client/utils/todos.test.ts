import { describe, expect, it } from 'vitest';
import { normalizeDaemonEvent } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message, TodoItem } from '../adapters/types';
import {
  computeTodoDetails,
  computeTodoTimeline,
  extractTodoStats,
  extractTodosFromToolCall,
  getFloatingTodos,
  getTodoStatusIcon,
  getTodoWindow,
  isTodoWriteToolName,
  todoDetailSignature,
  todoStateKey,
  todoTimelineSignature,
  type TodoStatsSnapshot,
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

function todoWriteMessage(
  id: string,
  todos: TodoItem[],
  stats?: TodoStatsSnapshot,
): Message {
  const tool: ACPToolCall = {
    callId: `call-${id}`,
    toolName: 'todo_write',
    status: 'completed',
    kind: 'think',
    args: { todos },
    ...(stats ? { rawOutput: { stats } } : {}),
  };
  return { id, role: 'tool_group', tools: [tool] };
}

/** A non-todo tool call carrying a wall-clock span, used for tool-time tests. */
function toolMessage(
  id: string,
  startTime: number,
  endTime: number,
  toolName = 'read',
): Message {
  return {
    id,
    role: 'tool_group',
    tools: [
      {
        callId: `tc-${id}`,
        toolName,
        status: 'completed',
        kind: 'read',
        startTime,
        endTime,
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

  it('tracks an item that carries over and completes in a later turn', () => {
    // id+content keys the same task across a user turn, so a "continue" turn
    // that finishes a carried-over item still surfaces the completion (a
    // user-turn reset would drop this).
    const timeline = computeTodoTimeline([
      planMessage('p1', [item('1', 'Build feature', 'in_progress')]),
      userMessage('u1'),
      planMessage('p2', [item('1', 'Build feature', 'completed')]),
    ]);

    expect(timeline.get('p2')?.events).toEqual([
      { kind: 'completed', id: '1', content: 'Build feature' },
    ]);
  });

  // Documented limitation of id+content keying: a mid-task reword reads as a new
  // task, so its completion is treated as first-seen and omitted from the diff.
  it('omits the completion when a todo is reworded on the same id (known gap)', () => {
    const timeline = computeTodoTimeline([
      planMessage('p1', [item('1', 'Write report', 'in_progress')]),
      planMessage('p2', [item('1', 'Write the final report', 'completed')]),
    ]);

    expect(timeline.get('p2')?.events).toEqual([]);
  });

  // Documented limitation: two unrelated plans reusing both id AND content
  // collide, so the second plan's completion is suppressed.
  it('collides when unrelated plans reuse the same id and content (known gap)', () => {
    const timeline = computeTodoTimeline([
      planMessage('a', [item('1', 'Run tests', 'completed')]),
      userMessage('u1'),
      planMessage('b', [item('1', 'Run tests', 'completed')]),
    ]);

    expect(timeline.get('b')?.events).toEqual([]);
  });
});

describe('todoTimelineSignature', () => {
  it('is unchanged by edits to non-todo messages', () => {
    const a = todoTimelineSignature([
      planMessage('p1', [todo('1', 'in_progress')]),
      assistantMessage('a1'),
    ]);
    const b = todoTimelineSignature([
      planMessage('p1', [todo('1', 'in_progress')]),
      { id: 'a1', role: 'assistant', content: 'different text' },
    ]);
    expect(b).toBe(a);
  });

  it('changes when an item id, status, or content changes', () => {
    const base = todoTimelineSignature([
      planMessage('p1', [todo('1', 'in_progress')]),
    ]);
    const status = todoTimelineSignature([
      planMessage('p1', [todo('1', 'completed')]),
    ]);
    const id = todoTimelineSignature([
      planMessage('p1', [todo('2', 'in_progress')]),
    ]);
    const content = todoTimelineSignature([
      planMessage('p1', [item('1', 'reworded', 'in_progress')]),
    ]);
    expect(status).not.toBe(base);
    expect(id).not.toBe(base);
    expect(content).not.toBe(base);
  });

  it('is empty for a transcript with no todo snapshots', () => {
    expect(todoTimelineSignature([])).toBe('');
    expect(todoTimelineSignature([userMessage('u1')])).toBe('');
  });
});

describe('isTodoWriteToolName', () => {
  it.each(['todo_write', 'todowrite', 'TodoWrite', 'TODO_WRITE'])(
    'matches %s',
    (name) => {
      expect(isTodoWriteToolName(name)).toBe(true);
    },
  );

  it.each(['read', 'edit', 'write_file', ''])('rejects %s', (name) => {
    expect(isTodoWriteToolName(name)).toBe(false);
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

function stats(
  promptTokens: number,
  cachedTokens: number,
  candidateTokens: number,
  apiTimeMs: number,
): TodoStatsSnapshot {
  return { promptTokens, cachedTokens, candidateTokens, apiTimeMs };
}

const at = (message: Message, timestamp: number): Message => ({
  ...message,
  timestamp,
});

describe('extractTodoStats', () => {
  function toolCall(rawOutput: unknown): ACPToolCall {
    return {
      callId: 'c1',
      toolName: 'todo_write',
      status: 'completed',
      kind: 'think',
      rawOutput,
    };
  }

  it('reads a complete stats snapshot from rawOutput', () => {
    expect(
      extractTodoStats(
        toolCall({
          stats: {
            promptTokens: 1,
            cachedTokens: 2,
            candidateTokens: 3,
            apiTimeMs: 4,
          },
        }),
      ),
    ).toEqual({
      promptTokens: 1,
      cachedTokens: 2,
      candidateTokens: 3,
      apiTimeMs: 4,
    });
  });

  it('returns undefined when stats is absent', () => {
    expect(extractTodoStats(toolCall({ entries: [] }))).toBeUndefined();
  });

  it('returns undefined when a token field is missing or non-numeric', () => {
    expect(
      extractTodoStats(
        toolCall({
          // candidateTokens missing
          stats: { promptTokens: 1, cachedTokens: 2, apiTimeMs: 4 },
        }),
      ),
    ).toBeUndefined();
    expect(
      extractTodoStats(
        toolCall({
          stats: {
            promptTokens: '1', // non-numeric
            cachedTokens: 2,
            candidateTokens: 3,
            apiTimeMs: 4,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('defaults the live-only apiTimeMs to 0 when omitted, keeping the tokens', () => {
    expect(
      extractTodoStats(
        toolCall({
          stats: { promptTokens: 1, cachedTokens: 2, candidateTokens: 3 },
        }),
      ),
    ).toEqual({
      promptTokens: 1,
      cachedTokens: 2,
      candidateTokens: 3,
      apiTimeMs: 0,
    });
  });

  it('treats a non-finite apiTimeMs as 0 rather than dropping the snapshot', () => {
    expect(
      extractTodoStats(
        toolCall({
          stats: {
            promptTokens: 1,
            cachedTokens: 2,
            candidateTokens: 3,
            apiTimeMs: Number.NaN,
          },
        }),
      ),
    ).toEqual({
      promptTokens: 1,
      cachedTokens: 2,
      candidateTokens: 3,
      apiTimeMs: 0,
    });
  });
});

describe('computeTodoDetails', () => {
  it('records start and end timestamps from the transcript with no stats', () => {
    const details = computeTodoDetails([
      at(planMessage('p1', [todo('1', 'in_progress')]), 1000),
      at(planMessage('p2', [todo('1', 'completed')]), 5000),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))).toEqual({
      startTs: 1000,
      endTs: 5000,
    });
  });

  it('derives token and API resources from the diff of the boundary snapshots', () => {
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'm1',
          [todo('1', 'in_progress')],
          stats(100, 10, 20, 500),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'm2',
          [todo('1', 'completed')],
          stats(300, 40, 80, 1500),
        ),
        5000,
      ),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))).toEqual({
      startTs: 1000,
      endTs: 5000,
      resources: {
        inputTokens: 200,
        cachedTokens: 30,
        outputTokens: 60,
        apiTimeMs: 1000,
      },
    });
  });

  it('omits token resources when the start boundary has no stamped snapshot', () => {
    const details = computeTodoDetails([
      at(todoWriteMessage('m1', [todo('1', 'in_progress')]), 1000),
      at(
        todoWriteMessage(
          'm2',
          [todo('1', 'completed')],
          stats(300, 40, 80, 1500),
        ),
        5000,
      ),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))).toEqual({
      startTs: 1000,
      endTs: 5000,
    });
  });

  it('clamps an individually shrinking token field to zero', () => {
    // Tokens shrink (clamp to 0) while API time grows, so the diff is not
    // all-zero and stays surfaced — exercising the per-field clamp.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'm1',
          [todo('1', 'in_progress')],
          stats(300, 40, 80, 1500),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'm2',
          [todo('1', 'completed')],
          stats(100, 10, 20, 1600),
        ),
        5000,
      ),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))?.resources).toEqual({
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      apiTimeMs: 100,
    });
  });

  it('treats an all-zero token diff as not captured, keeping the timestamps', () => {
    // Equal (or fully shrinking) snapshots measure nothing; the task still
    // shows start/end but no misleading row of zeros.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'm1',
          [todo('1', 'in_progress')],
          stats(300, 40, 80, 1500),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'm2',
          [todo('1', 'completed')],
          stats(100, 10, 20, 500),
        ),
        5000,
      ),
    ]);
    const detail = details.get(todoStateKey(todo('1', 'pending')));
    expect(detail?.startTs).toBe(1000);
    expect(detail?.endTs).toBe(5000);
    expect(detail?.resources).toBeUndefined();
  });

  it('omits API time when the diff did not advance it (resume path)', () => {
    // Replayed sessions carry token counts but not per-turn durations, so the
    // API time component stays flat and is dropped while tokens still show.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'm1',
          [todo('1', 'in_progress')],
          stats(100, 0, 0, 500),
        ),
        1000,
      ),
      at(
        todoWriteMessage('m2', [todo('1', 'completed')], stats(300, 0, 0, 500)),
        5000,
      ),
    ]);
    const resources = details.get(
      todoStateKey(todo('1', 'pending')),
    )?.resources;
    expect(resources?.inputTokens).toBe(200);
    expect(resources?.apiTimeMs).toBeUndefined();
  });

  it('spans intermediate snapshots while a task stays in progress', () => {
    // First start (m1) and completion (m3) bound the window; the middle
    // boundary (m2) does not affect the cumulative diff.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'm1',
          [todo('1', 'in_progress')],
          stats(100, 0, 0, 100),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'm2',
          [todo('1', 'in_progress')],
          stats(300, 0, 0, 500),
        ),
        3000,
      ),
      at(
        todoWriteMessage('m3', [todo('1', 'completed')], stats(500, 0, 0, 900)),
        5000,
      ),
    ]);
    const detail = details.get(todoStateKey(todo('1', 'pending')));
    expect(detail?.startTs).toBe(1000);
    expect(detail?.endTs).toBe(5000);
    expect(detail?.resources?.inputTokens).toBe(400);
    expect(detail?.resources?.apiTimeMs).toBe(800);
  });

  it('sums tool time from transcript tool spans started within the window', () => {
    const details = computeTodoDetails([
      toolMessage('t0', 100, 500), // before the window
      at(todoWriteMessage('m1', [todo('1', 'in_progress')]), 1000),
      toolMessage('t1', 2000, 2500), // within: 500ms
      at(todoWriteMessage('m2', [todo('1', 'completed')]), 5000),
      toolMessage('t2', 6000, 9000), // after the window
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))?.resources).toEqual({
      toolTimeMs: 500,
    });
  });

  it('yields no detail for an item first seen already completed', () => {
    const details = computeTodoDetails([
      at(planMessage('p1', [todo('1', 'completed')]), 1000),
    ]);
    expect(details.has(todoStateKey(todo('1', 'pending')))).toBe(false);
  });

  it('records an end with no start when an item skips in_progress', () => {
    const details = computeTodoDetails([
      at(planMessage('p1', [todo('1', 'pending')]), 1000),
      at(planMessage('p2', [todo('1', 'completed')]), 5000),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))).toEqual({
      endTs: 5000,
    });
  });

  it('starts a fresh window when a completed id+content is reused by a new task', () => {
    // The ACP bridge reuses positional ids across plans, so two unrelated tasks
    // can share id+content. The second occurrence must diff against its own
    // start (plan B: 900→1000, 5000→5200) — not plan A's far-earlier boundary,
    // which would render a cross-plan window with inflated numbers.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'a1',
          [item('1', 'Run tests', 'in_progress')],
          stats(100, 0, 0, 100),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'a2',
          [item('1', 'Run tests', 'completed')],
          stats(200, 0, 0, 300),
        ),
        2000,
      ),
      userMessage('u1'),
      at(
        todoWriteMessage(
          'b1',
          [item('1', 'Run tests', 'in_progress')],
          stats(900, 0, 0, 5000),
        ),
        8000,
      ),
      at(
        todoWriteMessage(
          'b2',
          [item('1', 'Run tests', 'completed')],
          stats(1000, 0, 0, 5200),
        ),
        9000,
      ),
    ]);
    const detail = details.get(
      todoStateKey(item('1', 'Run tests', 'completed')),
    );
    expect(detail?.startTs).toBe(8000);
    expect(detail?.endTs).toBe(9000);
    expect(detail?.resources?.inputTokens).toBe(100);
    expect(detail?.resources?.apiTimeMs).toBe(200);
  });

  it('resets the window when a task reopens via pending (completed → pending → in_progress)', () => {
    // The intervening `pending` makes prev `pending` (not `completed`) at the
    // re-activation, so this relies on the "ever completed" tracking; the
    // reopened run must diff its own window (900→1000, 5000→5200), not span
    // back to the original start.
    const details = computeTodoDetails([
      at(
        todoWriteMessage(
          'a1',
          [item('1', 'Build', 'in_progress')],
          stats(100, 0, 0, 100),
        ),
        1000,
      ),
      at(
        todoWriteMessage(
          'a2',
          [item('1', 'Build', 'completed')],
          stats(200, 0, 0, 300),
        ),
        2000,
      ),
      at(todoWriteMessage('a3', [item('1', 'Build', 'pending')]), 3000),
      at(
        todoWriteMessage(
          'a4',
          [item('1', 'Build', 'in_progress')],
          stats(900, 0, 0, 5000),
        ),
        8000,
      ),
      at(
        todoWriteMessage(
          'a5',
          [item('1', 'Build', 'completed')],
          stats(1000, 0, 0, 5200),
        ),
        9000,
      ),
    ]);
    const detail = details.get(todoStateKey(item('1', 'Build', 'completed')));
    expect(detail?.startTs).toBe(8000);
    expect(detail?.endTs).toBe(9000);
    expect(detail?.resources?.inputTokens).toBe(100);
    expect(detail?.resources?.apiTimeMs).toBe(200);
  });

  it('upgrades a stats-less start baseline to a later snapshot that has stats', () => {
    // A `plan`-message start carries no stats (the baseline is stored as
    // undefined); a later in_progress snapshot with real stats must become the
    // baseline, which a plain Map.has guard would block.
    const details = computeTodoDetails([
      at(planMessage('p1', [item('1', 'X', 'in_progress')]), 1000),
      at(planMessage('p2', [item('1', 'X', 'pending')]), 2000),
      at(
        todoWriteMessage(
          'm1',
          [item('1', 'X', 'in_progress')],
          stats(100, 0, 0, 500),
        ),
        3000,
      ),
      at(
        todoWriteMessage(
          'm2',
          [item('1', 'X', 'completed')],
          stats(300, 0, 0, 900),
        ),
        5000,
      ),
    ]);
    const detail = details.get(todoStateKey(item('1', 'X', 'completed')));
    expect(detail?.resources?.inputTokens).toBe(200); // 300 - 100
    expect(detail?.resources?.apiTimeMs).toBe(400); // 900 - 500
  });

  it('sums only tool spans whose start falls within the task window', () => {
    const details = computeTodoDetails([
      toolMessage('t-before', 100, 500),
      at(todoWriteMessage('m1', [todo('1', 'in_progress')]), 1000),
      toolMessage('t-a', 1500, 2000), // 500ms, in window
      toolMessage('t-b', 3000, 3700), // 700ms, in window
      at(todoWriteMessage('m2', [todo('1', 'completed')]), 5000),
      toolMessage('t-after', 6000, 9000),
    ]);
    expect(details.get(todoStateKey(todo('1', 'pending')))?.resources).toEqual({
      toolTimeMs: 1200,
    });
  });
});

describe('plan stats contract (SDK normalizer → extractTodoStats)', () => {
  it('round-trips an agent-stamped _meta.stats into a defined snapshot', () => {
    // Field names mirror what the cli PlanEmitter stamps. Exercising the real
    // SDK normalizer locks the sdk → web-shell hop: if normalizePlanUpdate stops
    // forwarding stats, or extractTodoStats's field names drift from the
    // forwarded shape, this returns undefined and fails here rather than
    // silently rendering "not captured". (The cli field names are pinned
    // separately by PlanEmitter.test.)
    const events = normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Task', status: 'completed', priority: 'medium' },
          ],
          _meta: {
            stats: {
              promptTokens: 100,
              cachedTokens: 10,
              candidateTokens: 20,
              apiTimeMs: 500,
            },
          },
        },
      },
    });
    const rawOutput = (events[0] as { rawOutput?: unknown }).rawOutput;
    const tool: ACPToolCall = {
      callId: 'c',
      toolName: 'TodoWrite',
      status: 'completed',
      kind: 'think',
      rawOutput,
    };
    expect(extractTodoStats(tool)).toEqual({
      promptTokens: 100,
      cachedTokens: 10,
      candidateTokens: 20,
      apiTimeMs: 500,
    });
  });
});

describe('todoDetailSignature', () => {
  it('changes when a snapshot timestamp changes', () => {
    const a = todoDetailSignature([
      at(planMessage('p1', [todo('1', 'in_progress')]), 1000),
    ]);
    const b = todoDetailSignature([
      at(planMessage('p1', [todo('1', 'in_progress')]), 2000),
    ]);
    expect(b).not.toBe(a);
  });

  it('is unchanged by edits to non-todo messages', () => {
    const a = todoDetailSignature([
      at(planMessage('p1', [todo('1', 'in_progress')]), 1000),
      assistantMessage('a1'),
    ]);
    const b = todoDetailSignature([
      at(planMessage('p1', [todo('1', 'in_progress')]), 1000),
      { id: 'a1', role: 'assistant', content: 'different text' },
    ]);
    expect(b).toBe(a);
  });
});
