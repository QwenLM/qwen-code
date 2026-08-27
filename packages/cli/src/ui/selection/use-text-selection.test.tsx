/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render } from '@testing-library/react';
import type { ReadonlyFrame } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { getScreenBuffer, type ScreenBuffer } from './screen-buffer.js';
import {
  TextSelectionController,
  type SelectionQuery,
} from './use-text-selection.js';

const mocks = vi.hoisted(() => ({
  stdout: { rows: 10 },
  warn: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: mocks.stdout }),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({ warn: mocks.warn }),
  };
});

vi.mock('../hooks/useMouseEvents.js', () => ({ useMouseEvents: vi.fn() }));
vi.mock('../utils/commandUtils.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('./screen-buffer.js', () => ({ getScreenBuffer: vi.fn() }));

const makeFrame = (text: string): ReadonlyFrame => ({
  width: text.length,
  height: 1,
  cells: [
    [...text].map((value) => ({
      type: 'char' as const,
      value,
      fullWidth: false,
      styles: [],
      selectable: true,
      flowId: 1,
    })),
  ],
  boundaries: [Array.from({ length: text.length }, () => null)],
});

const makeTwoLineFrame = (first: string, second: string): ReadonlyFrame => ({
  width: Math.max(first.length, second.length),
  height: 2,
  cells: [makeFrame(first).cells[0], makeFrame(second).cells[0]],
  boundaries: [
    Array.from({ length: Math.max(first.length, second.length) }, () => null),
    Array.from({ length: Math.max(first.length, second.length) }, () => null),
  ],
});

const makeWideFrame = (): ReadonlyFrame => ({
  width: 4,
  height: 1,
  cells: [
    [
      {
        type: 'char',
        value: 'a',
        fullWidth: false,
        styles: [],
        selectable: true,
        flowId: 1,
      },
      {
        type: 'char',
        value: '中',
        fullWidth: true,
        styles: [],
        selectable: true,
        flowId: 1,
      },
      {
        type: 'char',
        value: '',
        fullWidth: false,
        styles: [],
        selectable: true,
        flowId: 1,
      },
      {
        type: 'char',
        value: 'b',
        fullWidth: false,
        styles: [],
        selectable: true,
        flowId: 1,
      },
    ],
  ],
  boundaries: [Array.from({ length: 4 }, () => null)],
});

const makeEvent = (
  name: MouseEvent['name'],
  col: number,
  row = 1,
): MouseEvent => ({
  name,
  col,
  row,
  shift: false,
  meta: false,
  ctrl: false,
  button: 'left',
});

describe('TextSelectionController', () => {
  let frame: ReadonlyFrame;
  let setSelection: ReturnType<typeof vi.fn>;
  let listener: ((nextFrame: ReadonlyFrame) => void) | undefined;
  let scrollState: {
    scrollTop: number;
    scrollHeight: number;
    innerHeight: number;
  };
  let viewportRect: { x: number; y: number; width: number; height: number };

  beforeEach(() => {
    vi.clearAllMocks();
    frame = makeFrame('hello');
    setSelection = vi.fn();
    listener = undefined;
    scrollState = { scrollTop: 0, scrollHeight: 1, innerHeight: 1 };
    viewportRect = { x: 0, y: 0, width: frame.width, height: 1 };
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    vi.mocked(getScreenBuffer).mockReturnValue({
      get frame() {
        return frame;
      },
      get dimensions() {
        return { width: frame.width, height: frame.height };
      },
      setSelection,
      subscribe: (nextListener: (nextFrame: ReadonlyFrame) => void) => {
        listener = nextListener;
        return vi.fn();
      },
    } as unknown as ScreenBuffer);
  });

  afterEach(cleanup);

  const mount = (): ((event: MouseEvent) => void) => {
    render(
      <TextSelectionController
        isActive
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );
    return vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
  };

  const selectHello = (handler: (event: MouseEvent) => void): void => {
    handler(makeEvent('left-press', 1));
    handler(makeEvent('move', 5));
    handler(makeEvent('left-release', 5));
  };

  it('turns a mouse drag into a highlight and clipboard payload', () => {
    const handler = mount();
    selectHello(handler);

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 4,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('hello');
  });

  it('includes the release cell when no move event is emitted', () => {
    const handler = mount();
    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 5));

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 4,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('hello');
  });

  it('does not treat a click after a drag as a double-click', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100);
    const handler = mount();
    selectHello(handler);

    handler(makeEvent('left-press', 1));

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenLastCalledWith('hello');
  });

  it('snaps a wide-character spacer to the leading cell', () => {
    frame = makeWideFrame();
    const handler = mount();
    handler(makeEvent('left-press', 3));
    handler(makeEvent('move', 4));
    handler(makeEvent('left-release', 4));

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 1,
      sy: 0,
      ex: 3,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('中b');
  });

  it('records clipboard failures in the debug log', async () => {
    vi.mocked(copyToClipboard).mockRejectedValue(new Error('unavailable'));
    const handler = mount();
    selectHello(handler);
    await Promise.resolve();

    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to copy selected text:',
      expect.any(Error),
    );
  });

  it('clears a completed selection when scrollTop changes', () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    scrollState = { ...scrollState, scrollTop: 1 };
    listener!(frame);

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('clears a completed selection when same-size frame content changes', () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    listener!(makeFrame('hullo'));

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('keeps a selection across its own highlight repaint', () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    listener!(makeFrame('hello'));

    expect(setSelection).not.toHaveBeenCalled();
  });

  it('keeps a selection when content outside the viewport changes', () => {
    frame = makeTwoLineFrame('hello', 'prompt');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    listener!(makeTwoLineFrame('hello', 'footer'));

    expect(setSelection).not.toHaveBeenCalled();
  });

  const renderController = (eventsPaused: boolean) =>
    render(
      <TextSelectionController
        isActive
        eventsPaused={eventsPaused}
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );

  it('does not start a selection while eventsPaused', () => {
    renderController(true);
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    handler(makeEvent('left-press', 1));
    handler(makeEvent('move', 5));
    handler(makeEvent('left-release', 5));

    expect(setSelection).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('preserves an existing selection when eventsPaused flips on', () => {
    const { rerender } = renderController(false);
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    selectHello(handler);
    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 4,
      ey: 0,
    });
    setSelection.mockClear();

    rerender(
      <TextSelectionController
        isActive
        eventsPaused
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );
    const pausedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    pausedHandler(makeEvent('left-press', 1));
    pausedHandler(makeEvent('left-release', 1));

    // No clear (setSelection(null)) and no new selection — the range survives.
    expect(setSelection).not.toHaveBeenCalled();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it('clears the selection on a wheel tick while not paused', () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    handler(makeEvent('scroll-down', 1));

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('drops a wheel tick while eventsPaused instead of clearing', () => {
    const { rerender } = renderController(false);
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    selectHello(handler);
    setSelection.mockClear();

    rerender(
      <TextSelectionController
        isActive
        eventsPaused
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );
    const pausedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    pausedHandler(makeEvent('scroll-down', 1));

    // Nothing scrolled while the menu owns the pointer — the selection the
    // menu's Copy Selection offers must survive the wheel tick.
    expect(setSelection).not.toHaveBeenCalled();
  });

  it('finishes an in-flight drag when the release lands while eventsPaused', () => {
    const { rerender } = renderController(false);
    const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    handler(makeEvent('left-press', 1));
    handler(makeEvent('move', 3));

    // The context menu opens mid-drag and pauses events before the release.
    rerender(
      <TextSelectionController
        isActive
        eventsPaused
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );
    const pausedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    pausedHandler(makeEvent('left-release', 4));
    setSelection.mockClear();
    vi.mocked(copyToClipboard).mockClear();

    // After resume, a bare release (no press) must not resurrect the stale
    // drag and copy a range the user never selected.
    rerender(
      <TextSelectionController
        isActive
        getViewportRect={() => viewportRect}
        getScrollState={() => scrollState}
        hitTestScrollbar={() => false}
      />,
    );
    const resumedHandler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
    resumedHandler(makeEvent('left-release', 5));

    expect(setSelection).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  describe('selectionQueryRef', () => {
    const mountWithQuery = () => {
      const selectionQueryRef = { current: null as SelectionQuery | null };
      render(
        <TextSelectionController
          isActive
          getViewportRect={() => viewportRect}
          getScrollState={() => scrollState}
          hitTestScrollbar={() => false}
          selectionQueryRef={selectionQueryRef}
        />,
      );
      const handler = vi.mocked(useMouseEvents).mock.calls.at(-1)![0];
      return { selectionQueryRef, handler };
    };

    it('reports the normalized range of a drag selection', () => {
      const { selectionQueryRef, handler } = mountWithQuery();
      expect(selectionQueryRef.current).not.toBeNull();
      selectHello(handler);
      expect(selectionQueryRef.current!.getRange()).toEqual({
        sx: 0,
        sy: 0,
        ex: 4,
        ey: 0,
      });
    });

    it('reports null for a bare collapsed click', () => {
      const { selectionQueryRef, handler } = mountWithQuery();
      handler(makeEvent('left-press', 2));
      handler(makeEvent('left-release', 2));
      expect(selectionQueryRef.current!.getRange()).toBeNull();
    });

    it('still reports a collapsed word span from a single-cell double-click', () => {
      frame = makeFrame('x = 5');
      vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100);
      const { selectionQueryRef, handler } = mountWithQuery();
      handler(makeEvent('left-press', 5));
      handler(makeEvent('left-press', 5));
      // The isolated '5' is a one-cell word span: collapsed but carrying
      // text, so Copy Selection must still be offered.
      expect(selectionQueryRef.current!.getRange()).toEqual({
        sx: 4,
        sy: 0,
        ex: 4,
        ey: 0,
      });
    });

    it('clears the ref on unmount', () => {
      const { selectionQueryRef } = mountWithQuery();
      expect(selectionQueryRef.current).not.toBeNull();
      cleanup();
      expect(selectionQueryRef.current).toBeNull();
    });
  });
});
