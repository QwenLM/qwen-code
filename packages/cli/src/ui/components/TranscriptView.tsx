/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useCallback, useMemo } from 'react';
import type { ErrorInfo } from 'react';
import { Box, Text } from 'ink';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { AlternateScreen } from './AlternateScreen.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { ErrorBoundary } from './shared/ErrorBoundary.js';
import { ScrollableList, SCROLL_TO_ITEM_END } from './shared/ScrollableList.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import type { HistoryItem } from '../types.js';

const debugLogger = createDebugLogger('TRANSCRIPT_VIEW');

interface TranscriptViewProps {
  /** Frozen snapshot of history + pending items, already stitched by the caller. */
  items: HistoryItem[];
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

const TranscriptViewImpl = ({
  items,
  useAlternateScreen = true,
}: TranscriptViewProps) => {
  const { rows, columns } = useTerminalSize();

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

  // Close keys (Esc / q / Ctrl+C / Ctrl+O) are owned exclusively by
  // AppContainer's global keypress guard so a single broadcast keypress isn't
  // handled twice — TranscriptView renders no close handler of its own.

  const content = useMemo(
    () => (
      <OverflowProvider>
        <ScrollableList
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

  // fullDetail rendering exercises paths the normal view never hits (forced
  // thinking expansion, every tool group expanded, full result blocks). An
  // unexpected item shape would otherwise throw uncaught and crash the CLI, so
  // contain it: show a fallback and let the user press Esc/q to close.
  const errorFallback = useCallback(
    (error: Error) => (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error} bold>
          {t('Failed to render transcript.')}
        </Text>
        <Text color={theme.text.secondary}>{error.message}</Text>
        <Text dimColor italic>
          Esc/q {t('to close')}
        </Text>
      </Box>
    ),
    [],
  );

  // Log caught render errors to the debug channel — the on-screen fallback is
  // user-facing, but the fullDetail paths exercise rendering the normal view
  // never hits, so a swallowed error must still leave a diagnostic trail.
  const onRenderError = useCallback((error: Error, info: ErrorInfo) => {
    debugLogger.error(
      `render error: ${error.message}`,
      info.componentStack ?? '',
    );
  }, []);

  return (
    <AlternateScreen disabled={!useAlternateScreen}>
      <Box flexDirection="column" height={rows} width={columns}>
        <Box>
          <Text color={theme.text.accent} bold>
            {title}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <ErrorBoundary fallback={errorFallback} onError={onRenderError}>
            {content}
          </ErrorBoundary>
        </Box>
        <Box justifyContent="center">
          <Text dimColor italic>
            Esc/q {t('to close')} {'  '}Shift+↑↓ {t('to scroll')} {'  '}
            PgUp/PgDn
            {'  '}
            Ctrl+Home/End
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  );
};

/**
 * Memoized so the frozen transcript doesn't re-reconcile on every AppContainer
 * re-render while streaming continues underneath. AppContainer hands a stable
 * `items` reference (memoized from the freeze snapshot), so the default shallow
 * prop compare is enough.
 */
export const TranscriptView = memo(TranscriptViewImpl);
TranscriptView.displayName = 'TranscriptView';
