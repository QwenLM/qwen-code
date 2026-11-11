/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useCallback, useEffect, useState } from 'react';
import { cpSlice, cpLen, stripUnsafeCharacters } from '../utils/textUtils.js';
import { findPrevWordStartInLine } from '../components/shared/text-buffer.js';

export interface EditBufferState {
  editingKey: string | null;
  buffer: string;
  cursorPos: number;
}

export type EditBufferAction =
  | { type: 'START_EDIT'; key: string; initialValue: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'MOVE_LEFT' }
  | { type: 'MOVE_RIGHT' }
  | { type: 'HOME' }
  | { type: 'END' }
  | { type: 'DELETE_LEFT' }
  | { type: 'DELETE_RIGHT' }
  | { type: 'KILL_RIGHT' }
  | { type: 'KILL_LEFT' }
  | { type: 'DELETE_WORD_LEFT' }
  | { type: 'INSERT_CHAR'; char: string; isNumberType: boolean };

const initialState: EditBufferState = {
  editingKey: null,
  buffer: '',
  cursorPos: 0,
};

function editBufferReducer(
  state: EditBufferState,
  action: EditBufferAction,
): EditBufferState {
  switch (action.type) {
    case 'START_EDIT':
      return {
        editingKey: action.key,
        buffer: action.initialValue,
        cursorPos: cpLen(action.initialValue),
      };

    case 'COMMIT_EDIT':
      return initialState;

    case 'MOVE_LEFT':
      return {
        ...state,
        cursorPos: Math.max(0, state.cursorPos - 1),
      };

    case 'MOVE_RIGHT':
      return {
        ...state,
        cursorPos: Math.min(cpLen(state.buffer), state.cursorPos + 1),
      };

    case 'HOME':
      return { ...state, cursorPos: 0 };

    case 'END':
      return { ...state, cursorPos: cpLen(state.buffer) };

    case 'DELETE_LEFT': {
      if (state.cursorPos === 0) return state;
      const before = cpSlice(state.buffer, 0, state.cursorPos - 1);
      const after = cpSlice(state.buffer, state.cursorPos);
      return {
        ...state,
        buffer: before + after,
        cursorPos: state.cursorPos - 1,
      };
    }

    case 'DELETE_RIGHT': {
      if (state.cursorPos === cpLen(state.buffer)) return state;
      const before = cpSlice(state.buffer, 0, state.cursorPos);
      const after = cpSlice(state.buffer, state.cursorPos + 1);
      return {
        ...state,
        buffer: before + after,
      };
    }

    case 'KILL_RIGHT': {
      // Delete from cursor to end of line; cursor stays put.
      if (state.cursorPos >= cpLen(state.buffer)) return state;
      return {
        ...state,
        buffer: cpSlice(state.buffer, 0, state.cursorPos),
      };
    }

    case 'KILL_LEFT': {
      // Delete from start of line to cursor; cursor moves to 0.
      if (state.cursorPos === 0) return state;
      return {
        ...state,
        buffer: cpSlice(state.buffer, state.cursorPos),
        cursorPos: 0,
      };
    }

    case 'DELETE_WORD_LEFT': {
      // Delete the word left of the cursor using engine B's boundary rule so
      // the two engines agree (see text-buffer.ts findPrevWordStartInLine).
      const start = findPrevWordStartInLine(state.buffer, state.cursorPos);
      if (start === null) return state;
      const before = cpSlice(state.buffer, 0, start);
      const after = cpSlice(state.buffer, state.cursorPos);
      return {
        ...state,
        buffer: before + after,
        cursorPos: start,
      };
    }

    case 'INSERT_CHAR': {
      let ch = action.char;

      if (action.isNumberType) {
        // Number fields: only accept digits, sign, and decimal point
        const filtered = ch.replace(/[^0-9\-+.]/g, '');
        if (filtered.length === 0) return state;
        ch = filtered;
      } else {
        // String fields: strip unsafe characters, reject if empty
        ch = stripUnsafeCharacters(ch);
        if (ch.length === 0) return state;
        // Reject remaining control characters (code point < 32)
        // while preserving multi-character IME input (e.g. CJK)
        const segmenter = new Intl.Segmenter();
        const cps = Array.from(segmenter.segment(ch), (s) => s.segment).filter(
          (c) => (c.codePointAt(0) ?? 0) >= 32,
        );
        if (cps.length === 0) return state;
        ch = cps.join('');
      }

      const insertedCpLen = cpLen(ch);
      const before = cpSlice(state.buffer, 0, state.cursorPos);
      const after = cpSlice(state.buffer, state.cursorPos);
      return {
        ...state,
        buffer: before + ch + after,
        cursorPos: state.cursorPos + insertedCpLen,
      };
    }

    default:
      return state;
  }
}

export interface UseEditBufferProps {
  onCommit: (key: string, value: string) => boolean | void;
}

export function useInlineEditBuffer({ onCommit }: UseEditBufferProps) {
  const [state, dispatch] = useReducer(editBufferReducer, initialState);
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (!state.editingKey) {
      setCursorVisible(true);
      return;
    }
    setCursorVisible(true);
    const interval = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 500);
    return () => clearInterval(interval);
  }, [state.editingKey, state.buffer, state.cursorPos]);

  const startEditing = useCallback((key: string, initialValue: string) => {
    dispatch({ type: 'START_EDIT', key, initialValue });
  }, []);

  const commitEdit = useCallback(() => {
    if (state.editingKey) {
      const committed = onCommit(state.editingKey, state.buffer);
      if (committed === false) return false;
    }
    dispatch({ type: 'COMMIT_EDIT' });
    return true;
  }, [state.editingKey, state.buffer, onCommit]);

  return {
    editState: state,
    editDispatch: dispatch,
    startEditing,
    commitEdit,
    cursorVisible,
  };
}
