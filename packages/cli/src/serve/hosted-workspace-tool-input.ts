/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #15076: the argument checks for the two tools only the `/3` profiles
// declare. They run before the Runtime is acquired, so a malformed call
// costs no durable work and its refusal stays model-correctable. The exact
// rules stay in the core tools (WebFetchTool, TodoWriteTool); these checks
// keep the shapes those tools reject from reaching a Runtime round trip.

/** The longest URL a Hosted `web_fetch` accepts, in bytes. */
export const HOSTED_WEB_FETCH_URL_MAX_BYTES = 2048;

/** The content formats `web_fetch` accepts, as the core tool declares them. */
const WEB_FETCH_FORMATS = new Set(['auto', 'markdown', 'html', 'text']);

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

const TODO_ID_MAX_LENGTH = 500;

export interface HostedToolInputCheck {
  input: Record<string, unknown>;
  error?: string;
}

/**
 * Checks a `web_fetch` call. The URL is dispatched as trimmed, and only the
 * three declared keys survive: a call carrying an undeclared argument is a
 * schema confusion the profile refuses rather than forwards.
 */
export function checkHostedWebFetchInput(
  args: Record<string, unknown>,
): HostedToolInputCheck {
  const input: Record<string, unknown> = { ...args };
  const unsupported = Object.keys(args).find(
    (key) => !['url', 'prompt', 'format'].includes(key),
  );
  if (unsupported !== undefined)
    return {
      input,
      error: `Hosted web_fetch received unsupported argument ${JSON.stringify(unsupported)}. Correct the arguments and retry.`,
    };
  const rawUrl = args['url'];
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '')
    return {
      input,
      error:
        'Hosted web_fetch requires a nonempty url. Correct the arguments and retry.',
    };
  const url = rawUrl.trim();
  input['url'] = url;
  if (Buffer.byteLength(url, 'utf8') > HOSTED_WEB_FETCH_URL_MAX_BYTES)
    return {
      input,
      error: `Hosted web_fetch accepts urls up to ${HOSTED_WEB_FETCH_URL_MAX_BYTES} bytes. Shorten the url and retry.`,
    };
  if (!/^https?:\/\//i.test(url))
    return {
      input,
      error:
        'Hosted web_fetch requires a url starting with http:// or https://. Correct the arguments and retry.',
    };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      input,
      error: 'Hosted web_fetch received a malformed url. Correct it and retry.',
    };
  }
  // Credentials in the URL would travel to the Runtime's logs and to the
  // remote host; the tool has no way to authenticate anyway.
  if (parsed.username || parsed.password)
    return {
      input,
      error:
        'Hosted web_fetch does not accept a url with embedded credentials. Remove them and retry.',
    };
  const prompt = args['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '')
    return {
      input,
      error:
        'Hosted web_fetch requires a nonempty prompt. Correct the arguments and retry.',
    };
  const format = args['format'];
  if (format !== undefined && !WEB_FETCH_FORMATS.has(format as string))
    return {
      input,
      error:
        'Hosted web_fetch format must be one of auto, markdown, html or text. Correct the arguments and retry.',
    };
  return { input };
}

/**
 * Checks a `todo_write` call. The list must be an array of items the core
 * tool accepts. A dependency cycle and a blocked item's own state are left to
 * the tool: it owns the rules and reports them with its own message.
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
