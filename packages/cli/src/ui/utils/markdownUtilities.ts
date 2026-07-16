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
 * Finds the next fenced-code delimiter (a run of 3+ ``` or ~~~) at or after
 * `from`, returning its index, fence character and the FULL run length. Both
 * fence types are recognized. The run length matters: `indexOf('```')` matches
 * only the first 3 chars of a longer run, so callers must advance past the whole
 * run (index + length) or a 6-backtick fence would be miscounted as two.
 */
const findNextFence = (
  content: string,
  from: number,
): { index: number; char: '`' | '~'; length: number } | null => {
  const backtick = content.indexOf('```', from);
  const tilde = content.indexOf('~~~', from);
  if (backtick === -1 && tilde === -1) return null;
  let index: number;
  let char: '`' | '~';
  if (tilde === -1 || (backtick !== -1 && backtick < tilde)) {
    index = backtick;
    char = '`';
  } else {
    index = tilde;
    char = '~';
  }
  let length = 0;
  while (content[index + length] === char) length++;
  return { index, char, length };
};

/**
 * Returns the fenced code block (``` or ~~~) that encloses `indexToTest`, or
 * null when the index is not inside one. Reports the fence's start index, its
 * exact opening delimiter run (e.g. "```" or "~~~~") and the info string that
 * followed it on the same line (e.g. "python", "ts"), so a split can re-open an
 * identical fence. Open/close matching mirrors CommonMark / MarkdownDisplay: a
 * fence only closes a block opened with the SAME character AND a run at least as
 * long, so a ``` inside a ~~~ block — or a shorter run inside a longer fence —
 * does not toggle the state.
 */
const getEnclosingFence = (
  content: string,
  indexToTest: number,
): { startIndex: number; delimiter: string; infoString: string } | null => {
  let open: { char: '`' | '~'; len: number; index: number } | null = null;
  let searchPos = 0;
  while (searchPos < content.length) {
    const fence = findNextFence(content, searchPos);
    if (!fence || fence.index >= indexToTest) break;
    if (!open) {
      open = { char: fence.char, len: fence.length, index: fence.index };
    } else if (fence.char === open.char && fence.length >= open.len) {
      open = null;
    }
    searchPos = fence.index + fence.length;
  }
  if (!open) return null;
  const newlineIndex = content.indexOf('\n', open.index);
  const fenceLineEnd = newlineIndex === -1 ? content.length : newlineIndex;
  return {
    startIndex: open.index,
    delimiter: content.slice(open.index, open.index + open.len),
    infoString: content.slice(open.index + open.len, fenceLineEnd),
  };
};

/**
 * Checks if a given character index is inside a fenced code block (``` or ~~~).
 * Shares its fence-matching rules with {@link getEnclosingFence}.
 */
const isIndexInsideCodeBlock = (content: string, index: number): boolean =>
  getEnclosingFence(content, index) !== null;

/**
 * Finds the starting index of the code block (``` or ~~~) that encloses the
 * given index. Returns -1 if the index is not inside a code block.
 */
const findEnclosingCodeBlockStart = (content: string, index: number): number =>
  getEnclosingFence(content, index)?.startIndex ?? -1;

/**
 * When `index` sits inside an open fenced code block, returns that block's
 * language and gutter start line; otherwise null. Lets the streaming commit
 * loop tell a tall code block (safe to hard-split via splitFencedMarkdown) apart
 * from other tall blocks like tables/lists (which must stay whole), and from
 * whole-source blocks like mermaid (which must not be split mid-diagram).
 */
export const getEnclosingFenceInfo = (
  content: string,
  index: number,
): { lang: string | null; startLine: number } | null => {
  const fence = getEnclosingFence(content, index);
  return fence ? parseCodeFenceInfo(fence.infoString) : null;
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

/**
 * Internal fence info-string directive carrying the gutter start line for a
 * code block that streaming split across commits. It rides on the re-opened
 * fence's info line — which is a delimiter line, never rendered as content — so
 * it never shows on screen; it only lets `parseCodeFenceInfo` restore
 * continuous line numbering. Namespaced to avoid colliding with real info
 * strings.
 */
const START_LINE_DIRECTIVE_RE = /\s*\bqwen-code:start-line=(\d+)\b/;

/**
 * Parses a fenced code block's info string into its language (first token, with
 * the internal start-line directive removed) and the gutter start line (1 when
 * no directive is present). Shared by MarkdownDisplay so the directive never
 * leaks into language detection.
 */
export const parseCodeFenceInfo = (
  info: string | undefined | null,
): { lang: string | null; startLine: number } => {
  const raw = info ?? '';
  const directive = raw.match(START_LINE_DIRECTIVE_RE);
  const startLine = directive ? Math.max(1, Number(directive[1])) : 1;
  const lang = raw.replace(START_LINE_DIRECTIVE_RE, '').trim().split(/\s+/)[0];
  return { lang: lang || null, startLine };
};

/** Counts code lines shown in the committed head of a fenced block, i.e. the
 * lines after the opening fence line up to `splitPoint`. Used to advance the
 * re-opened tail's start line so its gutter continues instead of resetting. */
const countHeadContentLines = (
  content: string,
  fenceStartIndex: number,
  splitPoint: number,
): number => {
  const headFromFence = content.slice(fenceStartIndex, splitPoint);
  const newlineCount = (headFromFence.match(/\n/g) || []).length;
  // The opening fence line owns the first newline; the rest are content lines.
  // A head not ending in a newline has one trailing partial content line.
  return headFromFence.endsWith('\n') ? newlineCount - 1 : newlineCount;
};

/**
 * Splits `content` at `splitPoint` into a head (committed to <Static>) and a
 * tail (kept pending) for streaming render.
 *
 * `findLastSafeSplitPoint` prefers block boundaries, but with a length cap it
 * may deliberately hard-split INSIDE a fenced code block to bound an oversized
 * leading block (so the live pending frame stays within the viewport). A naive
 * substring split there breaks rendering: the head becomes an unterminated
 * fence and the tail, now missing its opening fence, renders as plain prose —
 * losing syntax highlighting and line numbers.
 *
 * This helper makes both halves valid standalone markdown: when the split lands
 * strictly inside a fence, it closes the fence at the end of the head and
 * re-opens an identical fence (same delimiter run and info string) at the start
 * of the tail. When the split is not inside a fence it is a plain substring
 * split, identical to the previous behavior.
 */
export const splitFencedMarkdown = (
  content: string,
  splitPoint: number,
): { before: string; after: string } => {
  const before = content.slice(0, splitPoint);
  const after = content.slice(splitPoint);
  if (splitPoint <= 0 || splitPoint >= content.length) {
    return { before, after };
  }

  const fence = getEnclosingFence(content, splitPoint);
  if (!fence) {
    return { before, after };
  }

  // A closing fence must carry no info string; the re-opened fence restores the
  // original delimiter run and language so the tail keeps its highlighting, and
  // advances the start-line directive so the tail's gutter continues instead of
  // resetting to 1.
  const closingFence = fence.delimiter;
  const { startLine: headStart } = parseCodeFenceInfo(fence.infoString);
  const tailStart =
    headStart + countHeadContentLines(content, fence.startIndex, splitPoint);
  const baseInfo = fence.infoString
    .replace(START_LINE_DIRECTIVE_RE, '')
    .replace(/\s+$/, '');
  const reopeningFence = `${fence.delimiter}${baseInfo} qwen-code:start-line=${tailStart}`;
  const beforeWithClose = before.endsWith('\n')
    ? `${before}${closingFence}\n`
    : `${before}\n${closingFence}\n`;
  const afterWithReopen = `${reopeningFence}\n${after}`;
  return { before: beforeWithClose, after: afterWithReopen };
};
