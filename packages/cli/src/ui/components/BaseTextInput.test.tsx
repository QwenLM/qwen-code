/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { BaseTextInput } from './BaseTextInput.js';
import { useKeypress } from '../hooks/useKeypress.js';
import type { Key } from '../hooks/useKeypress.js';
import type { TextBuffer } from './shared/text-buffer.js';

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
  });

  it('does not type the Markdown render-mode shortcut into the buffer', () => {
    const buffer = createBuffer();

    render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    const handler = captureKeypressHandler();
    handler(makeKey({ name: 'm', meta: true, sequence: 'µ' }));

    expect(buffer.handleInput).not.toHaveBeenCalled();
  });

  it('does not type the raw macOS Option+M sequence into the buffer', () => {
    const buffer = createBuffer();

    render(<BaseTextInput buffer={buffer} onSubmit={vi.fn()} />);

    const handler = captureKeypressHandler();
    handler(makeKey({ name: '', sequence: 'µ' }));

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
});
