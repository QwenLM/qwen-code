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
    })),
  ],
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

  beforeEach(() => {
    vi.clearAllMocks();
    frame = makeFrame('hello');
    setSelection = vi.fn();
    listener = undefined;
    scrollState = { scrollTop: 0, scrollHeight: 1, innerHeight: 1 };
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
        getViewportRect={() => ({ x: 0, y: 0, width: 5, height: 1 })}
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
});
