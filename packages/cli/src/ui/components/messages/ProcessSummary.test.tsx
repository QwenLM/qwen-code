/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { getFrameController } from 'ink';
import { ProcessSummary } from './ProcessSummary.js';
import { ToolCallStatus } from '../../types.js';
import type { ProcessHistoryItem } from '../../utils/process-history.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import type { MouseEvent } from '../../utils/mouse.js';

vi.mock('../../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));
vi.mock('../../utils/measure-element-position.js', () => ({
  measureElementPosition: () => ({ x: 2, y: 1, width: 60, height: 1 }),
  layoutRowForEvent: (_node: unknown, row: number) => row - 1,
}));

afterEach(cleanup);

const item: ProcessHistoryItem = {
  id: 1,
  type: 'process',
  members: [
    { id: 1, type: 'gemini_thought', text: 'thinking', durationMs: 2000 },
    { id: 2, type: 'gemini_thought', text: 'thinking again', durationMs: 3000 },
    {
      id: 3,
      type: 'tool_group',
      tools: ['ReadFile', 'ReadFile', 'Shell'].map((name, index) => ({
        name,
        callId: String(index),
        description: '很长的中文路径/README.md',
        status: ToolCallStatus.Success,
        resultDisplay: 'complete output',
        confirmationDetails: undefined,
      })),
    },
  ],
};
const event = (name: MouseEvent['name'], col = 4, row = 2): MouseEvent => ({
  name,
  col,
  row,
  button: 'left',
  shift: false,
  meta: false,
  ctrl: false,
});

describe('ProcessSummary', () => {
  it('uses one muted summary row with a single duration and hint', () => {
    const { lastFrame } = render(
      <ProcessSummary
        item={item}
        width={76}
        expanded={false}
        interactive
        onExpand={vi.fn()}
      />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Read 2 files, ran 1 command');
    expect(output).toContain('Thought for 5s');
    expect(output.match(/expand/g)).toHaveLength(1);
    expect(output.split('\n')).toHaveLength(2);
    expect(output).not.toContain('complete output');
  });

  it('truncates a narrow summary without wrapping CJK text', () => {
    const { lastFrame } = render(
      <ProcessSummary
        item={item}
        width={20}
        expanded={false}
        interactive
        onExpand={vi.fn()}
      />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.filter((line) => line.trim())).toHaveLength(1);
    expect(lines.every((line) => stringWidth(line) <= 24)).toBe(true);
  });

  it('expands only on a matching press/release and goes inactive behind dialogs', () => {
    const onExpand = vi.fn();
    const props = {
      item,
      width: 60,
      expanded: false,
      interactive: true,
      onExpand,
    };
    const { rerender } = render(<ProcessSummary {...props} />);
    const mouse = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    mouse(event('left-press'));
    mouse(event('move', 5));
    mouse(event('left-release'));
    expect(onExpand).not.toHaveBeenCalled();
    mouse(event('left-press'));
    mouse(event('left-release'));
    expect(onExpand).toHaveBeenCalledOnce();
    rerender(<ProcessSummary {...props} interactive={false} />);
    expect(vi.mocked(useMouseEvents).mock.calls.at(-1)![1].isActive).toBe(
      false,
    );
  });

  it.each([
    { sx: 3, sy: 1, ex: 12, ey: 1 },
    { sx: 3, sy: 1, ex: 3, ey: 1 },
    { sx: 2, sy: 1, ex: 60, ey: 1 },
  ])(
    'does not expand on a matching release with renderer selection %j',
    (selection) => {
      const onExpand = vi.fn();
      const { stdout } = render(
        <ProcessSummary
          item={item}
          width={60}
          expanded={false}
          interactive
          onExpand={onExpand}
        />,
      );
      const mouse = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
      const controller = getFrameController(
        stdout as unknown as NodeJS.WriteStream,
      )!;

      mouse(event('left-press'));
      controller.setSelection(selection);
      expect(controller.getSelection()).toEqual(selection);
      mouse(event('left-release'));
      expect(onExpand).not.toHaveBeenCalled();

      controller.setSelection(null);
      mouse(event('left-press'));
      mouse(event('left-release'));
      expect(onExpand).toHaveBeenCalledOnce();
    },
  );
});
