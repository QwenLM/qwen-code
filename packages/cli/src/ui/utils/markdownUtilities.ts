/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/*
**Background & Purpose:**

The `findLastSafeSplitPoint` function finds an index where a large or
streaming Markdown string can be split. It prefers Markdown-friendly boundaries
so rendered history chunks do not break fenced code blocks unnecessarily.

**Behavior, in priority order:**

1.  **No split if already short enough:**
    * When `idealMaxLength` is provided and `content.length` is less than or
      equal to it, return `content.length`.

2.  **Fenced code block safety:**
    * If the search endpoint is inside a fenced code block, split before that
      block when possible.
    * When a length cap is provided and the block starts at the beginning of
      `content`, return the cap instead. This intentionally hard-splits
      oversized leading code blocks so streaming pending render items stay
      bounded.

3.  **Markdown-aware newline splitting:**
    * Prefer the last double newline (`\n\n`) at or before the search endpoint.
    * When a length cap is provided, fall back to the last single newline (`\n`)
      at or before the cap.
    * Chosen newline split points must not be inside a fenced code block.

4.  **Fallback behavior:**
    * Without `idealMaxLength`, preserve the historical conservative behavior:
      return `content.length` when no safe block boundary exists.
    * With `idealMaxLength`, return the cap when no safer boundary exists. This
      keeps a single very long line from remaining one ever-growing pending
      render item.
*/

/**
 * Finds the next fenced-code delimiter (a ``` or ~~~ run) at or after `from`.
 * Returns its index and the fence character, or null if none remains. Both
 * fence types are recognized so tilde-fenced blocks are handled like backtick
 * ones.
 */
const findNextFence = (
  content: string,
  from: number,
): { index: number; char: '`' | '~' } | null => {
  const backtick = content.indexOf('```', from);
  const tilde = content.indexOf('~~~', from);
  if (backtick === -1 && tilde === -1) return null;
  if (tilde === -1 || (backtick !== -1 && backtick < tilde)) {
    return { index: backtick, char: '`' };
  }
  return { index: tilde, char: '~' };
};

/**
 * Checks if a given character index is inside a fenced code block (``` or ~~~).
 * A fence only closes a block opened with the SAME character, so a ``` run
 * inside a ~~~ block (or vice versa) does not toggle the state.
 * @param content The full string content.
 * @param indexToTest The character index to test.
 */
const isIndexInsideCodeBlock = (
  content: string,
  indexToTest: number,
): boolean => {
  let openChar: '`' | '~' | '' = '';
  let searchPos = 0;
  while (searchPos < content.length) {
    const fence = findNextFence(content, searchPos);
    if (!fence || fence.index >= indexToTest) break;
    if (openChar === '') {
      openChar = fence.char;
    } else if (fence.char === openChar) {
      openChar = '';
    }
    searchPos = fence.index + 3;
  }
  return openChar !== '';
};

/**
 * Finds the starting index of the code block (``` or ~~~) that encloses the
 * given index. Returns -1 if the index is not inside a code block.
 */
const findEnclosingCodeBlockStart = (
  content: string,
  index: number,
): number => {
  let openChar: '`' | '~' | '' = '';
  let openIndex = -1;
  let searchPos = 0;
  while (searchPos < content.length) {
    const fence = findNextFence(content, searchPos);
    if (!fence || fence.index >= index) break;
    if (openChar === '') {
      openChar = fence.char;
      openIndex = fence.index;
    } else if (fence.char === openChar) {
      openChar = '';
      openIndex = -1;
    }
    searchPos = fence.index + 3;
  }
  return openChar !== '' ? openIndex : -1;
};

export const findLastSafeSplitPoint = (
  content: string,
  idealMaxLength?: number,
) => {
  const hasLengthCap = idealMaxLength !== undefined;
  const searchEnd = hasLengthCap
    ? Math.min(Math.max(idealMaxLength, 0), content.length)
    : content.length;

  if (hasLengthCap && content.length <= searchEnd) {
    return content.length;
  }

  const enclosingBlockStart = findEnclosingCodeBlockStart(content, searchEnd);
  if (enclosingBlockStart !== -1) {
    // The end of the content is contained in a code block. Split right before.
    return hasLengthCap && enclosingBlockStart === 0
      ? searchEnd
      : enclosingBlockStart;
  }

  // Search for the last double newline (\n\n) not in a code block.
  let searchStartIndex = searchEnd;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf('\n\n', searchStartIndex);
    if (dnlIndex === -1) {
      // No more double newlines found.
      break;
    }

    const potentialSplitPoint = dnlIndex + 2;
    if (
      potentialSplitPoint <= searchEnd &&
      !isIndexInsideCodeBlock(content, potentialSplitPoint)
    ) {
      return potentialSplitPoint;
    }

    // If potentialSplitPoint was inside a code block,
    // the next search should start *before* the \n\n we just found to ensure progress.
    searchStartIndex = dnlIndex - 1;
  }

  if (hasLengthCap) {
    searchStartIndex = searchEnd;
    while (searchStartIndex >= 0) {
      const nlIndex = content.lastIndexOf('\n', searchStartIndex);
      if (nlIndex === -1) {
        break;
      }

      const potentialSplitPoint = nlIndex + 1;
      if (
        potentialSplitPoint <= searchEnd &&
        !isIndexInsideCodeBlock(content, potentialSplitPoint)
      ) {
        return potentialSplitPoint;
      }

      searchStartIndex = nlIndex - 1;
    }
  }

  // Without a length cap, keep the historical behavior: only split on a safe
  // block boundary. With a cap, fall back to the cap so a single long line
  // cannot remain one ever-growing pending render item forever.
  return hasLengthCap ? searchEnd : content.length;
};
