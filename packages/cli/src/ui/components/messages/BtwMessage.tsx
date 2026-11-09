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
    ({ item }: { item: BtwAnswerItem }) => (
      <MarkdownDisplay
        text={item.text}
        isPending={false}
        contentWidth={contentWidth}
      />
    ),
    [contentWidth],
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
      </Box>
      {btw.isPending ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={Colors.AccentYellow}>{'+ '}</Text>
            <Text color={Colors.AccentYellow}>{t('Answering...')}</Text>
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
          ) : (
            <MarkdownDisplay
              text={normalizeCodeFences(btw.answer)}
              isPending={false}
              contentWidth={contentWidth}
            />
          )}
          <Box marginTop={1}>
            <Text dimColor>
              {t('Press Space, Enter, or Escape to dismiss')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export const BtwMessage = React.memo(BtwMessageInternal);
