// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextareaRenderable } from '@opentui/core';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import {
  nativeOffsetToCodePoint,
  projectTextBuffer,
  replaceNativeSelection,
} from './text-buffer-view.js';

const native = vi.hoisted(() => ({ encode: vi.fn(), free: vi.fn() }));
vi.mock('@opentui/core', () => ({
  resolveRenderLib: () => ({
    encodeUnicode: native.encode,
    freeUnicode: native.free,
  }),
}));

beforeEach(() => {
  native.encode.mockReset().mockImplementation((text: string) => ({
    data: [{ width: getCachedStringWidth(text) }],
  }));
  native.free.mockClear();
});

function view(text: string) {
  let selection: { start: number; end: number } | null = null;
  const editor = {
    plainText: text,
    logicalCursor: { row: 0, col: 0 },
    setText: vi.fn((next: string) => {
      editor.plainText = next;
    }),
    setCursor: vi.fn((row: number, col: number) => {
      editor.logicalCursor = { row, col };
      selection = null;
    }),
    getSelection: () => selection,
    clearSelection: vi.fn(() => {
      selection = null;
    }),
    editBuffer: {
      getTextRange: vi.fn<(start: number, end: number) => string>(),
    },
  };
  return {
    native: editor as unknown as TextareaRenderable,
    editor,
    select: (start: number, end: number) => {
      selection = { start, end };
    },
  };
}

function owner(text: string) {
  return renderHook(() =>
    useTextBuffer({
      initialText: text,
      initialCursorOffset: [...text].length,
      viewport: { width: 40, height: 8 },
      isValidPath: () => false,
    }),
  );
}

describe('native view over the Ink edit owner', () => {
  it('does not round-trip two logical positions sharing the same visible cell', () => {
    const text = '甲🙂e\u0301';
    const buffer = owner(text);
    const projected = view(text);
    projectTextBuffer(projected.native, buffer.result.current, 'unicode');
    expect(projected.editor.logicalCursor).toEqual({ row: 0, col: 5 });
    expect(buffer.result.current.cursor).toEqual([0, 4]);
    act(() => buffer.result.current.moveToOffset(3));
    projectTextBuffer(projected.native, buffer.result.current, 'unicode');
    expect(projected.editor.logicalCursor).toEqual({ row: 0, col: 5 });
    expect(buffer.result.current.cursor).toEqual([0, 3]);
    act(() => buffer.result.current.insert('Z'));
    expect(buffer.result.current.text).toBe('甲🙂eZ\u0301');
    act(() => buffer.result.current.undo());
    expect(buffer.result.current.cursor).toEqual([0, 3]);
  });

  it('measures the complete ZWJ prefix using the selected native width method', () => {
    const text = '👨‍👩‍👧‍👦';
    const buffer = owner(text);
    const projected = view('');
    projectTextBuffer(projected.native, buffer.result.current, 'unicode');
    expect(native.encode).toHaveBeenCalledExactlyOnceWith(text, 'unicode');
    expect(projected.editor.plainText).toBe(text);
    expect(projected.editor.logicalCursor).toEqual({ row: 0, col: 2 });
    expect(buffer.result.current.cursor).toEqual([0, 7]);
    expect(native.free).toHaveBeenCalledTimes(1);
  });

  it('uses returned native prefix text for explicit mouse/selection offsets, including combining marks', () => {
    const text = '甲🙂e\u0301tail';
    const buffer = owner(text);
    const projected = view(text);
    projected.editor.editBuffer.getTextRange.mockImplementation(
      (_start, end) => (end === 4 ? '甲🙂' : '甲🙂e\u0301'),
    );
    expect(nativeOffsetToCodePoint(projected.native, 5)).toBe(4);
    projected.select(4, 5);
    act(() => {
      expect(
        replaceNativeSelection(projected.native, buffer.result.current, 'X'),
      ).toBe(true);
    });
    expect(buffer.result.current.text).toBe('甲🙂Xtail');
    expect(buffer.result.current.cursor).toEqual([0, 3]);
    expect(projected.editor.clearSelection).toHaveBeenCalledTimes(1);
    act(() => buffer.result.current.undo());
    expect(buffer.result.current.text).toBe(text);
    act(() => buffer.result.current.redo());
    expect(buffer.result.current.text).toBe('甲🙂Xtail');
  });

  it('does not introduce an undo entry for an absent or collapsed native selection', () => {
    const buffer = owner('base');
    const projected = view('base');
    act(() => buffer.result.current.insert('Z'));
    expect(
      replaceNativeSelection(projected.native, buffer.result.current, 'X'),
    ).toBe(false);
    projected.select(2, 2);
    expect(
      replaceNativeSelection(projected.native, buffer.result.current, 'X'),
    ).toBe(false);
    act(() => buffer.result.current.undo());
    expect(buffer.result.current.text).toBe('base');
    expect(projected.editor.editBuffer.getTextRange).not.toHaveBeenCalled();
  });
});
