/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveRenderLib,
  type TextareaRenderable,
  type WidthMethod,
} from '@opentui/core';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { cpLen, cpSlice } from '../utils/textUtils.js';

/** Native widths are only a view projection, never the logical edit position. */
export function projectTextBuffer(
  editor: TextareaRenderable,
  buffer: Pick<TextBuffer, 'text' | 'lines' | 'cursor'>,
  widthMethod: WidthMethod,
): void {
  if (editor.plainText !== buffer.text) editor.setText(buffer.text);
  const [row, col] = buffer.cursor;
  const prefix = cpSlice(buffer.lines[row] ?? '', 0, col);
  const lib = resolveRenderLib();
  const encoded = lib.encodeUnicode(prefix, widthMethod);
  if (!encoded) throw new Error('Could not measure the input cursor');
  let displayCol: number;
  try {
    displayCol = encoded.data.reduce((width, char) => width + char.width, 0);
  } finally {
    lib.freeUnicode(encoded);
  }
  const cursor = editor.logicalCursor;
  if (cursor.row !== row || cursor.col !== displayCol)
    editor.setCursor(row, displayCol);
}

/** Read a native mouse/selection boundary against the already projected text. */
export function nativeOffsetToCodePoint(
  editor: TextareaRenderable,
  offset: number,
): number {
  return cpLen(editor.editBuffer.getTextRange(0, offset));
}

/** Replace a visible selection as one existing Ink undo transaction. */
export function replaceNativeSelection(
  editor: TextareaRenderable,
  buffer: TextBuffer,
  text: string,
): boolean {
  const selection = editor.getSelection();
  if (!selection || selection.start === selection.end) return false;
  const start = nativeOffsetToCodePoint(editor, selection.start);
  const end = nativeOffsetToCodePoint(editor, selection.end);
  editor.clearSelection();
  buffer.replaceRangeByOffset(start, end, text);
  return true;
}
