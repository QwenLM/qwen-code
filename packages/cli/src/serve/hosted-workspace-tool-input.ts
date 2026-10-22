/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #15076: the argument check for the `todo_write` tool only the `/3`
// profiles declare. It runs before the Runtime is acquired, so a malformed
// call costs no durable work and its refusal stays model-correctable. The
// exact rules stay in the core tool (TodoWriteTool); this check keeps the
// shapes that tool rejects from reaching a Runtime round trip.

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

const TODO_ID_MAX_LENGTH = 500;

export interface HostedToolInputCheck {
  input: Record<string, unknown>;
  error?: string;
}

/**
 * Checks a `todo_write` call. Every item's shape is checked here; the
 * list-level rules — duplicate ids, duplicate `blockedBy` references and a
 * dependency cycle — stay with the tool, which reports them with its own
 * message.
 */
export function checkHostedTodoWriteInput(
  args: Record<string, unknown>,
): HostedToolInputCheck {
  const input: Record<string, unknown> = { ...args };
  const unsupported = Object.keys(args).find((key) => key !== 'todos');
  if (unsupported !== undefined)
    return {
      input,
      error: `Hosted todo_write received unsupported argument ${JSON.stringify(unsupported)}. Correct the arguments and retry.`,
    };
  const todos = args['todos'];
  if (!Array.isArray(todos))
    return {
      input,
      error:
        'Hosted todo_write requires a todos array. Correct the arguments and retry.',
    };
  for (const [index, todo] of todos.entries()) {
    if (!todo || typeof todo !== 'object' || Array.isArray(todo))
      return { input, error: todoItemError(index, 'an object') };
    const item = todo as Record<string, unknown>;
    const extra = Object.keys(item).find(
      (key) => !['id', 'content', 'status', 'blockedBy'].includes(key),
    );
    if (extra !== undefined)
      return {
        input,
        error: todoItemError(
          index,
          `no argument other than id, content, status and blockedBy (found ${JSON.stringify(extra)})`,
        ),
      };
    const id = item['id'];
    if (!isTodoId(id))
      return {
        input,
        error: todoItemError(
          index,
          `a nonempty id of at most ${TODO_ID_MAX_LENGTH} characters`,
        ),
      };
    const content = item['content'];
    if (typeof content !== 'string' || content.trim() === '')
      return { input, error: todoItemError(index, 'a nonempty content') };
    if (!TODO_STATUSES.has(item['status'] as string))
      return {
        input,
        error: todoItemError(
          index,
          'a status of pending, in_progress or completed',
        ),
      };
    const blockedBy = item['blockedBy'];
    if (
      blockedBy !== undefined &&
      (!Array.isArray(blockedBy) || !blockedBy.every(isTodoId))
    )
      return {
        input,
        error: todoItemError(
          index,
          `blockedBy as an array of ids, each at most ${TODO_ID_MAX_LENGTH} characters`,
        ),
      };
  }
  return { input };
}

function isTodoId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= TODO_ID_MAX_LENGTH
  );
}

function todoItemError(index: number, expected: string): string {
  return `Hosted todo_write requires item ${index} to have ${expected}. Correct the arguments and retry.`;
}
