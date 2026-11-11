/**
 * Styled-text wrapping utilities.
 *
 * Ported from @jrichman/ink@6.6.7 build/text-wrap.js to standalone TypeScript.
 * Origin licence: MIT (Copyright (c) Vadym Demedes <vadimdemedes@hey.com>)
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 *
 * Exported symbol:
 *   wrapStyledChars – soft-wrap a StyledLine to fit within a column budget
 */

import { StyledLine } from './styled-line.js';
import { FULL_WIDTH_MASK } from './ansi-constants.js';

/**
 * Return the visible column width of the character at position `i` inside `line`.
 * Avoids a re-parse of the grapheme cluster by reading the FULL_WIDTH_MASK bit
 * that was already baked in during tokenisation.
 */
function charWidth(line: StyledLine, i: number): number {
  return (line.getFormatFlags(i) & FULL_WIDTH_MASK) !== 0 ? 2 : 1;
}

// ── Word-wrap ─────────────────────────────────────────────────────────────────

/**
 * Soft-wrap `line` to fit within `columns` visible columns.
 *
 * Rules:
 * - Newline characters produce an unconditional line break.
 * - Spaces that cause a wrap are dropped (leading spaces on new rows are kept).
 * - Words longer than `columns` are hard-wrapped character-by-character.
 *
 * Returns an array of StyledLines (one per output row).
 */
export const wrapStyledChars = (
  line: StyledLine,
  columns: number,
): StyledLine[] => {
  const rows: StyledLine[] = [];
  let currentRowStart = 0;
  let currentRowWidth = 0;
  let isAtStartOfLogicalLine = true;
  let i = 0;

  while (i < line.length) {
    const firstVal = line.getValue(i);

    // ── Explicit newline ──────────────────────────────────────────────────────
    if (firstVal === '\n') {
      rows.push(line.slice(currentRowStart, i));
      currentRowStart = i + 1;
      currentRowWidth = 0;
      isAtStartOfLogicalLine = true;
      i++;
      continue;
    }

    // ── Measure the next word (or single space) ───────────────────────────────
    let j = i;
    let wordWidth = 0;

    if (firstVal === ' ') {
      wordWidth = charWidth(line, i);
      j = i + 1;
    } else {
      while (
        j < line.length &&
        line.getValue(j) !== ' ' &&
        line.getValue(j) !== '\n'
      ) {
        wordWidth += charWidth(line, j);
        j++;
      }
    }

    // ── Word/space is [i, j) ──────────────────────────────────────────────────
    if (currentRowWidth + wordWidth > columns && currentRowWidth > 0) {
      if (firstVal === ' ' && !isAtStartOfLogicalLine) {
        // Drop a wrapping space
        i = j;
        continue;
      }
      // Finish the current row (trimming trailing spaces first)
      let trimEnd = i;
      while (trimEnd > currentRowStart && line.getValue(trimEnd - 1) === ' ')
        trimEnd--;
      rows.push(line.slice(currentRowStart, trimEnd));
      currentRowStart = i;
      currentRowWidth = 0;
      continue;
    }

    if (currentRowWidth === 0 && wordWidth > columns) {
      // ── Hard-wrap an overlong word ────────────────────────────────────────
      let k = i;
      let chunkWidth = 0;
      while (k < j) {
        const cw = charWidth(line, k);
        if (chunkWidth + cw > columns && chunkWidth > 0) {
          rows.push(line.slice(currentRowStart, k));
          currentRowStart = k;
          chunkWidth = 0;
        }
        chunkWidth += cw;
        k++;
      }
      currentRowWidth = chunkWidth;
      i = j;
      isAtStartOfLogicalLine = false;
    } else {
      // ── Word fits on current row ──────────────────────────────────────────
      currentRowWidth += wordWidth;
      i = j;
      if (firstVal !== ' ') isAtStartOfLogicalLine = false;
    }
  }

  if (currentRowStart < line.length || rows.length === 0) {
    rows.push(line.slice(currentRowStart));
  }

  return rows;
};
