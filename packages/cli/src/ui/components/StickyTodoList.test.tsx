/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  getStickyTodoMaxVisibleItems,
  STICKY_TODO_MAX_VISIBLE_ITEMS,
} from '../utils/todoSnapshot.js';
import { StickyTodoList } from './StickyTodoList.js';
import type { TodoItem } from './TodoDisplay.js';

function makeTodos(count: number): TodoItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `todo-${index + 1}`,
    content: `Task ${index + 1}`,
    status: 'pending' as const,
  }));
}

describe('StickyTodoList', () => {
  it('keeps each task number attached to the original task after sorting', () => {
    const todos: TodoItem[] = [
      {
        id: 'done',
        content: 'Summarize results',
        status: 'completed',
      },
      {
        id: 'pending',
        content: 'Run cli tests',
        status: 'pending',
      },
      {
        id: 'active',
        content: 'Run core tests',
        status: 'in_progress',
      },
    ];

    const { lastFrame } = render(<StickyTodoList todos={todos} width={60} />);
    const output = lastFrame() ?? '';
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    expect(output).toContain('Current tasks');
    expect(output).toContain('╭');
    expect(
      lines.find((line) => line.includes('Run core tests')) ?? '',
    ).toContain('3.');
    expect(
      lines.find((line) => line.includes('Run cli tests')) ?? '',
    ).toContain('2.');
    expect(
      lines.find((line) => line.includes('Summarize results')) ?? '',
    ).toContain('1.');
    expect(output.indexOf('Run core tests')).toBeLessThan(
      output.indexOf('Run cli tests'),
    );
    expect(output.indexOf('Run cli tests')).toBeLessThan(
      output.indexOf('Summarize results'),
    );
  });

  it('keeps long todo lists compact with a hidden item summary', () => {
    const todos: TodoItem[] = [
      {
        id: 'active',
        content:
          'This active task has a very long description that should not wrap across multiple rows in the sticky panel',
        status: 'in_progress',
      },
      {
        id: 'pending-1',
        content: 'Run cli tests',
        status: 'pending',
      },
      {
        id: 'pending-2',
        content: 'Run core tests',
        status: 'pending',
      },
      {
        id: 'done',
        content: 'Summarize results',
        status: 'completed',
      },
    ];

    const { lastFrame } = render(
      <StickyTodoList todos={todos} width={42} maxVisibleItems={2} />,
    );
    const output = lastFrame() ?? '';
    const lines = output.split('\n').filter(Boolean);

    expect(output).toContain('Current tasks');
    expect(output).toContain('This active task has a very long');
    expect(output).not.toContain('multiple rows in the sticky panel');
    expect(output).toContain('Run cli tests');
    expect(output).not.toContain('Run core tests');
    expect(output).not.toContain('Summarize results');
    expect(output).toContain('... and 2 more');
    expect(lines).toHaveLength(6);
  });

  it('sizes the number column for original todo numbers after sorting', () => {
    const todos = makeTodos(10).map((todo, index) => ({
      ...todo,
      status: index === 9 ? ('in_progress' as const) : ('completed' as const),
    }));

    const { lastFrame } = render(
      <StickyTodoList todos={todos} width={24} maxVisibleItems={1} />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('10. ◐ Task 10');
    expect(output).toContain('... and 9 more');
  });

  it('derives a viewport-aware visible item count', () => {
    expect(getStickyTodoMaxVisibleItems(8)).toBe(1);
    expect(getStickyTodoMaxVisibleItems(15)).toBe(3);
    expect(getStickyTodoMaxVisibleItems(80)).toBe(5);
  });

  it('falls back to the maximum visible item count for non-finite maxVisibleItems', () => {
    const todos = makeTodos(STICKY_TODO_MAX_VISIBLE_ITEMS + 1);

    for (const maxVisibleItems of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { lastFrame, unmount } = render(
        <StickyTodoList
          todos={todos}
          width={42}
          maxVisibleItems={maxVisibleItems}
        />,
      );
      const output = lastFrame() ?? '';

      expect(output).toContain(`Task ${STICKY_TODO_MAX_VISIBLE_ITEMS}`);
      expect(output).not.toContain(`Task ${STICKY_TODO_MAX_VISIBLE_ITEMS + 1}`);
      expect(output).toContain('... and 1 more');

      unmount();
    }
  });
});
