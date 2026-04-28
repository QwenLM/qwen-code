/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Static } from 'ink';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
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
import {
  isForceExpandGroup,
  mergeCompactToolGroups,
} from '../utils/mergeCompactToolGroups.js';

// Limit Gemini messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous response from Gemini.
// This threshold is arbitrary but should be high enough to never impact normal
// usage.
const MAX_GEMINI_MESSAGE_LINES = 65536;

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
    historyRemountKey,
  } = uiState;

  // Set of callIds whose label is absorbed by a compact-mode tool_group header.
  // Computed from RAW history (not merged) — force-expand status depends only
  // on the tool_group's own state, and mergeable groups don't change force-
  // expand status when merged. Iterating raw history avoids a circular
  // dependency with mergedHistory (which receives absorbedCallIds).
  //
  // In compact mode, non-force-expanded tool_groups render via
  // CompactToolGroupDisplay and consume the label as their header replacement.
  // Force-expanded groups (errors, confirmations, user-initiated, focused
  // shell) render through the full ToolGroupMessage path and ignore
  // compactLabel — their callIds are intentionally NOT in this set so the
  // standalone `● <label>` line in HistoryItemDisplay is the label's only
  // path to the screen.
  const absorbedCallIds = useMemo(() => {
    const absorbed = new Set<string>();
    if (!compactMode) return absorbed;
    for (const item of uiState.history) {
      if (item.type !== 'tool_group') continue;
      if (
        isForceExpandGroup(
          item,
          uiState.embeddedShellFocused ?? false,
          uiState.activePtyId,
        )
      ) {
        continue;
      }
      for (const tool of item.tools) absorbed.add(tool.callId);
    }
    return absorbed;
  }, [
    compactMode,
    uiState.history,
    uiState.embeddedShellFocused,
    uiState.activePtyId,
  ]);

  // Merge consecutive tool_groups for compact mode display. Summaries for
  // absorbed call IDs are dropped during merge so refreshStatic fires;
  // summaries for force-expanded (non-absorbed) groups pass through so
  // HistoryItemDisplay can render them as standalone `● <label>` lines.
  const mergedHistory = useMemo(
    () =>
      compactMode
        ? mergeCompactToolGroups(
            uiState.history,
            uiState.embeddedShellFocused,
            uiState.activePtyId,
            absorbedCallIds,
          )
        : uiState.history,
    [
      compactMode,
      uiState.history,
      uiState.embeddedShellFocused,
      uiState.activePtyId,
      absorbedCallIds,
    ],
  );

  // Build a callId → summary lookup from `tool_use_summary` history items so
  // compact-mode tool groups can render a semantic label instead of a generic
  // "Tool × N" line. A summary is indexed under every callId it covers; when
  // multiple groups are merged, the first group's summary wins (see below).
  const summaryByCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of uiState.history) {
      if (item.type === 'tool_use_summary') {
        for (const callId of item.precedingToolUseIds) {
          // First summary wins — earlier summaries represent the opening
          // intent of a batch streak, later ones would override it otherwise.
          if (!map.has(callId)) {
            map.set(callId, item.summary);
          }
        }
      }
    }
    return map;
  }, [uiState.history]);

  const isSummaryAbsorbed = useCallback(
    (item: HistoryItem | HistoryItemWithoutId): boolean => {
      if (item.type !== 'tool_use_summary') return false;
      return item.precedingToolUseIds.some((id) => absorbedCallIds.has(id));
    },
    [absorbedCallIds],
  );

  const getCompactLabel = useCallback(
    (item: HistoryItem | HistoryItemWithoutId): string | undefined => {
      if (item.type !== 'tool_group' || item.tools.length === 0)
        return undefined;
      // Look up ONLY the first tool's callId. A merged group concatenates
      // batch A (earliest calls) then batch B; earlier iterations scanned
      // all callIds and returned "first hit", but async resolution order
      // breaks that — if B's summary resolves first, the header renders
      // SB; when A later resolves, the next render flips to SA. Anchoring
      // on item.tools[0].callId gives stable "leading batch governs"
      // semantics; if A's call failed and only B resolved, the header
      // stays blank for that group (acceptable — the fallback is the
      // default "Tool × N" rendering once the lookup misses).
      return summaryByCallId.get(item.tools[0].callId);
    },
    [summaryByCallId],
  );

  // Ink's <Static> is append-only: once an item is rendered to the terminal
  // buffer, it cannot be replaced. In compact mode, when a new tool_group is
  // merged into a previous one, the merged result has FEWER items than the
  // raw history. Static would not re-render the older items even though their
  // content changed, so we explicitly call refreshStatic() to clear the
  // terminal and re-render the merged view.
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

  return (
    <>
      <Static
        key={historyRemountKey}
        items={[
          <AppHeader key="app-header" version={version} />,
          <DebugModeNotification key="debug-notification" />,
          <Notifications key="notifications" />,
          ...mergedHistory.map((h) => (
            <HistoryItemDisplay
              terminalWidth={terminalWidth}
              mainAreaWidth={mainAreaWidth}
              availableTerminalHeight={staticAreaMaxItemHeight}
              availableTerminalHeightGemini={MAX_GEMINI_MESSAGE_LINES}
              key={h.id}
              item={h}
              isPending={false}
              commands={uiState.slashCommands}
              compactLabel={getCompactLabel(h)}
              summaryAbsorbed={isSummaryAbsorbed(h)}
            />
          )),
        ]}
      >
        {(item) => item}
      </Static>
      <OverflowProvider>
        <Box flexDirection="column">
          {pendingHistoryItems.map((item, i) => (
            <HistoryItemDisplay
              key={i}
              availableTerminalHeight={
                uiState.constrainHeight ? availableTerminalHeight : undefined
              }
              terminalWidth={terminalWidth}
              mainAreaWidth={mainAreaWidth}
              item={{ ...item, id: 0 }}
              isPending={true}
              isFocused={!uiState.isEditorDialogOpen}
              activeShellPtyId={uiState.activePtyId}
              embeddedShellFocused={uiState.embeddedShellFocused}
              compactLabel={getCompactLabel(item)}
              summaryAbsorbed={isSummaryAbsorbed(item)}
            />
          ))}
          <ShowMoreLines constrainHeight={uiState.constrainHeight} />
        </Box>
      </OverflowProvider>
    </>
  );
};
