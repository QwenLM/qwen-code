// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  textBufferReducer,
  type TextBufferState,
} from '../components/shared/text-buffer.js';
import { cpLen } from '../utils/textUtils.js';
import { useLineEdit } from './line-edit.js';

function historyKey(shift = false) {
  return { name: 'z', ctrl: true, meta: false, shift, sequence: '' };
}

function usePlainField(initial: string, mountKey: number) {
  const [value, setValue] = useState(initial);
  const line = useLineEdit(value, setValue, mountKey);
  return { value, setValue, line };
}

function useDigitField() {
  const [value, setValue] = useState('');
  const line = useLineEdit(value, (next) =>
    setValue(next.replace(/[^0-9]/g, '')),
  );
  return { value, line };
}

function inkState(): TextBufferState {
  return {
    lines: [''],
    cursorRow: 0,
    cursorCol: 0,
    preferredCol: null,
    undoStack: [],
    redoStack: [],
    clipboard: null,
    selectionAnchor: null,
    viewportWidth: 80,
    viewportHeight: 1,
    visualLayout: {
      visualLines: [''],
      logicalToVisualMap: [[[0, 0]]],
      visualToLogicalMap: [[0, 0]],
    },
  };
}

function inkView(state: TextBufferState) {
  return {
    text: state.lines.join('\n'),
    caret:
      state.lines
        .slice(0, state.cursorRow)
        .reduce((n, line) => n + cpLen(line) + 1, 0) + state.cursorCol,
  };
}

describe('dialog field undo/redo ownership', () => {
  it('matches the real Ink reducer for accepted edits and history in one read', () => {
    const { result } = renderHook(() => usePlainField('', 0));
    const field = result.current.line;
    let ink = inkState();
    act(() => {
      field.insert('a');
      ink = textBufferReducer(ink, { type: 'insert', payload: 'a' });
      field.insert('😀');
      ink = textBufferReducer(ink, { type: 'insert', payload: '😀' });
      expect(field.handleKey(historyKey())).toBe(true);
      ink = textBufferReducer(ink, { type: 'undo' });
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
      expect(field.handleKey(historyKey(true))).toBe(true);
      ink = textBufferReducer(ink, { type: 'redo' });
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
    });
    expect(result.current.value).toBe('a😀');
  });

  it('restores code-point carets and preserves redo after a caret-only move', () => {
    const { result } = renderHook(() => usePlainField('a😀b', 0));
    act(() => {
      result.current.line.handleKey({
        name: 'left',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '',
      });
    });
    act(() => result.current.line.insert('中'));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect({
      text: result.current.line.text,
      caret: result.current.line.caret,
    }).toEqual({ text: 'a😀b', caret: 2 });
    act(() => {
      result.current.line.handleKey({
        name: 'left',
        ctrl: false,
        meta: false,
        shift: false,
        sequence: '',
      });
    });
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect({
      text: result.current.line.text,
      caret: result.current.line.caret,
    }).toEqual({ text: 'a😀中b', caret: 3 });
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.line.caret).toBe(1);
  });

  it('records a multiline paste as one edit and invalidates redo on new text', () => {
    const { result } = renderHook(() => usePlainField('seed', 0));
    act(() => result.current.line.insert('one\ntwo😀'));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('seed');
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('seedone\ntwo😀');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    act(() => result.current.line.insert('!'));
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('seed!');
  });

  it('preserves prior accepted history when the owner rejects a new character', () => {
    const { result } = renderHook(() => useDigitField());
    for (const digit of '123') act(() => result.current.line.insert(digit));
    act(() => result.current.line.insert('x'));
    expect(result.current.value).toBe('123');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('12');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('1');
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('12');
  });

  it('does not discard redo when the owner rejects a proposal after Undo', () => {
    const { result } = renderHook(() => useDigitField());
    for (const digit of '123') act(() => result.current.line.insert(digit));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('12');
    act(() => result.current.line.insert('x'));
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('123');
  });

  it('records a detectable filtered value once while keeping older accepted edits', () => {
    const { result } = renderHook(() => useDigitField());
    for (const digit of '123') act(() => result.current.line.insert(digit));
    act(() => result.current.line.insert(',4'));
    expect(result.current.value).toBe('1234');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('123');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('12');
  });

  it('keeps history and redo for no-op inserts', () => {
    const { result } = renderHook(() => usePlainField('', 0));
    act(() => result.current.line.insert('a'));
    act(() => result.current.line.insert('b'));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('a');
    act(() => result.current.line.insert(''));
    act(() => {
      result.current.line.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('ab');
  });

  it('treats a mounted external replacement as one accepted edit', () => {
    const { result } = renderHook(() => usePlainField('a', 0));
    act(() => result.current.line.insert('b'));
    act(() => result.current.setValue('external'));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('ab');
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('a');
  });

  it('starts fresh history on mountKey change and blocks trailing settled keys', () => {
    const { result, rerender } = renderHook(
      ({ id }) => usePlainField('a', id),
      {
        initialProps: { id: 0 },
      },
    );
    act(() => result.current.line.insert('b'));
    act(() => {
      const field = result.current.line;
      field.settle();
      expect(field.handleKey(historyKey())).toBe(false);
      field.insert('ignored');
    });
    expect(result.current.value).toBe('ab');
    rerender({ id: 1 });
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('ab');
    act(() => result.current.line.insert('c'));
    act(() => {
      result.current.line.handleKey(historyKey());
    });
    expect(result.current.value).toBe('ab');
  });

  it('has the same 100-entry cap as Ink', () => {
    const { result } = renderHook(() => usePlainField('', 0));
    let ink = inkState();
    act(() => {
      const field = result.current.line;
      for (let i = 0; i < 105; i++) {
        field.insert('x');
        ink = textBufferReducer(ink, { type: 'insert', payload: 'x' });
      }
      for (let i = 0; i < 105; i++) {
        field.handleKey(historyKey());
        ink = textBufferReducer(ink, { type: 'undo' });
      }
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
    });
    expect(result.current.value).toBe('xxxxx');
  });
});

describe('TextInput-owned clear transactions', () => {
  it('matches Ink setText clear and its Unicode multiline undo/redo in one read', () => {
    const { result } = renderHook(() => usePlainField('', 0));
    const field = result.current.line;
    let ink = inkState();
    act(() => {
      field.insert('a😀\nb');
      ink = textBufferReducer(ink, { type: 'insert', payload: 'a😀\nb' });
      field.clear();
      ink = textBufferReducer(ink, { type: 'set_text', payload: '' });
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
      field.handleKey(historyKey());
      ink = textBufferReducer(ink, { type: 'undo' });
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
      field.handleKey(historyKey(true));
      ink = textBufferReducer(ink, { type: 'redo' });
      expect({ text: field.text, caret: field.caret }).toEqual(inkView(ink));
    });
    expect(result.current.value).toBe('');
  });

  it('does not spend history or discard redo when clearing an already empty field', () => {
    const { result } = renderHook(() => usePlainField('', 0));
    const field = result.current.line;
    act(() => {
      field.insert('kept');
      field.handleKey(historyKey());
      field.clear();
      field.handleKey(historyKey(true));
    });
    expect(result.current.value).toBe('kept');
  });

  it('cannot clear a settled field but re-arms after an actual mount change', () => {
    const { result, rerender } = renderHook(
      ({ mountKey }) => usePlainField('kept', mountKey),
      { initialProps: { mountKey: 0 } },
    );
    act(() => {
      result.current.line.settle();
      result.current.line.clear();
    });
    expect(result.current.value).toBe('kept');
    rerender({ mountKey: 1 });
    act(() => result.current.line.clear());
    expect(result.current.value).toBe('');
  });
});
