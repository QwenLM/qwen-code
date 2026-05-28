/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { DisplayModeProvider } from '../contexts/DisplayModeContext.js';
import { theme } from '../semantic-colors.js';
import { ScrollableList, SCROLL_TO_ITEM_END } from './shared/ScrollableList.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import type { HistoryItem } from '../types.js';
import type { FrozenSnapshot } from '../hooks/useTranscriptOverlay.js';
import { t } from '../../i18n/index.js';

interface TranscriptOverlayProps {
  snapshot: FrozenSnapshot;
  terminalWidth: number;
  mainAreaWidth: number;
  containerHeight: number | undefined;
}

/**
 * Renders the frozen Ctrl+O transcript overlay.
 *
 * Behaviour modelled on Claude Code's transcript screen
 * (`REPL.tsx:4381-4488`):
 *   - Slices the live history / pending arrays at the snapshot lengths,
 *     so the user sees what was on screen at the moment Ctrl+O was
 *     pressed. The live arrays may continue to grow in the background
 *     while the overlay is up; new entries are visible after exit.
 *   - Forces effective verbose=true via DisplayModeProvider so all
 *     thoughts and tool detail expand regardless of the user's
 *     preference.
 *   - Scrollable with Shift+↑/↓, PgUp/PgDn, Ctrl+Home/End (the same
 *     bindings ScrollableList already wires up for the virtual viewport
 *     path).
 *   - Esc or Ctrl+O closes the overlay (handled in AppContainer's
 *     keypress chain — this component is purely presentational).
 */
export const TranscriptOverlay: React.FC<TranscriptOverlayProps> = ({
  snapshot,
  terminalWidth,
  mainAreaWidth,
  containerHeight,
}) => {
  const ui = useUIState();

  // Cap by the snapshot lengths captured when Ctrl+O was pressed. New
  // items appended after that point are intentionally hidden — the user
  // asked for a frozen view.
  const slicedHistory = useMemo(
    () => ui.history.slice(0, snapshot.historyLength),
    [ui.history, snapshot.historyLength],
  );
  const slicedPending = useMemo(
    () => ui.pendingHistoryItems.slice(0, snapshot.pendingHistoryLength),
    [ui.pendingHistoryItems, snapshot.pendingHistoryLength],
  );

  // Pending items get synthetic negative ids so the renderItem path can
  // distinguish them from committed history (same convention as the VP
  // path in MainContent).
  const items = useMemo<HistoryItem[]>(
    () => [
      ...slicedHistory,
      ...slicedPending.map((item, i) => ({ ...item, id: -(i + 1) })),
    ],
    [slicedHistory, slicedPending],
  );

  // Local DisplayModeProvider override: transcript=true forces effective
  // verbose regardless of the user preference. Keeps the override
  // scoped to the overlay subtree so the live UI behind it is unaffected
  // (the live tree is no longer mounted, but if it were, it would keep
  // its own preferences).
  const transcriptMode = useMemo(
    () => ({
      verbose: ui.verbose,
      transcript: true,
    }),
    [ui.verbose],
  );

  const frozenAtLabel = useMemo(
    () => new Date(snapshot.frozenAt).toLocaleTimeString(),
    [snapshot.frozenAt],
  );

  const renderItem = useCallback(
    ({ item }: { item: HistoryItem }) => (
      <HistoryItemDisplay
        key={item.id}
        item={item}
        terminalWidth={terminalWidth}
        mainAreaWidth={mainAreaWidth}
        isPending={item.id < 0}
        commands={ui.slashCommands}
      />
    ),
    [terminalWidth, mainAreaWidth, ui.slashCommands],
  );

  return (
    <DisplayModeProvider value={transcriptMode}>
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" paddingX={1} marginBottom={1} flexShrink={0}>
          <Text bold color={theme.text.accent}>
            {t('ui.transcript.header')}
          </Text>
          <Text color={theme.text.secondary}>
            {'  '}
            {t('ui.transcript.frozenAt', { time: frozenAtLabel })}
          </Text>
        </Box>
        <OverflowProvider>
          <ScrollableList
            hasFocus={true}
            data={items}
            renderItem={renderItem}
            estimatedItemHeight={() => 3}
            keyExtractor={(it) => String(it.id)}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={containerHeight}
          />
        </OverflowProvider>
        <Box paddingX={1} marginTop={1} flexShrink={0}>
          <Text color={theme.text.secondary}>{t('ui.transcript.footer')}</Text>
        </Box>
      </Box>
    </DisplayModeProvider>
  );
};
