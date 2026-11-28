/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { BtwProps } from '../../types.js';
import { Colors } from '../../colors.js';
import { t } from '../../../i18n/index.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import {
  CODE_FENCE_RE,
  MATH_FENCE_RE,
  estimateTableRows,
  estimateWrappedRows,
  isClosingCodeFence,
  isTableStart,
} from '../../utils/pending-rendered-height.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { ScrollableList } from '../shared/ScrollableList.js';

export interface BtwDisplayProps {
  btw: BtwProps;
  /** Width of the parent container. Used to compute Markdown content width.
   *  Falls back to terminal width when not provided. */
  containerWidth?: number;
  /** Rows the answer area may occupy before it starts scrolling. Omit to
   *  render the whole answer (screen-reader and transcript replay paths). */
  maxAnswerRows?: number;
}

// border(1)*2 + paddingX(1)*2 = 4
const BTW_SELF_CHROME = 4;
// The scroll viewport reserves one column for its scrollbar so a long answer
// never reflows (and never clips at the right edge) when the bar appears.
const BTW_SCROLLBAR_COLUMN = 1;

interface BtwAnswerItem {
  text: string;
}

/**
 * Ensure code fences (``` or ~~~) start on their own line so that
 * MarkdownDisplay's line-based parser can detect them.  Models sometimes
 * emit the opening fence right after prose text without a preceding newline.
 */
function normalizeCodeFences(text: string): string {
  return text.replace(/([^\n])(```|~~~)/g, '$1\n$2');
}

type TailBlockKind = 'code' | 'math' | 'table';

// MarkdownDisplay renders a code line inside a 1-column prefix padding plus
// a line-number gutter (padWidth + 1, line numbers on by default), so a code
// line wraps at a narrower width than a plain line. The gutter pads to the
// widest number in the block; the block's own line count bounds it from
// above once the tail cuts the block, so the charge stays conservative.
function codeLineWidth(blockLines: number, width: number): number {
  const gutterWidth = String(Math.max(1, blockLines)).length + 1;
  return Math.max(1, width - 1 - gutterWidth);
}

/** Keeps a streaming answer inside the viewport by showing its last lines.
 *  Charges what the renderer charges, not source lines: a plain line costs
 *  its wrapped rows, a table costs its rendered height (estimateTableRows),
 *  a code line wraps at the narrower code width after tab expansion, a
 *  display-math block costs its title row plus the wrapped joined content,
 *  and a mermaid fence costs its pending preview (one header row plus at
 *  most six content rows). Fence delimiters cost nothing — the renderer
 *  draws no row for them — and a run of blank lines costs one spacer row,
 *  as the renderer collapses it. A unit is kept whole when it fits; a code
 *  block or table that does not fit is kept in part (its opener plus the
 *  fitting tail, or the table header plus the fitting data rows) or dropped
 *  whole, so the kept tail never exceeds the row budget. A single
 *  over-budget line is still kept whole, so the answer never blanks. */
function streamingTail(text: string, rows: number, width: number): string {
  // A trailing newline would split into a phantom empty line that eats one
  // row of budget and, worse, is exempt from the budget check as the last
  // line — the walk would start on it and break on the real content, blanking
  // the answer until the next token. Trim what the renderer trims first.
  // Split on \r?\n: on CRLF input a bare '\n' split leaves a trailing \r
  // that breaks the $$ fence match, so a math block would never be seen.
  const lines = text.trimEnd().split(/\r?\n/);
  // Forward pass: mark every line's block, so the backward walk can charge a
  // table as one unit and never cut a block in half.
  const blockKind: Array<TailBlockKind | null> = new Array(lines.length).fill(
    null,
  );
  const blockStart: number[] = new Array(lines.length).fill(-1);
  // Index of the block's closing line, or -1 for a block still open at the
  // streaming frontier.
  const blockEnd: number[] = new Array(lines.length).fill(-1);
  // First token of a code fence's info string, lowercased ('mermaid', 'ts',
  // ...); only set on the opening fence line.
  const blockLang: string[] = new Array(lines.length).fill('');
  // Rendered height of the table starting at this line (0 while it has no
  // data row — the renderer draws nothing for it); only set on table headers.
  const tableCost: number[] = new Array(lines.length).fill(0);
  const codeWidth: number[] = new Array(lines.length).fill(width);
  let fence = '';
  let fenceStart = -1;
  let mathStart = -1;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (fence) {
      blockKind[i] = 'code';
      blockStart[i] = fenceStart;
      if (isClosingCodeFence(CODE_FENCE_RE.exec(line), fence)) {
        const w = codeLineWidth(i - fenceStart - 1, width);
        for (let k = fenceStart + 1; k < i; k++) codeWidth[k] = w;
        for (let k = fenceStart; k <= i; k++) blockEnd[k] = i;
        fence = '';
        fenceStart = -1;
      }
      i++;
      continue;
    }
    if (mathStart >= 0) {
      blockKind[i] = 'math';
      blockStart[i] = mathStart;
      if (MATH_FENCE_RE.test(line)) {
        for (let k = mathStart; k <= i; k++) blockEnd[k] = i;
        mathStart = -1;
      }
      i++;
      continue;
    }
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      fenceStart = i;
      blockKind[i] = 'code';
      blockStart[i] = i;
      blockLang[i] =
        (fenceMatch[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      i++;
      continue;
    }
    if (MATH_FENCE_RE.test(line)) {
      mathStart = i;
      blockKind[i] = 'math';
      blockStart[i] = i;
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const { rows: cost, endIndex: j } = estimateTableRows(
        lines,
        i,
        width,
        Number.MAX_SAFE_INTEGER,
      );
      tableCost[i] = cost;
      for (let k = i; k < j; k++) {
        blockKind[k] = 'table';
        blockStart[k] = i;
        blockEnd[k] = j - 1;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (fence) {
    // Unclosed block at the streaming frontier: charge its lines at the
    // width the renderer will use for the block as it stands.
    const w = codeLineWidth(lines.length - fenceStart - 1, width);
    for (let k = fenceStart + 1; k < lines.length; k++) codeWidth[k] = w;
  }

  // Last line belonging to the block starting at `start`, closer included;
  // an open block runs to the end of the text.
  const blockLastLine = (start: number): number =>
    blockEnd[start]! >= 0 ? blockEnd[start]! : lines.length - 1;
  // Last content line of the block starting at `start` (the closer, if any,
  // is not content).
  const contentEnd = (start: number): number =>
    blockEnd[start]! >= 0 ? blockEnd[start]! - 1 : lines.length - 1;
  const isClosed = (start: number): boolean => blockEnd[start]! >= 0;
  // Rendered rows of one code line: CodeColorizer expands each tab to four
  // spaces before rendering, while string-width counts a tab as 0 — measure
  // the expanded line, wrapped at the block's code width.
  const codeLineCost = (k: number): number =>
    estimateWrappedRows(lines[k]!.replace(/\t/g, '    '), codeWidth[k]!);

  type TailUnitKind = 'code' | 'math' | 'mermaid' | 'table' | 'plain';
  interface TailUnit {
    kind: TailUnitKind;
    start: number;
    end: number;
    cost: number;
  }

  const unitAt = (i: number): TailUnit => {
    const kind = blockKind[i];
    if (kind === 'table') {
      const start = blockStart[i]!;
      return {
        kind: 'table',
        start,
        end: blockLastLine(start),
        cost: tableCost[start]!,
      };
    }
    if (kind === 'math') {
      const start = blockStart[i]!;
      const end = contentEnd(start);
      // The renderer draws the title row plus the whole content joined into
      // one wrapping line. (Its preview branch needs availableTerminalHeight,
      // which this panel never passes, so the full render always applies.)
      const joined = lines.slice(start + 1, end + 1).join(' ');
      return {
        kind: 'math',
        start,
        end: blockLastLine(start),
        cost: 1 + estimateWrappedRows(joined, Math.max(1, width - 1)),
      };
    }
    if (kind === 'code') {
      const start = blockStart[i]!;
      const end = contentEnd(start);
      if (blockLang[start] === 'mermaid') {
        // A pending mermaid block renders one header row plus at most six
        // preview rows, however long the source block is.
        return {
          kind: 'mermaid',
          start,
          end: blockLastLine(start),
          cost: 1 + Math.min(Math.max(0, end - start), 6),
        };
      }
      let cost = 0;
      for (let k = start + 1; k <= end; k++) cost += codeLineCost(k);
      return { kind: 'code', start, end: blockLastLine(start), cost };
    }
    // A plain line: blank lines collapse — a run renders as a single spacer,
    // and a run opening the window renders nothing (lastLineEmpty starts
    // true), so a blank costs one row only after a non-blank line.
    const line = lines[i]!;
    let cost: number;
    if (line.trim() !== '') {
      cost = estimateWrappedRows(line, width);
    } else if (i > 0 && lines[i - 1]!.trim() !== '') {
      cost = 1;
    } else {
      cost = 0;
    }
    return { kind: 'plain', start: i, end: i, cost };
  };

  // Rendered height of the table [header, separator, ...rows] when only its
  // last `kept` data rows survive — measured on the truncated table itself,
  // because the renderer picks the layout from the rows it actually sees.
  const truncatedTableCost = (start: number, kept: number): number => {
    const end = blockEnd[start]!;
    const dataRows = lines.slice(end - kept + 1, end + 1);
    return estimateTableRows(
      [lines[start]!, lines[start + 1]!, ...dataRows],
      0,
      width,
      Number.MAX_SAFE_INTEGER,
    ).rows;
  };
  // Most data rows that fit in `remaining` (0 always fits: a header +
  // separator with no data row renders nothing).
  const maxFittingDataRows = (start: number, remaining: number): number => {
    const dataRows = blockEnd[start]! - (start + 1);
    let lo = 0;
    let hi = dataRows;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (truncatedTableCost(start, mid) <= remaining) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  interface PartialKeep {
    at: number;
    end: number;
    text: string;
    cost: number;
  }

  // What survives of an over-budget unit, or null when the whole unit is
  // dropped. `isFirst` is true for the answer's last unit, which is never
  // dropped outright — a lone over-budget unit still renders rather than
  // blanking the answer.
  const partialKeep = (
    unit: TailUnit,
    remaining: number,
    isFirst: boolean,
  ): PartialKeep | null => {
    if (unit.kind === 'table') {
      const kept = maxFittingDataRows(unit.start, remaining);
      const end = blockEnd[unit.start]!;
      const dataRows = lines.slice(end - kept + 1, end + 1);
      return {
        at: unit.start,
        end: unit.end,
        text: [lines[unit.start]!, lines[unit.start + 1]!, ...dataRows].join(
          '\n',
        ),
        cost: truncatedTableCost(unit.start, kept),
      };
    }
    if (unit.kind === 'code') {
      const end = contentEnd(unit.start);
      // Longest fitting suffix of content lines.
      let cost = 0;
      let first = end + 1;
      for (let k = end; k > unit.start; k--) {
        const lineCost = codeLineCost(k);
        if (cost + lineCost > remaining) break;
        cost += lineCost;
        first = k;
      }
      if (first <= end) {
        const kept = lines.slice(first, end + 1);
        if (isClosed(unit.start)) kept.push(lines[blockEnd[unit.start]!]!);
        return {
          at: unit.start,
          end: unit.end,
          text: [lines[unit.start]!, ...kept].join('\n'),
          cost,
        };
      }
      if (!isFirst) return null;
      // Last unit: keep the opener plus its last line rather than nothing.
      const last = lines[end]!;
      const kept = [lines[unit.start]!, last];
      if (isClosed(unit.start)) kept.push(lines[blockEnd[unit.start]!]!);
      return {
        at: unit.start,
        end: unit.end,
        text: kept.join('\n'),
        cost: codeLineCost(end),
      };
    }
    if (unit.kind === 'mermaid') {
      // The preview draws the kept content's first lines, one row each,
      // after the header row — so keep the opener plus the content lines
      // the remaining budget can still show.
      if (remaining < 1) return null;
      const end = contentEnd(unit.start);
      const contentKept = lines.slice(
        Math.max(unit.start + 1, end - remaining + 2),
        end + 1,
      );
      const kept = [...contentKept];
      if (isClosed(unit.start)) kept.push(lines[blockEnd[unit.start]!]!);
      return {
        at: unit.start,
        end: unit.end,
        text: [lines[unit.start]!, ...kept].join('\n'),
        cost: 1 + Math.min(contentKept.length, 6),
      };
    }
    // A math block renders as one joined line — it cannot be split, so an
    // over-budget math block is dropped unless it is the last unit.
    if (!isFirst) return null;
    return {
      at: unit.start,
      end: unit.end,
      text: lines.slice(unit.start, unit.end + 1).join('\n'),
      cost: unit.cost,
    };
  };

  let used = 0;
  let start = lines.length;
  const partials: PartialKeep[] = [];
  for (let i = lines.length - 1; i >= 0; ) {
    const unit = unitAt(i);
    if (used + unit.cost <= rows) {
      used += unit.cost;
      start = unit.start;
      i = unit.start - 1;
      continue;
    }
    // Over budget: a lone trailing line is still kept whole, so the answer
    // never blanks; any other unit is kept in part or dropped.
    if (unit.kind === 'plain') {
      if (start === lines.length) {
        used += unit.cost;
        start = unit.start;
        i = unit.start - 1;
        continue;
      }
      break;
    }
    const partial = partialKeep(unit, rows - used, start === lines.length);
    if (!partial) break;
    partials.push(partial);
    used += partial.cost;
    start = unit.start;
    i = unit.start - 1;
  }
  // Splice the partially-kept units into the kept range.
  partials.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  let cursor = start;
  for (const partial of partials) {
    out.push(...lines.slice(cursor, partial.at), partial.text);
    cursor = partial.end + 1;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

function footerHint(btw: BtwProps): string {
  const hints: string[] = [];
  if (btw.historyCount) hints.push(t('←/→ browse earlier answers'));
  if (btw.browsing && !btw.isError) hints.push(t('c copy'));
  if (btw.browsing && btw.historyCount) hints.push(t('x clear history'));
  hints.push(
    btw.ownRequestPending
      ? t('Press Escape, Ctrl+C, or Ctrl+D to cancel')
      : t('Press Space, Enter, or Escape to dismiss'),
  );
  return hints.join(' · ');
}

const BtwMessageInternal: React.FC<BtwDisplayProps> = ({
  btw,
  containerWidth,
  maxAnswerRows,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const baseWidth = containerWidth ?? terminalWidth;
  // A pending answer has no content to scroll yet, so the viewport (and its
  // reserved scrollbar column) only exists once the answer arrives.
  const scrollable = maxAnswerRows !== undefined && !btw.isPending;
  const contentWidth = Math.max(
    2,
    baseWidth - BTW_SELF_CHROME - (scrollable ? BTW_SCROLLBAR_COLUMN : 0),
  );

  const answerItems = useMemo<BtwAnswerItem[]>(
    () => [{ text: normalizeCodeFences(btw.answer) }],
    [btw.answer],
  );
  const answerKeyExtractor = useCallback(() => 'btw-answer', []);
  const answerEstimatedHeight = useCallback(
    (_index: number) => {
      if (maxAnswerRows === undefined) {
        return 1;
      }
      // Wrap adds lines we cannot predict, so the source line count is a
      // lower bound; it only drives the first frame before measurement.
      const sourceLines = answerItems[0]?.text.split('\n').length ?? 1;
      return Math.max(1, Math.min(maxAnswerRows, sourceLines));
    },
    [answerItems, maxAnswerRows],
  );
  const renderAnswer = useCallback(
    ({ item }: { item: BtwAnswerItem }) =>
      btw.isError ? (
        <Text color={Colors.AccentRed} wrap="wrap">
          {item.text}
        </Text>
      ) : (
        <MarkdownDisplay
          text={item.text}
          isPending={false}
          contentWidth={contentWidth}
        />
      ),
    [btw.isError, contentWidth],
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentYellow}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row">
        <Text color={Colors.AccentYellow} bold>
          {'/btw '}
        </Text>
        <Text wrap="wrap" color={Colors.AccentYellow}>
          {btw.question}
        </Text>
        {btw.browsePosition !== undefined && btw.historyCount ? (
          <Text dimColor>{` (${btw.browsePosition}/${btw.historyCount})`}</Text>
        ) : null}
      </Box>
      {btw.isPending ? (
        <Box flexDirection="column" marginTop={1}>
          {btw.answer ? (
            <MarkdownDisplay
              // Normalize first: streamingTail's block scan must see the
              // fences on their own lines, exactly as the renderer will.
              text={
                maxAnswerRows === undefined
                  ? normalizeCodeFences(btw.answer)
                  : streamingTail(
                      normalizeCodeFences(btw.answer),
                      maxAnswerRows,
                      contentWidth,
                    )
              }
              isPending={true}
              contentWidth={contentWidth}
            />
          ) : null}
          <Box>
            <Text color={Colors.AccentYellow}>{'+ '}</Text>
            <Text color={Colors.AccentYellow}>
              {btw.retryStatus ?? t('Answering...')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {t('Press Escape, Ctrl+C, or Ctrl+D to cancel')}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {scrollable ? (
            <ScrollableList<BtwAnswerItem>
              hasFocus
              data={answerItems}
              renderItem={renderAnswer}
              estimatedItemHeight={answerEstimatedHeight}
              keyExtractor={answerKeyExtractor}
              containerHeight={maxAnswerRows}
              // Anchor the panel to the top of the answer. The transcript list
              // follows its tail; a side answer must open on its first line.
              stickToBottom={false}
              // With no fade-out the bar advertises that the answer continues
              // below — this panel has no other scroll affordance.
              scrollbarAutoHide={false}
            />
          ) : btw.isError ? (
            <Text color={Colors.AccentRed} wrap="wrap">
              {btw.answer}
            </Text>
          ) : (
            <MarkdownDisplay
              text={normalizeCodeFences(btw.answer)}
              isPending={false}
              contentWidth={contentWidth}
            />
          )}
          <Box marginTop={1} flexDirection="column">
            {btw.notice ? (
              <Text
                color={
                  btw.notice.isError ? Colors.AccentRed : Colors.AccentGreen
                }
              >
                {btw.notice.text}
              </Text>
            ) : null}
            <Text dimColor>{footerHint(btw)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export const BtwMessage = React.memo(BtwMessageInternal);
