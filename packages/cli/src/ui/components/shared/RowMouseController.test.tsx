/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject } from 'react';
import { type DOMElement } from 'ink';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RowMouseController } from './RowMouseController.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  measureElementPosition,
  layoutRowForEvent,
} from '../../utils/measure-element-position.js';
import { type MouseEvent } from '../../utils/mouse.js';

vi.mock('../../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../../hooks/useTerminalSize.js', () => ({ useTerminalSize: vi.fn() }));
vi.mock('../../utils/measure-element-position.js', () => ({
  measureElementPosition: vi.fn(),
  layoutRowForEvent: vi.fn(),
}));

// Stand-in for the real layoutRowForEvent: apply the frame-anchor correction
// for a given frame height (anchor = min(0, terminalHeight - frameHeight)).
const mockLayoutRowForEvent = (frameHeight: number) =>
  vi
    .mocked(layoutRowForEvent)
    .mockImplementation((_node, terminalRow1Based, terminalHeight) => {
      const anchor = Math.min(0, terminalHeight - frameHeight);
      return terminalRow1Based - 1 - anchor;
    });

const ref = <T,>(current: T): MutableRefObject<T> => ({ current });

function makeEvent(
  partial: Partial<MouseEvent> & Pick<MouseEvent, 'name'>,
): MouseEvent {
  return {
    col: 5,
    row: 1,
    shift: false,
    meta: false,
    ctrl: false,
    button: 'left',
    ...partial,
  } as MouseEvent;
}

describe('RowMouseController', () => {
  const containerNode = { tag: 'container' } as unknown as DOMElement;
  const itemNodes = [
    { tag: 'i0' },
    { tag: 'i1' },
    { tag: 'i2' },
  ] as unknown as DOMElement[];

  let onHoverIndex: ReturnType<typeof vi.fn>;
  let onSelectIndex: ReturnType<typeof vi.fn>;

  // Frame exactly fills the terminal here → anchor 0 → layoutRow = event.row - 1.
  // Each item is one row tall, stacked from the top, so item i sits at row i.
  beforeEach(() => {
    vi.clearAllMocks();
    onHoverIndex = vi.fn();
    onSelectIndex = vi.fn();

    vi.mocked(useTerminalSize).mockReturnValue({ rows: 40, columns: 80 });
    mockLayoutRowForEvent(40); // frame fills the terminal → anchor 0
    vi.mocked(measureElementPosition).mockImplementation((node) => {
      if (node === containerNode) {
        return { x: 0, y: 0, width: 20, height: itemNodes.length };
      }
      const index = itemNodes.indexOf(node);
      return { x: 0, y: index, width: 20, height: 1 };
    });
  });

  function mountAndGetHandler(opts?: {
    scrollOffset?: number;
    isDisabled?: (index: number) => boolean;
  }): (event: MouseEvent) => void {
    render(
      <RowMouseController
        containerRef={ref(containerNode)}
        itemRefs={ref(itemNodes)}
        scrollOffset={opts?.scrollOffset ?? 0}
        isDisabled={opts?.isDisabled}
        onHoverIndex={onHoverIndex}
        onSelectIndex={onSelectIndex}
      />,
    );
    const call = vi.mocked(useMouseEvents).mock.calls.at(-1)!;
    // Subscribes at the 'any' level so bare hover is reported.
    expect(call[1]).toMatchObject({ isActive: true, tracking: 'any' });
    return call[0];
  }

  it('highlights the row under the pointer on move', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'move', row: 3 })); // layout row 2 → item 2
    expect(onHoverIndex).toHaveBeenCalledWith(2);
    expect(onSelectIndex).not.toHaveBeenCalled();
  });

  it('selects the row under the pointer on left-press', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'left-press', row: 1 })); // layout row 0 → item 0
    expect(onSelectIndex).toHaveBeenCalledWith(0);
    expect(onHoverIndex).not.toHaveBeenCalled();
  });

  it('ignores disabled rows for both hover and click', () => {
    const handler = mountAndGetHandler({ isDisabled: (i) => i === 1 });
    handler(makeEvent({ name: 'move', row: 2 })); // item 1 (disabled)
    handler(makeEvent({ name: 'left-press', row: 2 }));
    expect(onHoverIndex).not.toHaveBeenCalled();
    expect(onSelectIndex).not.toHaveBeenCalled();
  });

  it('maps through the scroll offset', () => {
    const handler = mountAndGetHandler({ scrollOffset: 5 });
    handler(makeEvent({ name: 'move', row: 1 })); // visible pos 0 → index 5
    expect(onHoverIndex).toHaveBeenCalledWith(5);
  });

  it('applies a negative anchor when the frame overflows the screen', () => {
    // Frame 4 rows taller than the terminal → top 4 rows scrolled off →
    // anchor -4, i.e. a +4-row correction. Items live near the bottom (high y).
    vi.mocked(useTerminalSize).mockReturnValue({ rows: 8, columns: 80 });
    mockLayoutRowForEvent(12); // frame 12 rows, terminal 8 → anchor -4
    vi.mocked(measureElementPosition).mockImplementation((node) => {
      if (node === containerNode) {
        return { x: 0, y: 10, width: 20, height: 3 };
      }
      const index = itemNodes.indexOf(node);
      return { x: 0, y: 10 + index, width: 20, height: 1 };
    });
    const handler = mountAndGetHandler();
    // event.row 7 → layoutRow = 7 - 1 - (-4) = 10 → item at y=10 → index 0.
    handler(makeEvent({ name: 'move', row: 7 }));
    expect(onHoverIndex).toHaveBeenCalledWith(0);
  });

  it('ignores rows below the last item', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'move', row: 10 }));
    expect(onHoverIndex).not.toHaveBeenCalled();
  });

  it('ignores interactions outside the list columns', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'left-press', row: 1, col: 30 })); // col0 29 >= width 20
    expect(onSelectIndex).not.toHaveBeenCalled();
  });

  it('ignores scroll and release events', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'scroll-down', row: 1 }));
    handler(makeEvent({ name: 'left-release', row: 1 }));
    expect(onHoverIndex).not.toHaveBeenCalled();
    expect(onSelectIndex).not.toHaveBeenCalled();
  });
});
