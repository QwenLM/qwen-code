/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import type { ReadonlyFrame } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { getScreenBuffer, type ScreenBuffer } from './screen-buffer.js';
import { TextSelectionController } from './use-text-selection.js';

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

const flushMicrotasks = (): Promise<void> => Promise.resolve();

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
  let additionalSelectableRects: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    frame = makeFrame('hello');
    setSelection = vi.fn();
    listener = undefined;
    scrollState = { scrollTop: 0, scrollHeight: 1, innerHeight: 1 };
    viewportRect = { x: 0, y: 0, width: frame.width, height: 1 };
    additionalSelectableRects = [];
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
        getAdditionalSelectableRects={() => additionalSelectableRects}
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

  it('turns a footer drag into a highlight and clipboard payload', () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();

    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('move', 6, 2));
    handler(makeEvent('left-release', 6, 2));

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 1,
      ex: 5,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('status');
  });

  it('clamps a footer drag to the footer when it enters history', () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();

    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('move', 3, 1));
    handler(makeEvent('left-release', 3, 1));

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 1,
      ex: 2,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('sta');
  });

  it('does not select frame content outside registered regions', () => {
    frame = makeTwoLineFrame('hello', 'input');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    const handler = mount();

    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('left-release', 5, 2));

    expect(setSelection).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('does not treat a click after a drag as a double-click', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100);
    const handler = mount();
    selectHello(handler);

    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 1));

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenLastCalledWith('hello');
  });

  it('does not highlight a bare char-mode click', () => {
    const handler = mount();
    handler(makeEvent('left-press', 1));

    // Assert on press: release clears the highlight either way, so only the
    // press call pins the bare-click suppression.
    expect(setSelection).toHaveBeenLastCalledWith(null);

    handler(makeEvent('left-release', 1));

    expect(setSelection).toHaveBeenLastCalledWith(null);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('extends a double-click word selection word-wise on drag', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2)); // first click on "foo"
    handler(makeEvent('left-press', 2)); // double-click -> selects "foo"
    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 0,
    });
    handler(makeEvent('move', 10)); // drag to "baz"
    handler(makeEvent('left-release', 10));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 10,
      ey: 0,
    });
    // The press-time copy survives so a repaint before release cannot lose
    // the word; the release overwrites it with the grown range.
    expect(copyToClipboard).toHaveBeenCalledWith('foo');
    expect(copyToClipboard).toHaveBeenCalledWith('foo bar baz');
    expect(copyToClipboard).toHaveBeenCalledTimes(2);
  });

  it('extends a triple-click line selection line-wise on drag', () => {
    frame = makeTwoLineFrame('hello', 'world!');
    viewportRect = { x: 0, y: 0, width: 6, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1));
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1)); // double-click -> word "hello"
    handler(makeEvent('left-press', 2, 1)); // triple-click -> line 0
    handler(makeEvent('move', 3, 2)); // drag into the middle of line 1
    handler(makeEvent('left-release', 3, 2));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 5,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('hello\nworld!');
  });

  it('extends a triple-click line selection across multi-word lines', () => {
    frame = makeTwoLineFrame('foo bar', 'baz qux');
    viewportRect = { x: 0, y: 0, width: 7, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1));
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1)); // double-click -> word "foo"
    handler(makeEvent('left-press', 2, 1)); // triple-click -> line 0
    handler(makeEvent('move', 2, 2)); // drag into 'baz' on line 1
    handler(makeEvent('left-release', 2, 2));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 6,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('foo bar\nbaz qux');
  });

  it('copies a single-character word on a no-drag double-click', () => {
    frame = makeFrame('a b');
    viewportRect = { x: 0, y: 0, width: 3, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 1));
    handler(makeEvent('left-press', 1)); // double-click -> selects "a"
    handler(makeEvent('left-release', 1));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 0,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('a');
    expect(copyToClipboard).toHaveBeenCalledTimes(2);
  });

  it('keeps the double-click copy when streaming clears the selection before release', () => {
    frame = makeFrame('foo bar');
    viewportRect = { x: 0, y: 0, width: 7, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2));
    handler(makeEvent('left-release', 2));
    handler(makeEvent('left-press', 2)); // double-click -> copies "foo"
    listener!(makeFrame('foo baz')); // streaming repaint clears the selection
    handler(makeEvent('left-release', 2)); // release arrives after the clear
    nowSpy.mockRestore();

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith('foo');
  });

  it('copies a one-cell line on a no-drag triple-click', () => {
    frame = makeFrame('x');
    viewportRect = { x: 0, y: 0, width: 1, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 1));
    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 1)); // double-click -> word "x"
    handler(makeEvent('left-press', 1)); // triple-click -> line "x"
    handler(makeEvent('left-release', 1));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 0,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('x');
  });

  it('triple-clicks history text from non-selectable trailing padding', () => {
    const content = makeFrame('history').cells[0];
    const padding = Array.from({ length: 3 }, () => ({
      type: 'char' as const,
      value: ' ',
      fullWidth: false,
      styles: [],
      selectable: false,
      flowId: null,
    }));
    frame = {
      width: 10,
      height: 1,
      cells: [[...content, ...padding]],
      boundaries: [Array.from({ length: 10 }, () => null)],
    };
    viewportRect = { x: 0, y: 0, width: 10, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();

    for (let click = 0; click < 3; click++) {
      handler(makeEvent('left-press', 10));
      handler(makeEvent('left-release', 10));
    }
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 6,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('history');
  });

  it('keeps a line drag aligned when it moves into trailing padding', () => {
    const first = makeFrame('hello').cells[0];
    const second = makeFrame('world').cells[0];
    const padding = Array.from({ length: 3 }, () => ({
      type: 'char' as const,
      value: ' ',
      fullWidth: false,
      styles: [],
      selectable: false,
      flowId: null,
    }));
    frame = {
      width: 8,
      height: 2,
      cells: [
        [...first, ...padding],
        [...second, ...padding],
      ],
      boundaries: [
        Array.from({ length: 8 }, () => null),
        Array.from({ length: 8 }, () => null),
      ],
    };
    viewportRect = { x: 0, y: 0, width: 8, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1));
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1));
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('move', 8, 2));
    handler(makeEvent('left-release', 8, 2));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 4,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('hello\nworld');
  });

  it('extends a word drag to the release cell when no move event is emitted', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2));
    handler(makeEvent('left-press', 2)); // double-click -> selects "foo"
    handler(makeEvent('left-release', 10)); // release over "baz" with no move
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 10,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('foo bar baz');
  });

  it('extends a double-click word selection backward when dragging left', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 9)); // first click on "baz"
    handler(makeEvent('left-press', 9)); // double-click -> selects "baz"
    handler(makeEvent('move', 1)); // drag back onto "foo"
    handler(makeEvent('left-release', 1));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 10,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('foo bar baz');
  });

  it('extends a triple-click line selection backward when dragging up', () => {
    frame = makeTwoLineFrame('hello', 'world!');
    viewportRect = { x: 0, y: 0, width: 6, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 2));
    handler(makeEvent('left-release', 2, 2));
    handler(makeEvent('left-press', 2, 2));
    handler(makeEvent('left-release', 2, 2)); // double-click -> word "world!"
    handler(makeEvent('left-press', 2, 2)); // triple-click -> line 1
    handler(makeEvent('move', 2, 1)); // drag up onto line 0
    handler(makeEvent('left-release', 2, 1));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 5,
      ey: 1,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('hello\nworld!');
  });

  it('keeps covered-row trailing spaces in a multi-row line drag', () => {
    frame = makeTwoLineFrame('aaa ', 'bbb');
    viewportRect = { x: 0, y: 0, width: 4, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1));
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-release', 2, 1)); // double-click -> word "aaa"
    handler(makeEvent('left-press', 2, 1)); // triple-click -> line 0
    handler(makeEvent('move', 2, 2)); // drag onto line 1
    handler(makeEvent('left-release', 2, 2));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 2,
      ey: 1,
    });
    // Covered rows keep written trailing spaces (getSelectedText contract);
    // only the final row ends at the line span's trimmed last content column.
    expect(copyToClipboard).toHaveBeenLastCalledWith('aaa \nbbb');
  });

  it('falls back to the cursor cell when a word drag lands on whitespace', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2));
    handler(makeEvent('left-press', 2)); // double-click -> selects "foo"
    handler(makeEvent('move', 4)); // drag onto the gap after "foo"
    handler(makeEvent('left-release', 4));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 3,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('foo ');
  });

  it('keeps the triple-click chain across drift during a held double-click', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2));
    handler(makeEvent('left-release', 2));
    handler(makeEvent('left-press', 2)); // double-click -> selects "foo"
    handler(makeEvent('move', 4)); // drift off the word while held
    handler(makeEvent('left-release', 4));
    handler(makeEvent('left-press', 2)); // third click -> selects the line
    handler(makeEvent('left-release', 2));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 10,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('foo bar baz');
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

  it('clears a completed selection when scrollTop changes', async () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    scrollState = { ...scrollState, scrollTop: 1 };
    listener!(frame);
    await flushMicrotasks();

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('clears a completed selection when same-size frame content changes', async () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    listener!(makeFrame('hullo'));
    await flushMicrotasks();

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

  it('clears a footer selection when footer content changes', async () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();
    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('left-release', 6, 2));
    setSelection.mockClear();

    listener!(makeTwoLineFrame('hullo', 'status'));
    expect(setSelection).not.toHaveBeenCalled();

    listener!(makeTwoLineFrame('hello', 'footer'));
    await flushMicrotasks();

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('clears a footer selection when its layout changes', async () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();
    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('left-release', 6, 2));
    setSelection.mockClear();

    additionalSelectableRects = [{ x: 0, y: 2, width: 6, height: 1 }];
    listener!(frame);
    await flushMicrotasks();

    expect(setSelection).toHaveBeenCalledWith(null);
  });

  it('keeps a footer selection while history scrolls', async () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();
    handler(makeEvent('left-press', 1, 2));
    handler(makeEvent('left-release', 6, 2));
    setSelection.mockClear();

    scrollState = { ...scrollState, scrollTop: 1, scrollHeight: 2 };
    listener!(frame);
    await flushMicrotasks();

    expect(setSelection).not.toHaveBeenCalled();
  });

  it('keeps a footer drag active while history scrolls', () => {
    frame = makeTwoLineFrame('hello', 'status');
    viewportRect = { x: 0, y: 0, width: 5, height: 1 };
    additionalSelectableRects = [{ x: 0, y: 1, width: 6, height: 1 }];
    const handler = mount();
    handler(makeEvent('left-press', 1, 2));
    setSelection.mockClear();

    scrollState = { ...scrollState, scrollTop: 1 };
    handler(makeEvent('move', 5, 2));

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 1,
      ex: 4,
      ey: 1,
    });
  });

  it('does not let stale invalidation clear a newer selection', () => {
    const handler = mount();
    selectHello(handler);
    setSelection.mockClear();

    const queued: Array<() => void> = [];
    const queueSpy = vi
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation((callback) => queued.push(callback));
    frame = makeFrame('hullo');
    listener!(frame);

    handler(makeEvent('left-press', 1));
    handler(makeEvent('left-release', 5));
    queued[0]();
    queueSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 4,
      ey: 0,
    });
  });
});
