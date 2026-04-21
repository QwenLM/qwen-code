/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StickyTodoList } from './StickyTodoList.js';
import type { TodoItem } from './TodoDisplay.js';

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
});
