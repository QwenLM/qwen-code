/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { act } from 'react';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { useInlineEditBuffer } from './useInlineEditBuffer.js';
import { KILL_LINE_CASES } from '../components/shared/killLineFixture.js';

describe('useEditBuffer', () => {
  let mockOnCommit: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockOnCommit = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with empty state', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    expect(result.current.editState.editingKey).toBeNull();
    expect(result.current.editState.buffer).toBe('');
    expect(result.current.editState.cursorPos).toBe(0);
  });

  it('should start editing correctly', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('my-key', 'initial'));

    expect(result.current.editState.editingKey).toBe('my-key');
    expect(result.current.editState.buffer).toBe('initial');
    expect(result.current.editState.cursorPos).toBe(7); // End of string
  });

  it('should commit edit and reset state', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );

    act(() => result.current.startEditing('my-key', 'text'));
    let committed = false;
    act(() => {
      committed = result.current.commitEdit();
    });

    expect(committed).toBe(true);
    expect(mockOnCommit).toHaveBeenCalledWith('my-key', 'text');
    expect(result.current.editState.editingKey).toBeNull();
    expect(result.current.editState.buffer).toBe('');
  });

  it('should preserve the edit buffer when commit is rejected', async () => {
    mockOnCommit.mockReturnValue(false);
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );

    act(() => result.current.startEditing('my-key', 'unsaved text'));
    let committed = true;
    act(() => {
      committed = result.current.commitEdit();
    });

    expect(committed).toBe(false);
    expect(mockOnCommit).toHaveBeenCalledWith('my-key', 'unsaved text');
    expect(result.current.editState.editingKey).toBe('my-key');
    expect(result.current.editState.buffer).toBe('unsaved text');
  });

  it('should move cursor left and right', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'ab')); // cursor at 2

    act(() => result.current.editDispatch({ type: 'MOVE_LEFT' }));
    expect(result.current.editState.cursorPos).toBe(1);

    act(() => result.current.editDispatch({ type: 'MOVE_LEFT' }));
    expect(result.current.editState.cursorPos).toBe(0);

    // Shouldn't go below 0
    act(() => result.current.editDispatch({ type: 'MOVE_LEFT' }));
    expect(result.current.editState.cursorPos).toBe(0);

    act(() => result.current.editDispatch({ type: 'MOVE_RIGHT' }));
    expect(result.current.editState.cursorPos).toBe(1);
  });

  it('should handle home and end', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'testing')); // cursor at 7

    act(() => result.current.editDispatch({ type: 'HOME' }));
    expect(result.current.editState.cursorPos).toBe(0);

    act(() => result.current.editDispatch({ type: 'END' }));
    expect(result.current.editState.cursorPos).toBe(7);
  });

  it('should delete characters to the left (backspace)', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'abc')); // cursor at 3

    act(() => result.current.editDispatch({ type: 'DELETE_LEFT' }));
    expect(result.current.editState.buffer).toBe('ab');
    expect(result.current.editState.cursorPos).toBe(2);

    // Move to start, shouldn't delete
    act(() => result.current.editDispatch({ type: 'HOME' }));
    act(() => result.current.editDispatch({ type: 'DELETE_LEFT' }));
    expect(result.current.editState.buffer).toBe('ab');
  });

  it('should delete characters to the right (delete tab)', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'abc'));
    act(() => result.current.editDispatch({ type: 'HOME' })); // cursor at 0

    act(() => result.current.editDispatch({ type: 'DELETE_RIGHT' }));
    expect(result.current.editState.buffer).toBe('bc');
    expect(result.current.editState.cursorPos).toBe(0);
  });

  // Shared kill/word-delete contract — same table as text-buffer.test.ts, so
  // the Settings value editor and the shared buffer cannot drift.
  describe('kill / word-delete shortcuts (shared fixture)', () => {
    const setup = async (text: string, cursor: number) => {
      const { result } = await renderHook(() =>
        useInlineEditBuffer({ onCommit: mockOnCommit }),
      );
      act(() => result.current.startEditing('key', text));
      act(() => result.current.editDispatch({ type: 'HOME' }));
      for (let i = 0; i < cursor; i++) {
        act(() => result.current.editDispatch({ type: 'MOVE_RIGHT' }));
      }
      return result;
    };

    for (const c of KILL_LINE_CASES) {
      it(`ctrl+k (${c.name})`, async () => {
        const result = await setup(c.text, c.cursor);
        act(() => result.current.editDispatch({ type: 'KILL_RIGHT' }));
        expect(result.current.editState.buffer).toBe(c.killRight.text);
        expect(result.current.editState.cursorPos).toBe(c.killRight.cursor);
      });

      it(`ctrl+u (${c.name})`, async () => {
        const result = await setup(c.text, c.cursor);
        act(() => result.current.editDispatch({ type: 'KILL_LEFT' }));
        expect(result.current.editState.buffer).toBe(c.killLeft.text);
        expect(result.current.editState.cursorPos).toBe(c.killLeft.cursor);
      });

      it(`ctrl+w (${c.name})`, async () => {
        const result = await setup(c.text, c.cursor);
        act(() => result.current.editDispatch({ type: 'DELETE_WORD_LEFT' }));
        expect(result.current.editState.buffer).toBe(c.wordLeft.text);
        expect(result.current.editState.cursorPos).toBe(c.wordLeft.cursor);
      });
    }
  });

  it('should kill/word-delete a number field down to empty', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', '123'));
    act(() => result.current.editDispatch({ type: 'KILL_LEFT' }));
    expect(result.current.editState.buffer).toBe('');
    // Commit of an empty value behaves as today's repeated-backspace path.
    act(() => result.current.commitEdit());
    expect(mockOnCommit).toHaveBeenCalledWith('key', '');
  });

  it('should insert valid characters into string', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'ab'));
    act(() => result.current.editDispatch({ type: 'MOVE_LEFT' })); // cursor at 1

    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: 'x',
        isNumberType: false,
      }),
    );
    expect(result.current.editState.buffer).toBe('axb');
    expect(result.current.editState.cursorPos).toBe(2);
  });

  it('should validate number character insertions', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', '12'));

    // Valid number char
    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: '.',
        isNumberType: true,
      }),
    );
    expect(result.current.editState.buffer).toBe('12.');

    // Invalid number char
    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: 'a',
        isNumberType: true,
      }),
    );
    expect(result.current.editState.buffer).toBe('12.'); // Unchanged
  });

  it('should accept single CJK character input', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', ''));

    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: '中',
        isNumberType: false,
      }),
    );
    expect(result.current.editState.buffer).toBe('中');
    expect(result.current.editState.cursorPos).toBe(1);
  });

  it('should accept multi-character CJK IME input', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', ''));

    // IME commits multiple characters at once (e.g. "你好")
    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: '你好',
        isNumberType: false,
      }),
    );
    expect(result.current.editState.buffer).toBe('你好');
    expect(result.current.editState.cursorPos).toBe(2);
  });

  it('should insert CJK text at cursor position', async () => {
    const { result } = await renderHook(() =>
      useInlineEditBuffer({ onCommit: mockOnCommit }),
    );
    act(() => result.current.startEditing('key', 'ab'));
    act(() => result.current.editDispatch({ type: 'MOVE_LEFT' })); // cursor at 1

    act(() =>
      result.current.editDispatch({
        type: 'INSERT_CHAR',
        char: '世界',
        isNumberType: false,
      }),
    );
    expect(result.current.editState.buffer).toBe('a世界b');
    expect(result.current.editState.cursorPos).toBe(3); // 1 + 2 inserted codepoints
  });
});
