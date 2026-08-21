/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt-click caret placement for the OpenTUI composer (PR1 slice 4).
 *
 * Framework-neutral port of `utils/input-mouse.ts#visualClickToOffset` with
 * identical semantics: a left-click inside the prompt input maps a visual
 * line + visual column (terminal cells from the start of the text) onto a
 * logical cursor offset. Width is accumulated per code point so wide
 * characters (CJK, emoji) snap to the nearer side of the glyph midpoint and
 * zero-width code points (combining marks, ZWJ) stay attached to the
 * preceding glyph.
 */

import {
  toCodePoints,
  cpLen,
  getCachedStringWidth,
} from '../utils/textUtils.js';
import { logicalPosToOffset } from '../components/shared/text-buffer.js';

/** The slice of buffer state click mapping reads (parity with ink's). */
export interface ClickableBufferState {
  /** All visual (wrapped) lines for the current text + width. */
  allVisualLines: string[];
  /**
   * For each visual line, `[logicalLineIndex, startColInLogicalLine]` in code
   * points — where that visual line begins within its logical line.
   */
  visualToLogicalMap: Array<[number, number]>;
  /** Logical lines (newline-split). */
  lines: string[];
}

/**
 * Convert a click at `absoluteVisualRow` (index into allVisualLines) and
 * `clickVisualCol` (terminal cells from the start of the text, with the
 * prefix already excluded) into a logical cursor offset, or null if the row
 * maps to no line. Parity with `input-mouse.ts#visualClickToOffset`.
 */
export function visualClickToOffset(
  buffer: ClickableBufferState,
  absoluteVisualRow: number,
  clickVisualCol: number,
): number | null {
  const mapping = buffer.visualToLogicalMap[absoluteVisualRow];
  if (!mapping) return null;
  const [logicalLineIndex, startColInLogical] = mapping;

  const visualLineText = buffer.allVisualLines[absoluteVisualRow] ?? '';
  const chars = toCodePoints(visualLineText);

  let accumulatedWidth = 0;
  let codePointIndex = 0;
  for (let i = 0; i < chars.length; i++) {
    const charWidth = getCachedStringWidth(chars[i]!);
    if (charWidth <= 0) {
      // Zero-width code points stay attached to the preceding glyph: advance
      // past them without consuming a column so the cursor lands after the
      // full grapheme rather than between the base char and its mark.
      codePointIndex = i + 1;
      continue;
    }
    if (accumulatedWidth + charWidth > clickVisualCol) {
      // The click falls within this glyph's cells. For wide glyphs snap to
      // the side of the midpoint the click lands on: a 1-cell character
      // resolves to its left boundary, the right cell of a 2-cell character
      // to the boundary after it.
      const offsetWithinChar = clickVisualCol - accumulatedWidth;
      if (offsetWithinChar >= Math.ceil(charWidth / 2)) {
        codePointIndex = i + 1;
        while (
          codePointIndex < chars.length &&
          getCachedStringWidth(chars[codePointIndex]!) <= 0
        ) {
          codePointIndex++;
        }
      } else {
        codePointIndex = i;
      }
      break;
    }
    accumulatedWidth += charWidth;
    codePointIndex = i + 1;
  }

  const logicalCol = startColInLogical + codePointIndex;
  const lineLength = cpLen(buffer.lines[logicalLineIndex] ?? '');
  return logicalPosToOffset(
    buffer.lines,
    logicalLineIndex,
    Math.min(logicalCol, lineLength),
  );
}
