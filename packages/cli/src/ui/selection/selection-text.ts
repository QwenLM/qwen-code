/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadonlyFrame } from 'ink';
import type { NormalizedSelection } from './selection-state.js';

/**
 * Extracts the visual text of a selection from a composited frame.
 *
 * B1 fidelity: the text is exactly what is displayed. Wide-character spacer
 * cells carry an empty value and contribute nothing, so a wide glyph appears
 * once. Per-line trailing whitespace is trimmed. Soft-wrapped logical lines are
 * NOT rejoined and decoration cells are NOT excluded — that is PR 2 (semantic
 * fidelity), which needs renderer metadata not present in the raw frame.
 */
export function getSelectedText(
  frame: ReadonlyFrame | null,
  selection: NormalizedSelection,
): string {
  if (!frame) {
    return '';
  }
  const { sx, sy, ex, ey } = selection;
  const lines: string[] = [];
  for (let y = sy; y <= ey; y++) {
    const row = frame.cells[y];
    if (!row) {
      lines.push('');
      continue;
    }
    const startX = y === sy ? sx : 0;
    const endX = y === ey ? ex : row.length - 1;
    let text = '';
    for (let x = Math.max(0, startX); x <= endX && x < row.length; x++) {
      text += row[x].value;
    }
    lines.push(text.replace(/\s+$/u, ''));
  }
  return lines.join('\n');
}
