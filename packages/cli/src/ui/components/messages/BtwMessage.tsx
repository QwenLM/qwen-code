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
 *  and a code line wraps at the narrower code width. A table is kept or
 *  dropped as one unit, and the cut never lands inside a fenced code block,
 *  a display-math block, or a table — it moves back to the block's opening
 *  line instead of emitting an orphan delimiter. Always keeps at least the
 *  last block, so a single over-budget block still renders. */
function streamingTail(text: string, rows: number, width: number): string {
  // A trailing newline would split into a phantom empty line that eats one
  // row of budget and, worse, is exempt from the budget check as the last
  // line — the walk would start on it and break on the real content, blanking
  // the answer until the next token. Trim what the renderer trims first.
  const lines = text.trimEnd().split('\n');
  // Forward pass: mark every line's block, so the backward walk can charge a
  // table as one unit and never cut a block in half.
  const blockKind: Array<TailBlockKind | null> = new Array(lines.length).fill(
    null,
  );
  const blockStart: number[] = new Array(lines.length).fill(-1);
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
        fence = '';
        fenceStart = -1;
      }
      i++;
      continue;
    }
    if (mathStart >= 0) {
      blockKind[i] = 'math';
      blockStart[i] = mathStart;
      if (MATH_FENCE_RE.test(line)) mathStart = -1;
      i++;
      continue;
    }
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      fenceStart = i;
      blockKind[i] = 'code';
      blockStart[i] = i;
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
      const { endIndex: j } = estimateTableRows(
        lines,
        i,
        width,
        Number.MAX_SAFE_INTEGER,
      );
      for (let k = i; k < j; k++) {
        blockKind[k] = 'table';
        blockStart[k] = i;
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

  let used = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; ) {
    let cost: number;
    let unitStart: number;
    if (blockKind[i] === 'table') {
      const tableStart = blockStart[i]!;
      cost = estimateTableRows(
        lines,
        tableStart,
        width,
        Number.MAX_SAFE_INTEGER,
      ).rows;
      unitStart = tableStart;
    } else if (blockKind[i] === 'code') {
      cost = estimateWrappedRows(lines[i]!, codeWidth[i]!);
      unitStart = i;
    } else {
      cost = estimateWrappedRows(lines[i]!, width);
      unitStart = i;
    }
    // The last unit is always kept, so a single over-budget block still
    // renders instead of blanking the answer.
    if (start < lines.length && used + cost > rows) {
      break;
    }
    used += cost;
    start = unitStart;
    i = unitStart - 1;
  }
  // A cut inside a fenced code or display-math block would orphan its closing
  // delimiter — the renderer reads it as an opener and the rest renders as
  // code/math. Pull the start back to the block's opening line so the block
  // renders whole (over budget by at most that block).
  if (start > 0 && start < lines.length) {
    const kind = blockKind[start];
    if ((kind === 'code' || kind === 'math') && blockStart[start]! < start) {
      start = blockStart[start]!;
    }
  }
  return lines.slice(start).join('\n');
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
