/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject } from 'react';
import { type DOMElement } from 'ink';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TextInputMouseController } from './TextInputMouseController.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  measureElementPosition,
  measureFrameHeight,
} from '../../utils/measure-element-position.js';
import { type MouseEvent } from '../../utils/mouse.js';

vi.mock('../../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../../hooks/useTerminalSize.js', () => ({ useTerminalSize: vi.fn() }));
vi.mock('../../utils/measure-element-position.js', () => ({
  measureElementPosition: vi.fn(),
  measureFrameHeight: vi.fn(),
}));

const ref = <T,>(current: T): MutableRefObject<T> => ({ current });

function makeEvent(
  partial: Partial<MouseEvent> & Pick<MouseEvent, 'name'>,
): MouseEvent {
  return {
    col: 1,
    row: 1,
    shift: false,
    meta: false,
    ctrl: false,
    button: 'left',
    ...partial,
  } as MouseEvent;
}

describe('TextInputMouseController', () => {
  const linesNode = { tag: 'lines' } as unknown as DOMElement;
  let moveToOffset: ReturnType<typeof vi.fn>;

  // Lines container rendered at screen row 5, col 2, two visual lines tall.
  function makeBuffer(overrides?: Partial<{ visualScrollRow: number }>) {
    return {
      lines: ['abc', 'def'],
      allVisualLines: ['abc', 'def'],
      visualToLogicalMap: [
        [0, 0],
        [1, 0],
      ] as Array<[number, number]>,
      visualScrollRow: overrides?.visualScrollRow ?? 0,
      moveToOffset,
    };
  }

  // Frame fills the terminal here → anchor 0 → clickVisualRow = event.row-1-y.
  beforeEach(() => {
    vi.clearAllMocks();
    moveToOffset = vi.fn();
    vi.mocked(useTerminalSize).mockReturnValue({ rows: 40, columns: 80 });
    vi.mocked(measureFrameHeight).mockReturnValue(40);
    vi.mocked(measureElementPosition).mockReturnValue({
      x: 2,
      y: 5,
      width: 20,
      height: 2,
    });
  });

  function mountAndGetHandler(
    buffer = makeBuffer(),
    visibleLineCount = 2,
  ): (event: MouseEvent) => void {
    render(
      <TextInputMouseController
        linesRef={ref(linesNode)}
        buffer={buffer}
        visibleLineCount={visibleLineCount}
      />,
    );
    const call = vi.mocked(useMouseEvents).mock.calls.at(-1)!;
    // Input click needs no hover, so the cheaper 'button' level is used.
    expect(call[1]).toMatchObject({ isActive: true, tracking: 'button' });
    return call[0];
  }

  it('moves the cursor to the clicked offset on left-press', () => {
    const handler = mountAndGetHandler();
    // row 6 → visual row 0 ('abc'); col 4 → text col 1 → between 'a' and 'b'.
    handler(makeEvent({ name: 'left-press', row: 6, col: 4 }));
    expect(moveToOffset).toHaveBeenCalledWith(1);
  });

  it('maps a click on the second visual line through the newline', () => {
    const handler = mountAndGetHandler();
    // row 7 → visual row 1 ('def'); col 4 → text col 1 → logical (1,1) → offset 5.
    handler(makeEvent({ name: 'left-press', row: 7, col: 4 }));
    expect(moveToOffset).toHaveBeenCalledWith(5);
  });

  it('applies the visual scroll offset', () => {
    const handler = mountAndGetHandler(makeBuffer({ visualScrollRow: 1 }));
    // row 6 → visual row 0 + scroll 1 = absolute visual row 1 ('def').
    handler(makeEvent({ name: 'left-press', row: 6, col: 3 }));
    // col 3 → text col 0 → start of 'def' → offset 4.
    expect(moveToOffset).toHaveBeenCalledWith(4);
  });

  it('applies a negative anchor when the frame overflows the screen', () => {
    // Frame 4 rows taller than the terminal → anchor -4 → +4-row correction.
    vi.mocked(useTerminalSize).mockReturnValue({ rows: 8, columns: 80 });
    vi.mocked(measureFrameHeight).mockReturnValue(12);
    vi.mocked(measureElementPosition).mockReturnValue({
      x: 2,
      y: 9,
      width: 20,
      height: 2,
    });
    const handler = mountAndGetHandler();
    // row 6 → layoutRow = 6 - 1 - (-4) = 9; clickVisualRow = 9 - 9 = 0 ('abc');
    // col 4 → text col 1 → offset 1.
    handler(makeEvent({ name: 'left-press', row: 6, col: 4 }));
    expect(moveToOffset).toHaveBeenCalledWith(1);
  });

  it('clamps a click in the prefix columns to the line start', () => {
    const handler = mountAndGetHandler();
    // col 1 < lines x (2) → clickVisualCol clamps to 0 → start of line → offset 0.
    handler(makeEvent({ name: 'left-press', row: 6, col: 1 }));
    expect(moveToOffset).toHaveBeenCalledWith(0);
  });

  it('ignores clicks above or below the rendered lines', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'left-press', row: 5, col: 4 })); // row above lines (y=5 → visual -0? )
    handler(makeEvent({ name: 'left-press', row: 99, col: 4 })); // far below
    // row 5 → clickVisualRow = 5-1-5 = -1 (above) → ignored; row 99 → below → ignored.
    expect(moveToOffset).not.toHaveBeenCalled();
  });

  it('ignores non-left-press events (hover, release, scroll)', () => {
    const handler = mountAndGetHandler();
    handler(makeEvent({ name: 'move', row: 6, col: 4 }));
    handler(makeEvent({ name: 'left-release', row: 6, col: 4 }));
    handler(makeEvent({ name: 'scroll-down', row: 6, col: 4 }));
    expect(moveToOffset).not.toHaveBeenCalled();
  });
});
