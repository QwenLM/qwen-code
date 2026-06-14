import type { ACPToolCall, Message, TodoItem } from '../adapters/types';

/**
 * The todo tool is registered as `todo_write` on the wire, but older paths and
 * the ACP plan bridge use `todowrite`. Match both so detection never hinges on
 * the (unrelated) tool `kind`, which is `think` for this tool.
 */
export function isTodoWriteToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'todo_write' || normalized === 'todowrite';
}

export function parseTodoItemsFromEntries(
  entries: readonly unknown[],
): TodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): TodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    return [
      {
        id: getString(item, 'id') ?? `plan-${index}`,
        content,
        status: getTodoStatus(getString(item, 'status')),
        priority: getTodoPriority(getString(item, 'priority')),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

export function extractTodosFromToolCall(
  tool: ACPToolCall,
): TodoItem[] | undefined {
  if (!isTodoWriteToolName(tool.toolName) && tool.kind !== 'other') {
    return undefined;
  }

  const argsTodos = getTodoArray(tool.args);
  if (argsTodos) {
    return parseTodoItemsFromEntries(argsTodos);
  }

  const rawOutput = getRecord(tool.rawOutput);
  const outputTodos = getTodoArray(rawOutput);
  if (outputTodos) {
    return parseTodoItemsFromEntries(outputTodos);
  }

  const entries = Array.isArray(rawOutput?.['entries'])
    ? rawOutput['entries']
    : undefined;
  return entries ? parseTodoItemsFromEntries(entries) : undefined;
}

export function hasActiveTodos(todos: readonly TodoItem[]): boolean {
  return todos.some(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );
}

export function getTodoStatusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '●';
    case 'in_progress':
      return '◐';
    case 'pending':
      return '○';
  }
}

export interface FloatingTodosState {
  todos: TodoItem[];
  /** Every item is completed — the panel shows a transient "all done" state. */
  allCompleted: boolean;
  /** Transcript message the latest todo update came from. */
  sourceMessageId: string | null;
  /** Tool call id within the source message, when it came from a tool call. */
  sourceCallId: string | null;
}

const EMPTY_FLOATING_TODOS: FloatingTodosState = {
  todos: [],
  allCompleted: false,
  sourceMessageId: null,
  sourceCallId: null,
};

export function getFloatingTodos(
  messages: readonly Message[],
): FloatingTodosState {
  let todos: TodoItem[] = [];
  let sourceMessageId: string | null = null;
  let sourceCallId: string | null = null;
  let userMessageAfter = false;

  for (const message of messages) {
    if (message.role === 'user') {
      userMessageAfter = true;
      continue;
    }
    if (message.role === 'plan') {
      todos = message.todos;
      sourceMessageId = message.id;
      sourceCallId = null;
      userMessageAfter = false;
      continue;
    }
    if (message.role !== 'tool_group') continue;

    for (const tool of message.tools) {
      const nextTodos = extractTodosFromToolCall(tool);
      if (nextTodos) {
        todos = nextTodos;
        sourceMessageId = message.id;
        sourceCallId = tool.callId;
        userMessageAfter = false;
      }
    }
  }

  if (todos.length === 0) return EMPTY_FLOATING_TODOS;
  const allCompleted = !hasActiveTodos(todos);
  // A finished list stays visible (the "all done" moment) only until the
  // user sends the next prompt.
  if (allCompleted && userMessageAfter) return EMPTY_FLOATING_TODOS;
  return { todos, allCompleted, sourceMessageId, sourceCallId };
}

/** A status transition surfaced for a single todo snapshot. */
export interface TodoEvent {
  kind: 'started' | 'completed';
  id: string;
  content: string;
}

/** What changed in one todo snapshot relative to the conversation so far. */
export interface TodoSnapshotDiff {
  events: TodoEvent[];
}

interface TodoSnapshot {
  /** Key the diff is stored under: tool callId, or plan message id. */
  key: string;
  todos: TodoItem[];
}

/**
 * Identity used to track an item across snapshots. Folds content into the key
 * because todo ids are NOT globally unique: the ACP bridge assigns positional
 * ids (`plan-0`, `plan-1`, …) and models restart numbering at `1, 2, 3` for each
 * new `todo_write` plan, so a later, unrelated list reuses an earlier list's
 * ids. Keying on id alone would diff a new plan's items against a previous
 * plan's stale terminal status; id+content keeps distinct tasks separate, and —
 * unlike a user-turn reset — it still tracks a list correctly when it spans
 * turns (a "continue" turn that completes an item carried over from before).
 *
 * Two rare cases this trades for, both only affecting the collapsed diff while
 * the expanded list stays correct:
 * - A todo reworded on a stable id reads as a new task. Reworded while still
 *   `in_progress` it emits a spurious `started`; reworded straight to
 *   `completed` (`1 "Write report"` → `1 "Write the final report" completed`)
 *   the completion is treated as first-seen and dropped.
 * - Two unrelated plans that reuse both the id AND the exact content (a generic
 *   recurring todo like `"Run tests"`) still collide.
 */
function todoStateKey(todo: TodoItem): string {
  return JSON.stringify([todo.id, todo.content]);
}

/**
 * The todo snapshots carried by one message, in order. In the web-shell daemon
 * path todos arrive as `todo_write` tool calls; the ACP bridge instead emits
 * `plan` messages. Handle both so the timeline works regardless of source.
 */
function todoSnapshotsOf(message: Message): TodoSnapshot[] {
  if (message.role === 'plan') {
    return [{ key: message.id, todos: message.todos }];
  }
  if (message.role === 'tool_group') {
    const snapshots: TodoSnapshot[] = [];
    for (const tool of message.tools) {
      const todos = extractTodosFromToolCall(tool);
      if (todos) snapshots.push({ key: tool.callId, todos });
    }
    return snapshots;
  }
  return [];
}

/**
 * Walk the todo snapshots in order and, for each one, derive what changed
 * relative to the running state: which items just started and which just
 * completed.
 *
 * Keyed by snapshot id (tool callId or plan message id) so a history row can
 * look up its own diff. Only transitions actually witnessed produce events — an
 * item first seen already completed (e.g. a restored session's opening
 * snapshot) is recorded silently so its old completion is not replayed as if it
 * just happened.
 */
export function computeTodoTimeline(
  messages: readonly Message[],
): Map<string, TodoSnapshotDiff> {
  const result = new Map<string, TodoSnapshotDiff>();
  const lastStatus = new Map<string, TodoItem['status']>();

  for (const message of messages) {
    for (const { key, todos } of todoSnapshotsOf(message)) {
      const events: TodoEvent[] = [];

      for (const todo of todos) {
        const stateKey = todoStateKey(todo);
        const prev = lastStatus.get(stateKey);
        if (todo.status === 'in_progress' && prev !== 'in_progress') {
          events.push({ kind: 'started', id: todo.id, content: todo.content });
        } else if (
          todo.status === 'completed' &&
          prev !== 'completed' &&
          prev !== undefined
        ) {
          events.push({
            kind: 'completed',
            id: todo.id,
            content: todo.content,
          });
        }
        lastStatus.set(stateKey, todo.status);
      }

      result.set(key, { events });
    }
  }

  return result;
}

/**
 * A cheap signature of the todo snapshots in a transcript: each snapshot's key
 * plus its items' id, status, and content. App memoizes the timeline on this so
 * the context provider value stays referentially stable across unrelated
 * streaming ticks (which would otherwise re-render every todo/plan row that
 * consumes the timeline).
 */
export function todoTimelineSignature(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const { key, todos } of todoSnapshotsOf(message)) {
      parts.push(
        JSON.stringify([key, todos.map((t) => [t.id, t.status, t.content])]),
      );
    }
  }
  return parts.join('\n');
}

export interface TodoWindow {
  start: number;
  end: number;
}

/**
 * Natural-order window of up to maxVisible items anchored on the current
 * item (first in_progress, else first pending): one item of completed
 * context above the anchor, the rest of the budget below it.
 */
export function getTodoWindow(
  todos: readonly TodoItem[],
  maxVisible: number,
): TodoWindow {
  if (todos.length <= maxVisible) return { start: 0, end: todos.length };
  const inProgressIdx = todos.findIndex((t) => t.status === 'in_progress');
  const anchor =
    inProgressIdx >= 0
      ? inProgressIdx
      : todos.findIndex((t) => t.status === 'pending');
  let start = Math.max(0, Math.max(0, anchor) - 1);
  const end = Math.min(todos.length, start + maxVisible);
  start = Math.max(0, end - maxVisible);
  return { start, end };
}

function getTodoArray(
  record: Record<string, unknown> | undefined,
): readonly unknown[] | undefined {
  const todos = record?.['todos'];
  return Array.isArray(todos) ? todos : undefined;
}

function getTodoStatus(value: string | undefined): TodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): TodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
