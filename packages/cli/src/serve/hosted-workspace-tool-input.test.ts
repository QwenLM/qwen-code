/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  checkHostedTodoWriteInput,
  HOSTED_TODO_CONTENT_MAX_CHARS,
  HOSTED_TODO_MAX_DEPENDENCIES,
  HOSTED_TODO_MAX_ITEMS,
  HOSTED_TODO_MAX_SERIALIZED_BYTES,
} from './hosted-workspace-tool-input.js';

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'a',
  content: 'first',
  status: 'pending',
  ...overrides,
});

describe('checkHostedTodoWriteInput', () => {
  it('accepts a minimal list and returns the input unchanged', () => {
    const args = { todos: [item()] };
    const check = checkHostedTodoWriteInput(args);
    expect(check.error).toBeUndefined();
    expect(check.input).toEqual(args);
  });

  it('accepts an empty list as a reset', () => {
    expect(checkHostedTodoWriteInput({ todos: [] }).error).toBeUndefined();
  });

  it('accepts an explicit empty blockedBy and a list at every limit', () => {
    const emptyDependencies = { todos: [item({ blockedBy: [] })] };
    const empty = checkHostedTodoWriteInput(emptyDependencies);
    expect(empty.error).toBeUndefined();
    expect(
      (empty.input['todos'] as Array<Record<string, unknown>>)[0]['blockedBy'],
    ).toEqual([]);
    const atLimits = {
      todos: [
        item({
          content: 'x'.repeat(HOSTED_TODO_CONTENT_MAX_CHARS),
          blockedBy: Array.from(
            { length: HOSTED_TODO_MAX_DEPENDENCIES },
            (_, index) => `d${index}`,
          ),
        }),
      ],
    };
    expect(checkHostedTodoWriteInput(atLimits).error).toBeUndefined();
    const atItems = {
      todos: Array.from({ length: HOSTED_TODO_MAX_ITEMS }, (_, index) =>
        item({ id: `i${index}` }),
      ),
    };
    expect(checkHostedTodoWriteInput(atItems).error).toBeUndefined();
    expect(
      checkHostedTodoWriteInput({ todos: [item({ id: 'x'.repeat(500) })] })
        .error,
    ).toBeUndefined();
    const nearCeiling = {
      todos: Array.from({ length: 14 }, (_, index) =>
        item({ id: `c${index}`, content: 'x'.repeat(1000) }),
      ),
    };
    expect(
      Buffer.byteLength(JSON.stringify(nearCeiling.todos), 'utf8'),
    ).toBeLessThanOrEqual(HOSTED_TODO_MAX_SERIALIZED_BYTES);
    expect(checkHostedTodoWriteInput(nearCeiling).error).toBeUndefined();
  });

  it('counts content in code points so astral characters fit the declared ceiling', () => {
    const content = 'x'.repeat(990) + '😀'.repeat(10);
    expect([...content].length).toBe(HOSTED_TODO_CONTENT_MAX_CHARS);
    expect(content.length).toBe(1010);
    expect(
      checkHostedTodoWriteInput({ todos: [item({ content })] }).error,
    ).toBeUndefined();
  });

  it('treats a null blockedBy as omitted without rewriting the caller input', () => {
    const args = { todos: [item({ blockedBy: null })] };
    const check = checkHostedTodoWriteInput(args);
    expect(check.error).toBeUndefined();
    expect(
      (check.input['todos'] as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty('blockedBy');
    expect((args.todos[0] as Record<string, unknown>)['blockedBy']).toBeNull();
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['no todos', {}, 'requires a todos array'],
    ['todos is a string', { todos: 'x' }, 'requires a todos array'],
    ['item is null', { todos: [null] }, 'item 0 to have an object'],
    ['item is a string', { todos: ['step'] }, 'item 0 to have an object'],
    ['item is an array', { todos: [[]] }, 'item 0 to have an object'],
    [
      'extra top-level key',
      { todos: [item()], merge: true },
      'unsupported argument "merge"',
    ],
    [
      'extra item key',
      { todos: [item({ owner: 'x' })] },
      'no argument other than id, content, status and blockedBy',
    ],
    ['empty id', { todos: [item({ id: '' })] }, 'a nonempty id'],
    ['id over 500', { todos: [item({ id: 'x'.repeat(501) })] }, 'at most 500'],
    [
      'whitespace content',
      { todos: [item({ content: '   ' })] },
      'a nonempty content',
    ],
    [
      'content over the cap',
      {
        todos: [
          item({ content: 'x'.repeat(HOSTED_TODO_CONTENT_MAX_CHARS + 1) }),
        ],
      },
      `at most ${HOSTED_TODO_CONTENT_MAX_CHARS} characters`,
    ],
    [
      'bad status',
      { todos: [item({ status: 'done' })] },
      'a status of pending',
    ],
    [
      'blockedBy is a string',
      { todos: [item({ blockedBy: 'b' })] },
      'blockedBy as an array of ids',
    ],
    [
      'blockedBy holds an empty id',
      { todos: [item({ blockedBy: [''] })] },
      'blockedBy as an array of ids',
    ],
    [
      'blockedBy holds a number',
      { todos: [item({ blockedBy: [1] })] },
      'blockedBy as an array of ids',
    ],
    [
      'blockedBy over the cap',
      {
        todos: [
          item({
            blockedBy: Array.from(
              { length: HOSTED_TODO_MAX_DEPENDENCIES + 1 },
              (_, index) => `d${index}`,
            ),
          }),
        ],
      },
      `blockedBy of at most ${HOSTED_TODO_MAX_DEPENDENCIES} ids`,
    ],
    [
      'more items than the cap',
      {
        todos: Array.from({ length: HOSTED_TODO_MAX_ITEMS + 1 }, (_, index) =>
          item({ id: `t${index}` }),
        ),
      },
      `at most ${HOSTED_TODO_MAX_ITEMS} todos`,
    ],
    [
      'more serialized bytes than the cap',
      {
        todos: Array.from({ length: 40 }, (_, index) =>
          item({ id: `t${index}`, content: 'x'.repeat(500) }),
        ),
      },
      `at most ${HOSTED_TODO_MAX_SERIALIZED_BYTES} serialized bytes`,
    ],
  ];

  it.each(refusals)('refuses %s', (_label, args, expected) => {
    const check = checkHostedTodoWriteInput(args as Record<string, unknown>);
    expect(check.error).toBeDefined();
    expect(check.error).toContain(expected);
    expect(check.error).toContain('todo_write');
    expect(check.error).toContain('retry');
  });

  it('reports the index of the first bad item, not the list length', () => {
    const check = checkHostedTodoWriteInput({
      todos: [
        item({ id: 'a' }),
        item({ id: 'b' }),
        item({ id: 'c', status: 'done' }),
        item({ id: 'd' }),
      ],
    });
    expect(check.error).toContain('item 2');
  });
});
