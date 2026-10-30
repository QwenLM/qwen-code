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

/**
 * The most items one call may carry, and the longest single `content`.
 * Both are declared on the tool as well, so the model sees the same limits
 * the admission check enforces.
 */
export const HOSTED_TODO_MAX_ITEMS = 64;
export const HOSTED_TODO_CONTENT_MAX_CHARS = 1000;
/** The most dependencies one item may name. */
export const HOSTED_TODO_MAX_DEPENDENCIES = 32;
/**
 * The serialized-size ceiling for one incoming list. It keeps an admitted call
 * inside the store's encoded-input limit, so the refusal happens before
 * acquisition. The durable writer applies the same bound after preserving
 * dependencies.
 */
export const HOSTED_TODO_MAX_SERIALIZED_BYTES = 16 * 1024;

export interface HostedToolInputCheck {
  input: Record<string, unknown>;
  error?: string;
}

/**
 * Checks a `todo_write` call. Every item's shape and the list's size are
 * checked here; the list-level rules — duplicate ids, duplicate `blockedBy`
 * references and a dependency cycle — stay with the tool, which reports them
 * with its own message.
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
  if (todos.length > HOSTED_TODO_MAX_ITEMS)
    return {
      input,
      error: `Hosted todo_write accepts at most ${HOSTED_TODO_MAX_ITEMS} todos per call (received ${todos.length}). Send a shorter list and retry.`,
    };
  const cleaned: Array<Record<string, unknown>> = [];
  let strippedNullDependency = false;
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
    // The declaration advertises this ceiling as `maxLength`, which JSON Schema
    // counts in code points; `String.length` counts UTF-16 code units, so it
    // would refuse a schema-valid 1000-code-point string that carries astral
    // characters. The `id` ceiling stays in UTF-16 units because core's own
    // `todo.id.length > 500` counts that way.
    const contentChars = [...content].length;
    if (contentChars > HOSTED_TODO_CONTENT_MAX_CHARS)
      return {
        input,
        error: todoItemError(
          index,
          `content of at most ${HOSTED_TODO_CONTENT_MAX_CHARS} characters (received ${contentChars})`,
        ),
      };
    if (!TODO_STATUSES.has(item['status'] as string))
      return {
        input,
        error: todoItemError(
          index,
          'a status of pending, in_progress or completed',
        ),
      };
    const blockedBy = item['blockedBy'];
    // `null` is the omitted case, as the glob arm treats a null path: a hosted
    // refusal is batch-wide, so refusing it would drop every valid sibling
    // call. The key is removed by rebuilding the item, because `input` is a
    // shallow copy whose items are shared with `call.args`.
    if (
      blockedBy !== undefined &&
      blockedBy !== null &&
      (!Array.isArray(blockedBy) || !blockedBy.every(isTodoId))
    )
      return {
        input,
        error: todoItemError(
          index,
          `blockedBy as an array of ids, each at most ${TODO_ID_MAX_LENGTH} characters`,
        ),
      };
    if (
      Array.isArray(blockedBy) &&
      blockedBy.length > HOSTED_TODO_MAX_DEPENDENCIES
    )
      return {
        input,
        error: todoItemError(
          index,
          `blockedBy of at most ${HOSTED_TODO_MAX_DEPENDENCIES} ids (received ${blockedBy.length})`,
        ),
      };
    if (blockedBy === null) {
      const rest = { ...item };
      delete rest['blockedBy'];
      cleaned.push(rest);
      strippedNullDependency = true;
    } else {
      cleaned.push(item);
    }
  }
  const list = strippedNullDependency ? cleaned : todos;
  const serializedBytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
  if (serializedBytes > HOSTED_TODO_MAX_SERIALIZED_BYTES)
    return {
      input,
      error: `Hosted todo_write accepts a list of at most ${HOSTED_TODO_MAX_SERIALIZED_BYTES} serialized bytes (received ${serializedBytes}). Shorten the list and retry.`,
    };
  return strippedNullDependency
    ? { input: { ...input, todos: cleaned } }
    : { input };
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
