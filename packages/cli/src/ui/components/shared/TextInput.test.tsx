/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { TextInput } from './TextInput.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import type { Key } from '../../hooks/useKeypress.js';

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: { accent: 'cyan' },
    status: { error: 'red' },
  },
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

function captureKeypressHandler(): (key: Key) => void {
  const calls = mockedUseKeypress.mock.calls;
  if (calls.length === 0) {
    throw new Error('useKeypress was not called');
  }
  // Return the most recent handler
  return calls[calls.length - 1]![0] as (key: Key) => void;
}

describe('TextInput', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let onSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onChange = vi.fn();
    onSubmit = vi.fn();
  });

  describe('multiline mode (height > 1)', () => {
    it('submits on plain Enter', () => {
      render(
        <TextInput
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          height={5}
        />,
      );

      const handler = captureKeypressHandler();
      handler(makeKey({ name: 'return', sequence: '\r' }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does NOT submit on Shift+Enter — inserts newline instead', () => {
      render(
        <TextInput
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          height={5}
        />,
      );

      const handler = captureKeypressHandler();
      handler(makeKey({ name: 'return', shift: true, sequence: '\r' }));

      expect(onSubmit).not.toHaveBeenCalled();
      // onChange should be called with the newline character
      expect(onChange).toHaveBeenCalled();
    });

    it('does NOT submit on Ctrl+Enter — inserts newline instead', () => {
      render(
        <TextInput
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          height={5}
        />,
      );

      const handler = captureKeypressHandler();
      handler(makeKey({ name: 'return', ctrl: true, sequence: '\r' }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenCalled();
    });
  });

  describe('single-line mode (height = 1)', () => {
    it('submits on plain Enter', () => {
      render(
        <TextInput
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          height={1}
        />,
      );

      const handler = captureKeypressHandler();
      handler(makeKey({ name: 'return', sequence: '\r' }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('submits on Shift+Enter (no newline concept in single-line)', () => {
      render(
        <TextInput
          value=""
          onChange={onChange}
          onSubmit={onSubmit}
          height={1}
        />,
      );

      const handler = captureKeypressHandler();
      handler(makeKey({ name: 'return', shift: true, sequence: '\r' }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });
});
