/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getStickyTodosFromLiveItems } from './sticky-todos.js';
import type { LiveHistoryItem, LiveToolItem } from './live-session-model.js';
import type { TodoItem } from '../components/TodoDisplay.js';

const TODO_A: TodoItem = { id: 'a', content: 'A', status: 'in_progress' };
const TODO_B: TodoItem = { id: 'b', content: 'B', status: 'pending' };
const TODO_C: TodoItem = { id: 'c', content: 'C', status: 'completed' };

let seq = 0;
const toolWithTodos = (todos: TodoItem[]): LiveToolItem => ({
  kind: 'tool',
  id: `t${++seq}`,
  tool: 'todo_write',
  title: 'todo_write',
  output: '',
  done: true,
  todos,
});
const userItem = (): LiveHistoryItem => ({
  kind: 'user',
  id: `u${++seq}`,
  text: 'hi',
});
const assistantItem = (): LiveHistoryItem => ({
  kind: 'assistant',
  id: `a${++seq}`,
  text: 'done',
  streaming: false,
});

describe('getStickyTodosFromLiveItems (ink getStickyTodos parity)', () => {
  it('returns null when no tool carries a todo snapshot', () => {
    expect(
      getStickyTodosFromLiveItems([userItem(), assistantItem()]),
    ).toBeNull();
  });

  it('suppresses a snapshot with fewer than two items after it', () => {
    const items = [userItem(), toolWithTodos([TODO_A, TODO_B])];
    expect(getStickyTodosFromLiveItems(items)).toBeNull();

    const oneAfter = [...items, assistantItem()];
    expect(getStickyTodosFromLiveItems(oneAfter)).toBeNull();
  });

  it('returns the snapshot once two items follow it', () => {
    const todos = [TODO_A, TODO_B];
    const items: LiveHistoryItem[] = [
      userItem(),
      toolWithTodos(todos),
      assistantItem(),
      assistantItem(),
    ];
    expect(getStickyTodosFromLiveItems(items)).toBe(todos);
  });

  it('does not resurface stale todos after a new user turn', () => {
    const items: LiveHistoryItem[] = [
      toolWithTodos([TODO_A, TODO_B]),
      assistantItem(),
      assistantItem(),
      userItem(),
    ];
    expect(getStickyTodosFromLiveItems(items)).toBeNull();
  });

  it('returns null when every todo is completed', () => {
    const items: LiveHistoryItem[] = [
      toolWithTodos([TODO_C, { ...TODO_C, id: 'c2' }]),
      assistantItem(),
      assistantItem(),
    ];
    expect(getStickyTodosFromLiveItems(items)).toBeNull();
  });

  it('treats an empty todo list as a snapshot and stops searching earlier ones', () => {
    const items: LiveHistoryItem[] = [
      toolWithTodos([TODO_A]),
      assistantItem(),
      toolWithTodos([]),
      assistantItem(),
      assistantItem(),
    ];
    expect(getStickyTodosFromLiveItems(items)).toBeNull();
  });

  it('prefers the most recent snapshot', () => {
    const latest = [TODO_B];
    const items: LiveHistoryItem[] = [
      toolWithTodos([TODO_A]),
      assistantItem(),
      toolWithTodos(latest),
      assistantItem(),
      assistantItem(),
    ];
    expect(getStickyTodosFromLiveItems(items)).toBe(latest);
  });

  it('ignores tools without a snapshot between user turns', () => {
    const todos = [TODO_A];
    const items: LiveHistoryItem[] = [
      toolWithTodos(todos),
      assistantItem(),
      {
        kind: 'tool',
        id: `t${++seq}`,
        tool: 'read_file',
        title: 'read_file',
        output: 'x',
        done: true,
        success: true,
      },
    ];
    expect(getStickyTodosFromLiveItems(items)).toBe(todos);
  });
});
