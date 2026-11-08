/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VimBuffer } from '../hooks/vim.js';

/** Keep the entry's parser state while composers mount and unmount. */
export function createVimBuffer(getBuffer: () => VimBuffer): VimBuffer {
  return {
    get text() {
      return getBuffer().text;
    },
    get lines() {
      return getBuffer().lines;
    },
    get cursor() {
      return getBuffer().cursor;
    },
    handleInput: (key) => getBuffer().handleInput(key),
    undo: () => getBuffer().undo(),
    replaceRange: (startRow, startCol, endRow, endCol, text) =>
      getBuffer().replaceRange(startRow, startCol, endRow, endCol, text),
    vimDeleteWordForward: (count) => getBuffer().vimDeleteWordForward(count),
    vimDeleteWordBackward: (count) => getBuffer().vimDeleteWordBackward(count),
    vimDeleteWordEnd: (count) => getBuffer().vimDeleteWordEnd(count),
    vimChangeWordForward: (count) => getBuffer().vimChangeWordForward(count),
    vimChangeWordBackward: (count) => getBuffer().vimChangeWordBackward(count),
    vimChangeWordEnd: (count) => getBuffer().vimChangeWordEnd(count),
    vimDeleteLine: (count) => getBuffer().vimDeleteLine(count),
    vimChangeLine: (count) => getBuffer().vimChangeLine(count),
    vimMoveLeft: (count) => getBuffer().vimMoveLeft(count),
    vimMoveRight: (count) => getBuffer().vimMoveRight(count),
    vimMoveUp: (count) => getBuffer().vimMoveUp(count),
    vimMoveDown: (count) => getBuffer().vimMoveDown(count),
    vimMoveWordForward: (count) => getBuffer().vimMoveWordForward(count),
    vimMoveWordBackward: (count) => getBuffer().vimMoveWordBackward(count),
    vimMoveWordEnd: (count) => getBuffer().vimMoveWordEnd(count),
    vimDeleteChar: (count) => getBuffer().vimDeleteChar(count),
    vimDeleteToEndOfLine: () => getBuffer().vimDeleteToEndOfLine(),
    vimChangeToEndOfLine: () => getBuffer().vimChangeToEndOfLine(),
    vimInsertAtCursor: () => getBuffer().vimInsertAtCursor(),
    vimAppendAtCursor: () => getBuffer().vimAppendAtCursor(),
    vimOpenLineBelow: () => getBuffer().vimOpenLineBelow(),
    vimOpenLineAbove: () => getBuffer().vimOpenLineAbove(),
    vimAppendAtLineEnd: () => getBuffer().vimAppendAtLineEnd(),
    vimInsertAtLineStart: () => getBuffer().vimInsertAtLineStart(),
    vimMoveToLineStart: () => getBuffer().vimMoveToLineStart(),
    vimMoveToLineEnd: () => getBuffer().vimMoveToLineEnd(),
    vimMoveToFirstNonWhitespace: () =>
      getBuffer().vimMoveToFirstNonWhitespace(),
    vimMoveToFirstLine: () => getBuffer().vimMoveToFirstLine(),
    vimMoveToLastLine: () => getBuffer().vimMoveToLastLine(),
    vimEscapeInsertMode: () => getBuffer().vimEscapeInsertMode(),
    vimChangeMovement: (movement, count) =>
      getBuffer().vimChangeMovement(movement, count),
    vimDeleteMovement: (movement, count) =>
      getBuffer().vimDeleteMovement(movement, count),
    vimMoveToLine: (lineNumber) => getBuffer().vimMoveToLine(lineNumber),
  };
}
