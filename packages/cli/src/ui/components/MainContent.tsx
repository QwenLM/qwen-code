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
import { estimateRenderedLines } from '../utils/markdownUtilities.js';

// Limit Gemini messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous response from Gemini.
// This threshold is arbitrary but should be high enough to never impact normal
// usage.
const MAX_GEMINI_MESSAGE_LINES = 65536;

// Debug escape hatch: when set to a truthy value, reverts the pending region
// to its pre-fix unbounded layout (no height / overflow clip). Only intended
// for A/B testing the narrow-terminal duplicate-output fix — if both panes
// run at the same width, the one WITHOUT this flag should stream cleanly
// while the one WITH it will stack orphan rows in scrollback at narrow
// widths. Not part of the public API; remove once the fix is verified in
// the wild.
const isPendingClipDisabled = () => {
  const raw = process.env['QWEN_CODE_DISABLE_PENDING_CLIP'];
  return raw === '1' || raw === 'true';
};

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
        key={`${uiState.historyRemountKey}-${uiState.currentModel}`}
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
            />
          )),
        ]}
      >
        {(item) => item}
      </Static>
      {(() => {
        // Ink's log-update erases previous frames by counting `\n` in its
        // emitted output. At narrow widths — especially with CJK content —
        // the count can drift from what the terminal actually renders
        // after soft-wrapping, leaving orphan rows in scrollback (see
        // issues #2912 / #3279).
        //
        // Strategy: lock the dynamic (pending) region to an explicit,
        // Yoga-measurable `height`. Ink's `render-node-to-output` then
        // calls `output.clip()` at that height, guaranteeing emitted rows
        // == log-update's erase count regardless of wrap subtleties.
        //
        // To avoid a tall empty gap when the pending region is short, we
        // size the clip height to the *estimated* rendered height of the
        // pending content (plus a small safety buffer), capped at the
        // available viewport. `justifyContent="flex-end"` biases any
        // unavoidable clipping toward the TOP so the latest tokens
        // remain visible (normal tail-f streaming UX).
        //
        // When the user opts out of height constraint (ctrl-s /
        // `constrainHeight=false`) we fall back to the previous unbounded
        // layout to preserve "show all pending lines" behavior.
        const contentEstimateWidth = Math.max(1, terminalWidth - 4);
        const estimatedPendingLines = pendingHistoryItems.reduce(
          (sum, item) => {
            const text = (item as { text?: string }).text ?? '';
            return sum + estimateRenderedLines(text, contentEstimateWidth);
          },
          0,
        );
        // Safety buffer for markdown chrome (blank-line spacers, code block
        // "... generating more ..." line, list-item padding, the
        // ShowMoreLines trailing hint, etc.) so we don't clip useful
        // content under-estimate.
        const PENDING_HEIGHT_SAFETY_BUFFER = 3;

        const shouldConstrainHeight =
          uiState.constrainHeight &&
          availableTerminalHeight !== undefined &&
          availableTerminalHeight > 0 &&
          !isPendingClipDisabled();

        const clipHeight = shouldConstrainHeight
          ? Math.max(
              1,
              Math.min(
                estimatedPendingLines + PENDING_HEIGHT_SAFETY_BUFFER,
                availableTerminalHeight,
              ),
            )
          : undefined;

        const pendingChildren = (
          <>
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
              />
            ))}
            <ShowMoreLines constrainHeight={uiState.constrainHeight} />
          </>
        );

        return (
          <OverflowProvider>
            {clipHeight !== undefined ? (
              <Box
                flexDirection="column"
                width={terminalWidth}
                height={clipHeight}
                flexShrink={0}
                overflow="hidden"
                justifyContent="flex-end"
              >
                {pendingChildren}
              </Box>
            ) : (
              <Box flexDirection="column" width={terminalWidth} flexShrink={0}>
                {pendingChildren}
              </Box>
            )}
          </OverflowProvider>
        );
      })()}
    </>
  );
};
