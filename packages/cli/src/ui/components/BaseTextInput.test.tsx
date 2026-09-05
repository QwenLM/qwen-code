/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { DOMElement } from 'ink';
import stringWidth from 'string-width';
import {
  BaseTextInput,
  defaultRenderLine,
  getAbsolutePosition,
  getPhysicalCursorPosition,
} from './BaseTextInput.js';
import { useKeypress } from '../hooks/useKeypress.js';
import type { Key } from '../hooks/useKeypress.js';
import type { TextBuffer } from './shared/text-buffer.js';
import { renderSoftwareCursor } from '../utils/software-cursor.js';

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
    vi.stubEnv('QWEN_CODE_DISABLE_PHYSICAL_CURSOR', '');
    mockUseBoxMetrics.mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      hasMeasured: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('hides the physical cursor when showCursor is false', () => {
    const buffer = createBuffer();

    render(
      <BaseTextInput buffer={buffer} onSubmit={vi.fn()} showCursor={false} />,
    );

    expect(mockSetCursorPosition).toHaveBeenCalledWith(undefined);
  });

  it('leaves cursor cleanup to the useCursor hook', () => {
    const buffer = createBuffer();
    const { unmount } = render(
      <BaseTextInput buffer={buffer} onSubmit={vi.fn()} />,
    );

    mockSetCursorPosition.mockClear();
    unmount();

    expect(mockSetCursorPosition).not.toHaveBeenCalled();
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

  it('keeps physical cursor positioning enabled by default', () => {
    const buffer = createBuffer();
    const view = render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    mockSetCursorPosition.mockClear();
    view.rerender(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    expect(mockSetCursorPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it('disables physical cursor positioning through the compatibility flag', () => {
    vi.stubEnv('QWEN_CODE_DISABLE_PHYSICAL_CURSOR', '1');
    const buffer = createBuffer();
    const view = render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    mockSetCursorPosition.mockClear();
    view.rerender(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    expect(mockSetCursorPosition).toHaveBeenCalled();
    expect(mockSetCursorPosition).toHaveBeenLastCalledWith(undefined);
  });

  it('overwrites the placeholder when physical cursor positioning is disabled', () => {
    vi.stubEnv('QWEN_CODE_DISABLE_PHYSICAL_CURSOR', '1');
    const placeholder = '  Type your message or @path/to/file';
    const buffer = createBuffer();
    const view = render(
      <BaseTextInput
        buffer={buffer}
        onSubmit={vi.fn()}
        placeholder={placeholder}
      />,
    );

    expect(view.lastFrame()).toContain(placeholder);

    Object.assign(buffer, {
      text: 'a',
      viewportVisualLines: ['a'],
      visualCursor: [0, 1],
    });
    view.rerender(
      <BaseTextInput
        buffer={buffer}
        onSubmit={vi.fn()}
        placeholder={placeholder}
      />,
    );

    const inputLine = view
      .lastFrame()
      ?.split('\n')
      .find((line) => line.includes('a'));
    expect(inputLine).toBeDefined();
    expect(inputLine).not.toContain('Type');
    expect(inputLine).not.toContain('file');
    expect(inputLine).toContain('\u200B');
    expect(stringWidth(inputLine!)).toBe(2 + stringWidth(placeholder));
  });

  it.each([
    { columns: 11, label: 'session', expectedLabel: 'sessi…' },
    { columns: 12, label: '会话标题', expectedLabel: '会话标…' },
    { columns: 20, label: 'session', expectedLabel: 'session' },
    { columns: 4, label: 'session', expectedLabel: '' },
  ])(
    'keeps the top border within $columns columns for "$label"',
    ({ columns, label, expectedLabel }) => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        process.stdout,
        'columns',
      );
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        value: columns,
      });

      try {
        const { lastFrame } = render(
          <BaseTextInput
            buffer={createBuffer()}
            onSubmit={vi.fn()}
            topRightLabel={label}
          />,
        );
        const topBorderLine = lastFrame()?.split('\n')[0] ?? '';

        expect(stringWidth(topBorderLine)).toBe(columns);
        if (expectedLabel) {
          expect(topBorderLine).toContain(` ${expectedLabel} `);
        } else {
          expect(topBorderLine).toBe('─'.repeat(columns));
        }
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(process.stdout, 'columns', originalDescriptor);
        } else {
          Reflect.deleteProperty(process.stdout, 'columns');
        }
      }
    },
  );
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

  it('skips nodes without yogaNode in the parent chain', () => {
    const root = createElement(2, 3);
    const middle = { parentNode: root } as unknown as DOMElement;
    const child = createElement(11, 13, middle);

    expect(getAbsolutePosition(child)).toEqual({ top: 13, left: 16 });
  });

  it('skips nodes whose getComputedLayout returns undefined', () => {
    const root = createElement(2, 3);
    const middle = {
      yogaNode: {
        getComputedLayout: () => undefined,
      },
      parentNode: root,
    } as unknown as DOMElement;
    const child = createElement(11, 13, middle);

    expect(getAbsolutePosition(child)).toEqual({ top: 13, left: 16 });
  });
});

describe('defaultRenderLine', () => {
  it('renders the software cursor on the current character', () => {
    const { lastFrame } = render(
      <>
        {defaultRenderLine({
          lineText: 'hello',
          isOnCursorLine: true,
          cursorCol: 2,
          showCursor: true,
          visualLineIndex: 0,
          absoluteVisualIndex: 0,
          buffer: createBuffer(),
          scrollVisualRow: 0,
        })}
      </>,
    );

    expect(lastFrame()).toContain(`he${renderSoftwareCursor('l')}lo`);
  });

  it('renders the software cursor as a trailing space', () => {
    const { lastFrame } = render(
      <>
        {defaultRenderLine({
          lineText: 'hello',
          isOnCursorLine: true,
          cursorCol: 5,
          showCursor: true,
          visualLineIndex: 0,
          absoluteVisualIndex: 0,
          buffer: createBuffer(),
          scrollVisualRow: 0,
        })}
      </>,
    );

    expect(lastFrame()).toContain(`hello${renderSoftwareCursor(' ')}`);
  });
});
