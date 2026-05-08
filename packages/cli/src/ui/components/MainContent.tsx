/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Static } from 'ink';
import { useEffect, useMemo, useRef } from 'react';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { ShowMoreLines } from './ShowMoreLines.js';
import { Notifications } from './Notifications.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useAppContext } from '../contexts/AppContext.js';
import { AppHeader } from './AppHeader.js';
import { DebugModeNotification } from './DebugModeNotification.js';
import { useCompactMode } from '../contexts/CompactModeContext.js';
import { mergeCompactToolGroups } from '../utils/mergeCompactToolGroups.js';
import {
  PendingAssistantPlaceholder,
  hasRenderablePendingAssistantSignal,
} from './messages/ConversationMessages.js';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { StreamingState } from '../types.js';
import { isUltraNarrowStreamingWidth } from '../utils/isNarrowWidth.js';
import {
  isTuiStreamDebugEnabled,
  logTuiStreamMetric,
} from '../utils/tuiStreamDiagnostics.js';

// Limit Gemini messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous response from Gemini.
// This threshold is arbitrary but should be high enough to never impact normal
// usage.
const MAX_GEMINI_MESSAGE_LINES = 65536;
const MAX_ASSISTANT_DISPLAY_TAIL_CHARS = 8000;

interface HistoryDisplayEntry {
  item: HistoryItem;
  previousAssistantText?: string;
}

interface AssistantDisplayTails {
  gemini?: string;
  thought?: string;
}

function isAssistantTextItem(
  item: HistoryItemWithoutId,
): item is
  | { type: 'gemini'; text: string }
  | { type: 'gemini_content'; text: string }
  | { type: 'gemini_thought'; text: string }
  | { type: 'gemini_thought_content'; text: string } {
  return (
    (item.type === 'gemini' ||
      item.type === 'gemini_content' ||
      item.type === 'gemini_thought' ||
      item.type === 'gemini_thought_content') &&
    'text' in item &&
    typeof item.text === 'string'
  );
}

function getAssistantDisplayTailForItem(
  item: HistoryItem,
  tails: AssistantDisplayTails,
): string | undefined {
  if (item.type === 'gemini_content') {
    return tails.gemini;
  }
  if (item.type === 'gemini_thought_content') {
    return tails.thought;
  }
  return undefined;
}

function updateAssistantDisplayTails(
  item: HistoryItem,
  tails: AssistantDisplayTails,
): void {
  if (item.type === 'gemini') {
    tails.gemini = item.text;
    tails.thought = undefined;
    return;
  }
  if (item.type === 'gemini_content') {
    tails.gemini = appendAssistantDisplayTail(tails.gemini, item.text);
    tails.thought = undefined;
    return;
  }
  if (item.type === 'gemini_thought') {
    tails.thought = item.text;
    return;
  }
  if (item.type === 'gemini_thought_content') {
    tails.thought = appendAssistantDisplayTail(tails.thought, item.text);
    return;
  }

  tails.gemini = undefined;
  tails.thought = undefined;
}

function appendAssistantDisplayTail(
  previousTail: string | undefined,
  text: string,
): string {
  const combined = previousTail ? `${previousTail}${text}` : text;
  return combined.length > MAX_ASSISTANT_DISPLAY_TAIL_CHARS
    ? combined.slice(-MAX_ASSISTANT_DISPLAY_TAIL_CHARS)
    : combined;
}

function getHistoryDisplayEntries(
  history: HistoryItem[],
  initialTails: AssistantDisplayTails = {},
): {
  entries: HistoryDisplayEntry[];
  assistantTails: AssistantDisplayTails;
} {
  const tails: AssistantDisplayTails = { ...initialTails };
  const entries = history.map((item) => {
    const entry = {
      item,
      previousAssistantText: getAssistantDisplayTailForItem(item, tails),
    };
    updateAssistantDisplayTails(item, tails);
    return entry;
  });

  return { entries, assistantTails: { ...tails } };
}

export const MainContent = () => {
  const { version } = useAppContext();
  const uiState = useUIState();
  const uiActions = useUIActions();
  const { compactMode } = useCompactMode();
  const {
    pendingHistoryItems,
    terminalWidth,
    mainAreaWidth,
    staticAreaMaxItemHeight,
    availableTerminalHeight,
  } = uiState;

  // Merge consecutive tool_groups for compact mode display
  const mergedHistory = useMemo(
    () =>
      compactMode
        ? mergeCompactToolGroups(
            uiState.history,
            uiState.embeddedShellFocused,
            uiState.activePtyId,
          )
        : uiState.history,
    [
      compactMode,
      uiState.history,
      uiState.embeddedShellFocused,
      uiState.activePtyId,
    ],
  );
  const { entries: historyDisplayEntries, assistantTails } = useMemo(
    () => getHistoryDisplayEntries(mergedHistory),
    [mergedHistory],
  );
  const { entries: pendingHistoryDisplayEntries } = useMemo(
    () =>
      getHistoryDisplayEntries(
        pendingHistoryItems.map((item) => ({ ...item, id: 0 })),
        assistantTails,
      ),
    [assistantTails, pendingHistoryItems],
  );
  const hasPendingAssistantText = pendingHistoryItems.some(isAssistantTextItem);
  const hasRenderablePendingAssistantText = pendingHistoryDisplayEntries.some(
    ({ item }) =>
      isAssistantTextItem(item) &&
      hasRenderablePendingAssistantSignal(item.text),
  );
  const isUltraNarrowResponding =
    uiState.streamingState === StreamingState.Responding &&
    isUltraNarrowStreamingWidth(terminalWidth);
  const suppressUltraNarrowLiveHistory =
    isUltraNarrowResponding &&
    (uiState.isReceivingContent || hasPendingAssistantText);
  const shouldShowPendingAssistantPlaceholder =
    uiState.streamingState === StreamingState.Responding &&
    !hasRenderablePendingAssistantText;

  // Ink's <Static> is append-only: once an item is rendered to the terminal
  // buffer, it cannot be replaced. In compact mode, when a new tool_group is
  // merged into a previous one, the merged result has FEWER items than the
  // raw history. Static would not re-render the older items even though their
  // content changed, so we explicitly call refreshStatic() to repaint the
  // visible viewport and re-render the merged view.
  //
  // Detection: if history length grew but mergedHistory length did NOT grow
  // proportionally (i.e., a merge consolidated items), trigger a refresh.
  const prevHistoryLengthRef = useRef(uiState.history.length);
  const prevMergedLengthRef = useRef(mergedHistory.length);
  useEffect(() => {
    if (!compactMode) {
      prevHistoryLengthRef.current = uiState.history.length;
      prevMergedLengthRef.current = mergedHistory.length;
      return;
    }
    const prevHLen = prevHistoryLengthRef.current;
    const currHLen = uiState.history.length;
    const prevMLen = prevMergedLengthRef.current;
    const currMLen = mergedHistory.length;
    // History grew, but merged length stayed same or shrank → a merge happened.
    if (currHLen > prevHLen && currMLen <= prevMLen) {
      uiActions.refreshStatic();
    }
    prevHistoryLengthRef.current = currHLen;
    prevMergedLengthRef.current = currMLen;
  }, [compactMode, uiState.history, mergedHistory, uiActions]);

  useEffect(() => {
    if (!shouldShowPendingAssistantPlaceholder || !isTuiStreamDebugEnabled()) {
      return;
    }

    logTuiStreamMetric('MAIN_CONTENT', 'synthetic_pending_placeholder', {
      streamingState: uiState.streamingState,
      hasPendingAssistantText,
      pendingHistoryDisplayEntryCount: pendingHistoryDisplayEntries.length,
      suppressUltraNarrowLiveHistory,
      terminalWidth,
      availableTerminalHeight,
      hasRenderablePendingAssistantText,
    });
  }, [
    availableTerminalHeight,
    hasPendingAssistantText,
    hasRenderablePendingAssistantText,
    pendingHistoryDisplayEntries.length,
    shouldShowPendingAssistantPlaceholder,
    suppressUltraNarrowLiveHistory,
    terminalWidth,
    uiState.streamingState,
  ]);

  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-start">
      <Static
        key={`${uiState.historyRemountKey}-${uiState.currentModel}`}
        items={[
          <AppHeader key="app-header" version={version} />,
          <DebugModeNotification key="debug-notification" />,
          <Notifications key="notifications" />,
          ...historyDisplayEntries.map(({ item: h, previousAssistantText }) => (
            <HistoryItemDisplay
              terminalWidth={terminalWidth}
              mainAreaWidth={mainAreaWidth}
              availableTerminalHeight={staticAreaMaxItemHeight}
              availableTerminalHeightGemini={MAX_GEMINI_MESSAGE_LINES}
              key={h.id}
              item={h}
              previousAssistantText={previousAssistantText}
              isPending={false}
              commands={uiState.slashCommands}
            />
          )),
        ]}
      >
        {(item) => item}
      </Static>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-start">
        <OverflowProvider>
          <Box flexDirection="column" justifyContent="flex-start">
            {shouldShowPendingAssistantPlaceholder && (
              <Box marginTop={1} marginLeft={2} marginRight={2}>
                <PendingAssistantPlaceholder />
              </Box>
            )}
            {pendingHistoryDisplayEntries.map(
              ({ item, previousAssistantText }, i) => {
                if (isAssistantTextItem(item)) {
                  if (!hasRenderablePendingAssistantSignal(item.text)) {
                    return null;
                  }

                  if (suppressUltraNarrowLiveHistory) {
                    return null;
                  }
                }

                return (
                  <HistoryItemDisplay
                    key={i}
                    availableTerminalHeight={
                      uiState.constrainHeight
                        ? availableTerminalHeight
                        : undefined
                    }
                    terminalWidth={terminalWidth}
                    mainAreaWidth={mainAreaWidth}
                    item={item}
                    previousAssistantText={previousAssistantText}
                    isPending={true}
                    isFocused={!uiState.isEditorDialogOpen}
                    activeShellPtyId={uiState.activePtyId}
                    embeddedShellFocused={uiState.embeddedShellFocused}
                  />
                );
              },
            )}
            {!suppressUltraNarrowLiveHistory && (
              <ShowMoreLines constrainHeight={uiState.constrainHeight} />
            )}
          </Box>
        </OverflowProvider>
      </Box>
    </Box>
  );
};
