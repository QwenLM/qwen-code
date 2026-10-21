/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TextareaRenderable } from '@opentui/core';
import { stripUnsafeCharacters } from '../utils/textUtils.js';
import type { VimBuffer } from '../hooks/vim.js';
import {
  applyVimAction,
  type VimAction,
} from '../components/shared/vim-buffer-actions.js';
import {
  replaceRangeInternal,
  handleTextBufferInput,
  applyWordDeletion,
  getWordMovePosition,
  type TextBufferGeometry,
} from '../components/shared/text-buffer.js';
import {
  codePointIndexToDisplayCol,
  displayColToCodePointIndex,
} from './input-prompt-model.js';

export function createVimBuffer(
  getEditor: () => TextareaRenderable | null,
): VimBuffer {
  const snapshot = (): TextBufferGeometry => {
    const editor = getEditor();
    const lines = (editor?.plainText ?? '').split('\n');
    const cursor = editor?.logicalCursor ?? { row: 0, col: 0 };
    return {
      lines,
      cursorRow: cursor.row,
      cursorCol: displayColToCodePointIndex(
        lines[cursor.row] ?? '',
        cursor.col,
      ),
      preferredCol: null,
    };
  };
  const apply = (next: TextBufferGeometry, edit: boolean) => {
    const editor = getEditor();
    if (!editor) return;
    // Even a no-op edit owns an undo point in Ink (for example dd on an empty line).
    if (edit) editor.replaceText(next.lines.join('\n'));
    editor.setCursor(
      next.cursorRow,
      codePointIndexToDisplayCol(
        next.lines[next.cursorRow] ?? '',
        next.cursorCol,
      ),
    );
  };
  const dispatch = (action: VimAction) => {
    let edit = false;
    const next = applyVimAction(snapshot(), action, (state) => {
      edit = true;
      return state;
    });
    apply(next, edit);
  };
  return {
    get text() {
      return getEditor()?.plainText ?? '';
    },
    get lines() {
      return snapshot().lines;
    },
    get cursor() {
      const state = snapshot();
      return [state.cursorRow, state.cursorCol];
    },
    handleInput: (key) => {
      const editor = getEditor();
      if (!editor) return;
      const insert = (text: string) => {
        const state = snapshot();
        apply(
          replaceRangeInternal(
            state,
            state.cursorRow,
            state.cursorCol,
            state.cursorRow,
            state.cursorCol,
            stripUnsafeCharacters(text.replace(/\r\n?/g, '\n')),
          ),
          true,
        );
      };
      const deleteWord = (
        direction: 'delete_word_left' | 'delete_word_right',
      ) => {
        let edit = false;
        const next = applyWordDeletion(snapshot(), direction, (state) => {
          edit = true;
          return state;
        });
        apply(next, edit);
      };
      handleTextBufferInput(key, {
        insert,
        newline: () => insert('\n'),
        move: (direction) => {
          if (direction === 'wordLeft' || direction === 'wordRight') {
            const state = snapshot();
            const target = getWordMovePosition(
              state.lines,
              state.cursorRow,
              state.cursorCol,
              direction,
            );
            apply(
              { ...state, cursorRow: target.row, cursorCol: target.col },
              false,
            );
          } else if (direction === 'left') editor.moveCursorLeft();
          else if (direction === 'right') editor.moveCursorRight();
          else if (direction === 'up') editor.moveCursorUp();
          else if (direction === 'down') editor.moveCursorDown();
          else if (direction === 'home') editor.gotoVisualLineHome();
          else editor.gotoVisualLineEnd();
        },
        deleteWordLeft: () => deleteWord('delete_word_left'),
        deleteWordRight: () => deleteWord('delete_word_right'),
        backspace: () => {
          if (editor.cursorOffset > 0) editor.deleteCharBackward();
        },
        del: () => {
          editor.deleteChar();
        },
        undo: () => {
          editor.undo();
        },
        redo: () => {
          editor.redo();
        },
      });
    },
    undo: () => {
      getEditor()?.undo();
    },
    replaceRange: (startRow, startCol, endRow, endCol, text) => {
      apply(
        replaceRangeInternal(
          snapshot(),
          startRow,
          startCol,
          endRow,
          endCol,
          text,
        ),
        true,
      );
    },
    vimDeleteWordForward: (count) =>
      dispatch({ type: 'vim_delete_word_forward', payload: { count } }),
    vimDeleteWordBackward: (count) =>
      dispatch({ type: 'vim_delete_word_backward', payload: { count } }),
    vimDeleteWordEnd: (count) =>
      dispatch({ type: 'vim_delete_word_end', payload: { count } }),
    vimChangeWordForward: (count) =>
      dispatch({ type: 'vim_change_word_forward', payload: { count } }),
    vimChangeWordBackward: (count) =>
      dispatch({ type: 'vim_change_word_backward', payload: { count } }),
    vimChangeWordEnd: (count) =>
      dispatch({ type: 'vim_change_word_end', payload: { count } }),
    vimDeleteLine: (count) =>
      dispatch({ type: 'vim_delete_line', payload: { count } }),
    vimChangeLine: (count) =>
      dispatch({ type: 'vim_change_line', payload: { count } }),
    vimMoveLeft: (count) =>
      dispatch({ type: 'vim_move_left', payload: { count } }),
    vimMoveRight: (count) =>
      dispatch({ type: 'vim_move_right', payload: { count } }),
    vimMoveUp: (count) => dispatch({ type: 'vim_move_up', payload: { count } }),
    vimMoveDown: (count) =>
      dispatch({ type: 'vim_move_down', payload: { count } }),
    vimMoveWordForward: (count) =>
      dispatch({ type: 'vim_move_word_forward', payload: { count } }),
    vimMoveWordBackward: (count) =>
      dispatch({ type: 'vim_move_word_backward', payload: { count } }),
    vimMoveWordEnd: (count) =>
      dispatch({ type: 'vim_move_word_end', payload: { count } }),
    vimDeleteChar: (count) =>
      dispatch({ type: 'vim_delete_char', payload: { count } }),
    vimDeleteToEndOfLine: () => dispatch({ type: 'vim_delete_to_end_of_line' }),
    vimChangeToEndOfLine: () => dispatch({ type: 'vim_change_to_end_of_line' }),
    vimInsertAtCursor: () => dispatch({ type: 'vim_insert_at_cursor' }),
    vimAppendAtCursor: () => dispatch({ type: 'vim_append_at_cursor' }),
    vimOpenLineBelow: () => dispatch({ type: 'vim_open_line_below' }),
    vimOpenLineAbove: () => dispatch({ type: 'vim_open_line_above' }),
    vimAppendAtLineEnd: () => dispatch({ type: 'vim_append_at_line_end' }),
    vimInsertAtLineStart: () => dispatch({ type: 'vim_insert_at_line_start' }),
    vimMoveToLineStart: () => dispatch({ type: 'vim_move_to_line_start' }),
    vimMoveToLineEnd: () => dispatch({ type: 'vim_move_to_line_end' }),
    vimMoveToFirstNonWhitespace: () =>
      dispatch({ type: 'vim_move_to_first_nonwhitespace' }),
    vimMoveToFirstLine: () => dispatch({ type: 'vim_move_to_first_line' }),
    vimMoveToLastLine: () => dispatch({ type: 'vim_move_to_last_line' }),
    vimEscapeInsertMode: () => dispatch({ type: 'vim_escape_insert_mode' }),
    vimChangeMovement: (movement, count) =>
      dispatch({ type: 'vim_change_movement', payload: { movement, count } }),
    vimDeleteMovement: (movement, count) =>
      dispatch({ type: 'vim_delete_movement', payload: { movement, count } }),
    vimMoveToLine: (lineNumber) =>
      dispatch({ type: 'vim_move_to_line', payload: { lineNumber } }),
  };
}
