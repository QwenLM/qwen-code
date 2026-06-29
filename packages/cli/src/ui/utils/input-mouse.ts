/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helper for mapping a click inside the prompt input — a visual line
 * (absolute index into the buffer's visual lines) and a visual column (terminal
 * cells from the start of the text) — onto a logical cursor offset in the text
 * buffer. The DOM measurement that produces the visual row/col lives in the
 * component that owns the input box.
 */

import { toCodePoints, cpLen, getCachedStringWidth } from './textUtils.js';
import { logicalPosToOffset } from '../components/shared/text-buffer.js';

/** The slice of TextBuffer state this helper reads. */
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
 * `clickVisualCol` (terminal cells from the start of the text, with the prefix
 * already excluded) into a logical cursor offset, or null if the row maps to no
 * line.
 *
 * Walks code points accumulating display width so wide characters (CJK, emoji)
 * map correctly, landing the cursor on the character boundary the click falls
 * within. The resulting column is clamped to the logical line length.
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
    const charWidth = Math.max(getCachedStringWidth(chars[i]!), 1);
    if (accumulatedWidth + charWidth > clickVisualCol) {
      codePointIndex = i;
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
