import type { ACPToolCall, TodoItem } from '../adapters/types';

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
