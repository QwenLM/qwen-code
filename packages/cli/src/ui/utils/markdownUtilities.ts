/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

interface MarkdownLine {
  text: string;
  start: number;
  endWithNewline: number;
}

interface FenceMarker {
  char: '`' | '~';
  length: number;
}

interface OpenFence extends FenceMarker {
  start: number;
}

const fenceLineRegex = /^ {0,3}(`{3,}|~{3,})/;
const listItemRegex = /^ {0,3}(?:[-+*]\s+\S|\d{1,9}[.)]\s+\S)/;
const indentedContinuationRegex = /^[ \t]{2,}\S/;

const getMarkdownLines = (content: string): MarkdownLine[] => {
  const lines: MarkdownLine[] = [];
  let start = 0;

  while (start < content.length) {
    const newlineIndex = content.indexOf('\n', start);
    if (newlineIndex === -1) {
      lines.push({
        text: content.slice(start),
        start,
        endWithNewline: content.length,
      });
      break;
    }

    lines.push({
      text: content.slice(start, newlineIndex),
      start,
      endWithNewline: newlineIndex + 1,
    });
    start = newlineIndex + 1;
  }

  return lines;
};

/**
 * Fenced Markdown blocks/tables/lists can safely move from the live pending
 * region to Static once a whole block has been received. Keeping only the
 * unfinished tail live reduces reflow churn on narrow terminals.
 */
const getFenceMarker = (line: string): FenceMarker | undefined => {
  const match = fenceLineRegex.exec(line);
  const marker = match?.[1];
  if (!marker) {
    return undefined;
  }

  return {
    char: marker[0] as '`' | '~',
    length: marker.length,
  };
};

const isClosingFence = (marker: FenceMarker, openFence: OpenFence): boolean =>
  marker.char === openFence.char && marker.length >= openFence.length;

const getTableCells = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return [];
  }

  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
};

const isTableRow = (line: string): boolean => {
  const cells = getTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
};

const isTableSeparatorRow = (line: string): boolean => {
  const cells = getTableCells(line);
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))
  );
};

const isListLine = (line: string, isInListRun: boolean): boolean =>
  listItemRegex.test(line) ||
  (isInListRun && indentedContinuationRegex.test(line));

const chooseLastSafePoint = (
  content: string,
  safeSplitPoints: number[],
): number => {
  const sortedSafeSplitPoints = [...new Set(safeSplitPoints)]
    .filter((point) => point > 0)
    .sort((a, b) => a - b);

  for (let i = sortedSafeSplitPoints.length - 1; i >= 0; i--) {
    const point = sortedSafeSplitPoints[i];
    if (point >= content.length) {
      return content.length;
    }

    if (content.slice(point).trim().length > 0) {
      return point;
    }
  }

  return content.length;
};

export const findLastSafeSplitPoint = (content: string) => {
  const lines = getMarkdownLines(content);
  const safeSplitPoints: number[] = [];
  let openFence: OpenFence | undefined;
  let tableRunEnd: number | undefined;
  let tableRunHasSeparator = false;
  let listRunEnd: number | undefined;

  const closeTableRun = () => {
    if (tableRunEnd !== undefined && tableRunHasSeparator) {
      safeSplitPoints.push(tableRunEnd);
    }
    tableRunEnd = undefined;
    tableRunHasSeparator = false;
  };

  const closeListRun = () => {
    if (listRunEnd !== undefined) {
      safeSplitPoints.push(listRunEnd);
    }
    listRunEnd = undefined;
  };

  for (const line of lines) {
    const fenceMarker = getFenceMarker(line.text);

    if (openFence) {
      if (fenceMarker && isClosingFence(fenceMarker, openFence)) {
        openFence = undefined;
        safeSplitPoints.push(line.endWithNewline);
      }
      continue;
    }

    if (fenceMarker) {
      closeTableRun();
      closeListRun();
      openFence = {
        ...fenceMarker,
        start: line.start,
      };
      continue;
    }

    if (line.text.trim().length === 0) {
      closeTableRun();
      closeListRun();
      safeSplitPoints.push(line.endWithNewline);
      continue;
    }

    if (isTableRow(line.text)) {
      tableRunEnd = line.endWithNewline;
      tableRunHasSeparator =
        tableRunHasSeparator || isTableSeparatorRow(line.text);
    } else {
      closeTableRun();
    }

    if (isListLine(line.text, listRunEnd !== undefined)) {
      listRunEnd = line.endWithNewline;
    } else {
      closeListRun();
    }
  }

  if (openFence) {
    // The end of the content is contained in a code block. Split right before.
    return openFence.start;
  }

  closeTableRun();
  closeListRun();

  return chooseLastSafePoint(content, safeSplitPoints);
};
