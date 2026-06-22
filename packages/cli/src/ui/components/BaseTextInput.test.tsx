/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { DOMElement } from 'ink';
import {
  BaseTextInput,
  getAbsolutePosition,
  getPhysicalCursorPosition,
} from './BaseTextInput.js';
import { useKeypress } from '../hooks/useKeypress.js';
import type { Key } from '../hooks/useKeypress.js';
import type { TextBuffer } from './shared/text-buffer.js';

const mockSetCursorPosition = vi.hoisted(() => vi.fn());
const mockUseBoxMetrics = vi.hoisted(() =>
  vi.fn(() => ({
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    hasMeasured: true,
  })),
);

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useBoxMetrics: mockUseBoxMetrics,
    useCursor: () => ({
      setCursorPosition: mockSetCursorPosition,
    }),
  };
});

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);

function makeKey(overrides: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...overrides,
  };
}

function createBuffer() {
  return {
    text: '',
    viewportVisualLines: [''],
    visualCursor: [0, 0],
    visualScrollRow: 0,
    setText: vi.fn(),
    newline: vi.fn(),
    move: vi.fn(),
    killLineRight: vi.fn(),
    killLineLeft: vi.fn(),
    deleteWordLeft: vi.fn(),
    openInExternalEditor: vi.fn(),
    backspace: vi.fn(),
    handleInput: vi.fn(),
  } as unknown as TextBuffer;
}

function createElement(
  top: number,
  left: number,
  parentNode?: DOMElement,
): DOMElement {
  return {
    yogaNode: {
      getComputedLayout: () => ({ top, left }),
    },
    parentNode,
  } as unknown as DOMElement;
}

function captureKeypressHandler(): (key: Key) => void {
  const calls = mockedUseKeypress.mock.calls;
  if (calls.length === 0) {
    throw new Error('useKeypress was not called');
  }
  return calls[calls.length - 1]![0] as (key: Key) => void;
}

describe('BaseTextInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBoxMetrics.mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      hasMeasured: true,
    });
  });

  it('does not type the render-mode shortcut into the buffer', () => {
    const buffer = createBuffer();

    render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    const handler = captureKeypressHandler();
    handler(makeKey({ name: 'm', meta: true, sequence: 'µ' }));

    expect(buffer.handleInput).not.toHaveBeenCalled();
  });

  it('still passes pasted µ text through to the buffer', () => {
    const buffer = createBuffer();

    render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    const handler = captureKeypressHandler();
    const pastedKey = makeKey({ sequence: 'µ', paste: true });
    handler(pastedKey);

    expect(buffer.handleInput).toHaveBeenCalledWith(pastedKey);
  });

  it('passes typed µ text through to the buffer', () => {
    const buffer = createBuffer();

    render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    const handler = captureKeypressHandler();
    const typedKey = makeKey({ name: 'µ', sequence: 'µ' });
    handler(typedKey);

    expect(buffer.handleInput).toHaveBeenCalledWith(typedKey);
  });

  it('clears the physical cursor position on unmount', () => {
    const buffer = createBuffer();
    const { unmount } = render(
      <BaseTextInput buffer={buffer} onSubmit={vi.fn()} />,
    );

    mockSetCursorPosition.mockClear();
    unmount();

    expect(mockSetCursorPosition).toHaveBeenCalledWith(undefined);
  });

  it('hides the physical cursor when showCursor is false', () => {
    const buffer = createBuffer();

    render(
      <BaseTextInput buffer={buffer} onSubmit={vi.fn()} showCursor={false} />,
    );

    expect(mockSetCursorPosition).toHaveBeenCalledWith(undefined);
  });

  it('positions the physical cursor from absolute Ink DOM position', () => {
    const root = createElement(2, 3);
    const parent = createElement(5, 7, root);
    const child = createElement(11, 13, parent);

    expect(
      getPhysicalCursorPosition(child, {
        hasMeasured: true,
        showCursor: true,
        cursorVisualRow: 2,
        cursorVisualCol: 3,
        scrollVisualRow: 1,
        linesToRender: ['', 'ab😀cd'],
        prefixWidth: 2,
      }),
    ).toEqual({ x: 29, y: 20 });
  });
});

describe('getAbsolutePosition', () => {
  it('returns undefined for a missing node', () => {
    expect(getAbsolutePosition(null)).toBeUndefined();
  });

  it('sums computed layout offsets across parent nodes', () => {
    const root = createElement(2, 3);
    const parent = createElement(5, 7, root);
    const child = createElement(11, 13, parent);

    expect(getAbsolutePosition(child)).toEqual({ top: 18, left: 23 });
  });
});
