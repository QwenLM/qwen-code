/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { AlternateScreen } from './AlternateScreen.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import {
  ScrollableList,
  SCROLL_TO_ITEM_END,
  type ScrollableListRef,
} from './shared/ScrollableList.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import type { HistoryItem } from '../types.js';

interface TranscriptViewProps {
  /** Frozen snapshot of history + pending items, already stitched by the caller. */
  items: HistoryItem[];
  onClose: () => void;
  /**
   * When false, Ink already owns the alternate screen (VP mode) — the
   * AlternateScreen wrapper skips its escape writes to avoid double-enter.
   */
  useAlternateScreen?: boolean;
}

// Per-item virtual-scroll height estimate. The transcript renders every item
// with `fullDetail` (thinking full text, full tool output), so each item is
// far taller than MainContent's flat `() => 3`. A type-aware estimate keeps the
// scrollbar / PageUp-PageDown jump distances sane; VirtualizedList back-fills the
// real measured height once an item is rendered.
function estimateTranscriptItemHeight(item: HistoryItem): number {
  switch (item.type) {
    case 'gemini_thought':
    case 'gemini_thought_content':
      return 12;
    case 'tool_group':
      return 16;
    case 'gemini':
    case 'gemini_content':
      return 8;
    case 'user':
    case 'user_shell':
      return 2;
    default:
      return 4;
  }
}

const keyExtractor = (item: HistoryItem) =>
  item.id >= 0 ? `t-${item.id}` : `tp-${-item.id - 1}`;

export const TranscriptView: FC<TranscriptViewProps> = ({
  items,
  onClose,
  useAlternateScreen = true,
}) => {
  const { rows, columns } = useTerminalSize();
  const listRef = useRef<ScrollableListRef<HistoryItem>>(null);

  const headerHeight = 1;
  const footerHeight = 1;
  const contentHeight = Math.max(rows - headerHeight - footerHeight, 1);

  const estimatedItemHeight = useCallback(
    (index: number) => estimateTranscriptItemHeight(items[index]),
    [items],
  );

  const renderItem = useCallback(
    ({ item }: { item: HistoryItem }) => (
      <HistoryItemDisplay
        item={item}
        isPending={false}
        terminalWidth={columns}
        fullDetail
      />
    ),
    [columns],
  );

  const title = t('Transcript');

  // onClose is intentionally unused here: per design the close keys
  // (Esc / q / Ctrl+C / Ctrl+O) are owned exclusively by AppContainer's
  // global keypress guard so a single broadcast keypress isn't handled twice.
  // Kept in the props for symmetry with ThinkingViewer and future use.
  void onClose;

  const content = useMemo(
    () => (
      <OverflowProvider>
        <ScrollableList
          ref={listRef}
          hasFocus
          data={items}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          initialScrollIndex={SCROLL_TO_ITEM_END}
          containerHeight={contentHeight}
        />
      </OverflowProvider>
    ),
    [items, renderItem, estimatedItemHeight, contentHeight],
  );

  return (
    <AlternateScreen disabled={!useAlternateScreen}>
      <Box flexDirection="column" height={rows} width={columns}>
        <Box>
          <Text color={theme.text.accent} bold>
            {title}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {content}
        </Box>
        <Box justifyContent="center">
          <Text dimColor italic>
            Esc/q {t('to close')} {'  '}↑↓ {t('to scroll')} {'  '}PgUp/PgDn
            {'  '}
            Ctrl+Home/End
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  );
};
