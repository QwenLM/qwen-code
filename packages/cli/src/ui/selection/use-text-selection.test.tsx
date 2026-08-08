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

  it('extends a double-click word selection word-wise on drag', () => {
    frame = makeFrame('foo bar baz');
    viewportRect = { x: 0, y: 0, width: 11, height: 1 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2)); // first click on "foo"
    handler(makeEvent('left-press', 2)); // double-click -> selects "foo"
    handler(makeEvent('move', 10)); // drag to "baz"
    handler(makeEvent('left-release', 10));
    nowSpy.mockRestore();

    expect(setSelection).toHaveBeenLastCalledWith({
      sx: 0,
      sy: 0,
      ex: 10,
      ey: 0,
    });
    expect(copyToClipboard).toHaveBeenCalledWith('foo bar baz');
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it('extends a triple-click line selection line-wise on drag', () => {
    frame = makeTwoLineFrame('hello', 'world!');
    viewportRect = { x: 0, y: 0, width: 6, height: 2 };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const handler = mount();
    handler(makeEvent('left-press', 2, 1));
    handler(makeEvent('left-press', 2, 1));
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
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld!');
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
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
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
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
    handler(makeEvent('left-press', 2, 2));
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
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld!');
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
});
