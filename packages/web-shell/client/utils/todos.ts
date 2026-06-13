import type { ACPToolCall, Message, TodoItem } from '../adapters/types';

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
  const toolName = tool.toolName.toLowerCase();
  if (toolName !== 'todowrite' && tool.kind !== 'other') {
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
