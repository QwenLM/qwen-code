/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stringWidth from 'string-width';

/*
**Background & Purpose:**

The `findSafeSplitPoint` function is designed to address the challenge of displaying or processing large, potentially streaming, pieces of Markdown text. When content (e.g., from an LLM like Gemini) arrives in chunks or grows too large for a single display unit (like a message bubble), it needs to be split. A naive split (e.g., just at a character limit) can break Markdown formatting, especially critical for multi-line elements like code blocks, lists, or blockquotes, leading to incorrect rendering.

This function aims to find an *intelligent* or "safe" index within the provided `content` string at which to make such a split, prioritizing the preservation of Markdown integrity.

**Key Expectations & Behavior (Prioritized):**

1.  **No Split if Short Enough:**
    * If `content.length` is less than or equal to `idealMaxLength`, the function should return `content.length` (indicating no split is necessary for length reasons).

2.  **Code Block Integrity (Highest Priority for Safety):**
    * The function must try to avoid splitting *inside* a fenced code block (i.e., between ` ``` ` and ` ``` `).
    * If `idealMaxLength` falls within a code block:
        * The function will attempt to return an index that splits the content *before* the start of that code block.
        * If a code block starts at the very beginning of the `content` and `idealMaxLength` falls within it (meaning the block itself is too long for the first chunk), the function might return `0`. This effectively makes the first chunk empty, pushing the entire oversized code block to the second part of the split.
    * When considering splits near code blocks, the function prefers to keep the entire code block intact in one of the resulting chunks.

3.  **Markdown-Aware Newline Splitting (If Not Governed by Code Block Logic):**
    * If `idealMaxLength` does not fall within a code block (or after code block considerations have been made), the function will look for natural break points by scanning backwards from `idealMaxLength`:
        * **Paragraph Breaks:** It prioritizes splitting after a double newline (`\n\n`), as this typically signifies the end of a paragraph or a block-level element.
        * **Single Line Breaks:** If no double newline is found in a suitable range, it will look for a single newline (`\n`).
    * Any newline chosen as a split point must also not be inside a code block.

4.  **Fall back to `idealMaxLength`:**
    * If no "safer" split point (respecting code blocks or finding suitable newlines) is identified before or at `idealMaxLength`, and `idealMaxLength` itself is not determined to be an unsafe split point (e.g., inside a code block), the function may return a length larger than `idealMaxLength`, again it CANNOT break markdown formatting. This could happen with very long lines of text without Markdown block structures or newlines.

**In essence, `findSafeSplitPoint` tries to be a good Markdown citizen when forced to divide content, preferring structural boundaries over arbitrary character limits, with a strong emphasis on not corrupting code blocks.**
*/

/**
 * Checks if a given character index within a string is inside a fenced (```) code block.
 * @param content The full string content.
 * @param indexToTest The character index to test.
 * @returns True if the index is inside a code block's content, false otherwise.
 */
const isIndexInsideCodeBlock = (
  content: string,
  indexToTest: number,
): boolean => {
  let fenceCount = 0;
  let searchPos = 0;
  while (searchPos < content.length) {
    const nextFence = content.indexOf('```', searchPos);
    if (nextFence === -1 || nextFence >= indexToTest) {
      break;
    }
    fenceCount++;
    searchPos = nextFence + 3;
  }
  return fenceCount % 2 === 1;
};

/**
 * Finds the starting index of the code block that encloses the given index.
 * Returns -1 if the index is not inside a code block.
 * @param content The markdown content.
 * @param index The index to check.
 * @returns Start index of the enclosing code block or -1.
 */
const findEnclosingCodeBlockStart = (
  content: string,
  index: number,
): number => {
  if (!isIndexInsideCodeBlock(content, index)) {
    return -1;
  }
  let currentSearchPos = 0;
  while (currentSearchPos < index) {
    const blockStartIndex = content.indexOf('```', currentSearchPos);
    if (blockStartIndex === -1 || blockStartIndex >= index) {
      break;
    }
    const blockEndIndex = content.indexOf('```', blockStartIndex + 3);
    if (blockStartIndex < index) {
      if (blockEndIndex === -1 || index < blockEndIndex + 3) {
        return blockStartIndex;
      }
    }
    if (blockEndIndex === -1) break;
    currentSearchPos = blockEndIndex + 3;
  }
  return -1;
};

export interface SafeSplitOptions {
  /**
   * Current terminal width. Used together with `terminalHeight` to decide
   * whether the pending region is at risk of outgrowing what Ink can erase
   * with its cursor-up-and-redraw mechanism.
   */
  terminalWidth?: number;
  /** Current terminal height (rows). */
  terminalHeight?: number;
}

/**
 * Rough upper bound for how many rendered rows `content` would occupy at
 * `terminalWidth`. Uses `string-width` so CJK/emoji wide chars are counted
 * correctly. Mirrors how Ink's `wrap="wrap"` Text + the terminal's soft-wrap
 * would render the content.
 */
export const estimateRenderedLines = (
  content: string,
  terminalWidth: number,
): number => {
  if (terminalWidth <= 0) return 0;
  let total = 0;
  for (const line of content.split('\n')) {
    total += Math.max(1, Math.ceil(stringWidth(line) / terminalWidth));
  }
  return total;
};

/**
 * Walks backward from the end of `content` for the last `\n` that is not
 * inside a fenced code block. Returns the index just after that `\n` (so the
 * caller can safely slice `content.substring(0, n)` / `content.substring(n)`).
 * Returns 0 when no safe single newline exists.
 */
const findLastSafeNewline = (content: string): number => {
  let searchStartIndex = content.length;
  while (searchStartIndex > 0) {
    const nlIndex = content.lastIndexOf('\n', searchStartIndex - 1);
    if (nlIndex === -1) break;
    const potentialSplitPoint = nlIndex + 1;
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }
    searchStartIndex = nlIndex;
  }
  return 0;
};

/**
 * Narrow-width threshold below which we proactively commit completed lines to
 * `<Static>` on every incoming streaming chunk. Ink's dynamic region erase
 * only works within the current viewport — anything that has scrolled past
 * the top cannot be cleared, which is what produces the duplicated output
 * users see on small tmux panes (see issues #2912 / #3279).
 *
 * 80 columns mirrors the cap used by `mainAreaWidth` (`AppContainer.tsx`).
 */
const NARROW_WIDTH_COL_THRESHOLD = 80;

/**
 * Proportion of the viewport that may be occupied by the pending region
 * before we aggressively split at a single `\n` even in wider terminals.
 * Keeping the pending region well under the viewport guarantees Ink can
 * always erase-and-redraw without leaving orphan rows.
 */
const PENDING_VIEWPORT_FRACTION = 0.5;

export const findLastSafeSplitPoint = (
  content: string,
  options?: SafeSplitOptions,
): number => {
  const enclosingBlockStart = findEnclosingCodeBlockStart(
    content,
    content.length,
  );
  if (enclosingBlockStart !== -1) {
    // The end of the content is contained in a code block. Split right before.
    return enclosingBlockStart;
  }

  // Search for the last double newline (\n\n) not in a code block.
  let searchStartIndex = content.length;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf('\n\n', searchStartIndex);
    if (dnlIndex === -1) {
      // No more double newlines found.
      break;
    }

    const potentialSplitPoint = dnlIndex + 2;
    if (!isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }

    // If potentialSplitPoint was inside a code block,
    // the next search should start *before* the \n\n we just found to ensure progress.
    searchStartIndex = dnlIndex - 1;
  }

  // Preventive single-`\n` split. When no `\n\n` paragraph break is available
  // and the terminal is either narrow (which soft-wraps each logical line to
  // many rows) or the pending buffer is already approaching the viewport
  // height, proactively commit all completed lines to the static region and
  // keep only the in-flight partial in the pending region.
  //
  // Rationale: Ink's dynamic region is redrawn by cursor-up + erase-lines.
  // Anything that has scrolled past the top of the viewport cannot be
  // erased, so as soon as the pending region risks exceeding the viewport
  // we must offload earlier lines before that boundary is crossed —
  // otherwise scrollback accumulates every intermediate streaming frame.
  if (
    options &&
    options.terminalWidth !== undefined &&
    options.terminalHeight !== undefined &&
    options.terminalWidth > 0 &&
    options.terminalHeight > 0
  ) {
    const isNarrow = options.terminalWidth < NARROW_WIDTH_COL_THRESHOLD;
    const viewportBudget = Math.max(
      1,
      Math.floor(options.terminalHeight * PENDING_VIEWPORT_FRACTION),
    );
    const pendingApproachingViewport =
      estimateRenderedLines(content, options.terminalWidth) >= viewportBudget;

    if (isNarrow || pendingApproachingViewport) {
      const lastNewline = findLastSafeNewline(content);
      if (lastNewline > 0) {
        return lastNewline;
      }
    }
  }

  // If no safe split point is found, return content.length to keep the
  // entire content as one piece.
  return content.length;
};
