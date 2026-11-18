/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { MainContent } from '../components/MainContent.js';
import {
  ScrollContext,
  type ScrollActions,
} from '../contexts/ScrollContext.js';
import { UpdateNotification } from '../components/UpdateNotification.js';
import { DialogManager } from '../components/DialogManager.js';
import { Composer } from '../components/Composer.js';
import { ExitWarning } from '../components/ExitWarning.js';
import { StickyTodoList } from '../components/StickyTodoList.js';
import { BtwMessage } from '../components/messages/BtwMessage.js';
import { AgentTabBar } from '../components/agent-view/AgentTabBar.js';
import { AgentChatView } from '../components/agent-view/AgentChatView.js';
import { AgentComposer } from '../components/agent-view/AgentComposer.js';
import { LiveAgentPanel } from '../components/background-view/LiveAgentPanel.js';
import { getLiveAgentPanelVpMaxRows } from '../components/background-view/liveAgentPanelVisibility.js';
import { ContextMenuOverlay } from '../context-menu/ContextMenuOverlay.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { StreamingState } from '../types.js';
import { getStickyTodoMaxVisibleItemsForMode } from '../utils/todoSnapshot.js';
import {
  getDialogMaxHeight,
  getBtwAnswerMaxRows,
} from '../utils/layoutUtils.js';
import { theme } from '../semantic-colors.js';
import { getDialogSurfaceColor } from '../utils/theme-background.js';
import { DialogSizeProvider } from '../contexts/DialogSizeContext.js';

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
  const footerRef = useRef<DOMElement>(null);
  const scrollActionsRef = useRef<ScrollActions | null>(null);
  const scrollActions = useMemo<ScrollActions>(
    () => ({
      scrollBy: (delta: number) => scrollActionsRef.current?.scrollBy(delta),
      hasScrollableTranscript: () =>
        scrollActionsRef.current?.hasScrollableTranscript() ?? false,
    }),
    [],
  );
  const { refreshStatic } = useUIActions();
  const { activeView, agents } = useAgentViewState();
  const { columns: terminalWidth } = useTerminalSize();
  const hasAgents = agents.size > 0;
  const isAgentTab = activeView !== 'main' && agents.has(activeView);
  const stickyTodoWidth = Math.min(uiState.mainAreaWidth, 64);
  const stickyTodoMaxVisibleItems = getStickyTodoMaxVisibleItemsForMode(
    uiState.terminalHeight,
    uiState.useTerminalBuffer,
  );
  const dialogMaxHeight = getDialogMaxHeight(
    uiState.terminalHeight,
    uiState.staticExtraHeight,
  );
  const constrainDialogHeight =
    uiState.constrainHeight &&
    !uiState.auth.isAuthDialogOpen &&
    !uiState.auth.authError;
  const dialogHeight = constrainDialogHeight ? dialogMaxHeight : undefined;
  const floatingDialogMaxHeight =
    uiState.isSettingsDialogOpen ||
    uiState.isResumeDialogOpen ||
    uiState.isDeleteDialogOpen
      ? Math.min(32, dialogMaxHeight)
      : dialogMaxHeight;
  const floatingDialog =
    uiState.useTerminalBuffer &&
    uiState.dialogsVisible &&
    !uiState.auth.isAuthDialogOpen &&
    !uiState.auth.authError &&
    !uiState.auth.isAuthenticating;
  const fillViewport =
    uiState.useTerminalBuffer &&
    !uiState.auth.isAuthDialogOpen &&
    !uiState.auth.authError &&
    !uiState.auth.isAuthenticating;
  const dialogWidth = Math.max(
    1,
    Math.min(uiState.mainAreaWidth, terminalWidth - 4),
  );
  const controlsHeightBeforeDialog = useRef(5);
  useLayoutEffect(() => {
    if (!uiState.dialogsVisible && uiState.mainControlsRef.current) {
      controlsHeightBeforeDialog.current = measureElement(
        uiState.mainControlsRef.current,
      ).height;
    }
  });
  // The /btw answer viewport only exists in VP mode. Its ScrollableList arms
  // SGR mouse tracking (bypassVpGate), which must not happen on the non-VP
  // main screen where the terminal keeps native scrollback — so the row budget
  // stays undefined there and the panel renders the whole answer.
  const btwAnswerMaxRows = uiState.useTerminalBuffer
    ? getBtwAnswerMaxRows(uiState.terminalHeight)
    : undefined;
  const shouldShowStickyTodos =
    uiState.stickyTodos !== null &&
    !uiState.dialogsVisible &&
    !uiState.isFeedbackDialogOpen &&
    uiState.streamingState === StreamingState.Responding;

  // Clear terminal on view switch so previous view's <Static> output
  // is removed. refreshStatic clears the terminal and bumps the
  // historyRemountKey so MainContent's <Static> re-renders all items
  // when switching back.
  const prevViewRef = useRef(activeView);
  useEffect(() => {
    if (prevViewRef.current !== activeView) {
      prevViewRef.current = activeView;
      refreshStatic();
    }
  }, [activeView, refreshStatic]);

  const inactiveComposer = (
    <Box
      height={Math.min(
        controlsHeightBeforeDialog.current,
        Math.max(1, uiState.terminalHeight - 2),
      )}
      flexDirection="column"
      justifyContent="flex-end"
      paddingX={2}
    >
      <Box
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
      >
        <Text color={theme.text.secondary} wrap="truncate-end">
          ❯ {!isAgentTab && (uiState.buffer?.lines.at(-1) ?? '')}
        </Text>
      </Box>
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={fillViewport ? uiState.terminalHeight : undefined}
    >
      {isAgentTab ? (
        <>
          {/* Agent view: chat history + agent-specific composer */}
          <AgentChatView agentId={activeView} />
          {uiState.useTerminalBuffer && <Box flexGrow={1} />}
          <Box
            flexDirection="column"
            flexShrink={0}
            ref={uiState.mainControlsRef}
          >
            {!uiState.dialogsVisible && uiState.updateInfo && (
              <UpdateNotification message={uiState.updateInfo.message} />
            )}
            <AgentComposer
              key={activeView}
              agentId={activeView}
              active={!uiState.dialogsVisible}
            />
            {uiState.dialogsVisible && !floatingDialog && (
              <Box
                marginX={2}
                flexDirection="column"
                width={uiState.mainAreaWidth}
                height={dialogHeight}
                overflow={constrainDialogHeight ? 'hidden' : undefined}
              >
                <DialogManager
                  terminalWidth={uiState.terminalWidth}
                  addItem={uiState.historyManager.addItem}
                />
              </Box>
            )}
            {uiState.dialogsVisible && inactiveComposer}
            <ExitWarning />
          </Box>
        </>
      ) : (
        <ScrollContext.Provider value={scrollActions}>
          {/* Main view: conversation history + main composer / dialogs */}
          <MainContent
            footerRef={footerRef}
            scrollActionsRef={scrollActionsRef}
          />
          {uiState.useTerminalBuffer && <Box flexGrow={1} />}
          <Box
            flexDirection="column"
            flexShrink={0}
            ref={uiState.mainControlsRef}
          >
            {!uiState.dialogsVisible && uiState.updateInfo && (
              <UpdateNotification message={uiState.updateInfo.message} />
            )}
            {floatingDialog ? (
              inactiveComposer
            ) : uiState.dialogsVisible ? (
              <Box
                marginX={2}
                flexDirection="column"
                width={uiState.mainAreaWidth}
                height={dialogHeight}
                overflow={constrainDialogHeight ? 'hidden' : undefined}
              >
                <DialogManager
                  terminalWidth={uiState.terminalWidth}
                  addItem={uiState.historyManager.addItem}
                />
              </Box>
            ) : (
              <>
                {shouldShowStickyTodos && (
                  <StickyTodoList
                    todos={uiState.stickyTodos!}
                    width={stickyTodoWidth}
                    maxVisibleItems={stickyTodoMaxVisibleItems}
                  />
                )}
                {uiState.btwItem && (
                  <Box marginX={2} width={uiState.mainAreaWidth}>
                    <BtwMessage
                      btw={uiState.btwItem.btw}
                      containerWidth={uiState.mainAreaWidth}
                      maxAnswerRows={btwAnswerMaxRows}
                    />
                  </Box>
                )}
                <Composer footerRef={footerRef} />
              </>
            )}
            <ExitWarning />
            {/*
              LiveAgentPanel — always-on roster of running subagents,
              anchored beneath the input footer (mirrors Claude Code's
              CoordinatorAgentStatus position). Hidden whenever any
              dialog is open (auth / permission / background tasks /
              etc.) so the modal surface doesn't compete with the
              live roster, and the panel's own internal self-hide
              handles the empty-roster case.

              The panel renders INSIDE `mainControlsRef` so its rows
              are picked up by `useBoxMetrics` in `AppContainer` —
              `availableTerminalHeight`
              then subtracts the panel's footprint and pending history
              items in MainContent stop racing it for screen real
              estate. (Pre-fix: the panel rendered outside the ref,
              long Read/Bash output could push the composer + panel
              off-screen — a regression vs PR #3768 which suppressed
              the inline frame in the live phase.)

              Panel uses `terminalWidth`, not `mainAreaWidth` —
              `mainAreaWidth` is hard-capped at 100 cols (intended
              for markdown / code blocks where soft-wrap matters);
              live progress lines have nothing to soft-wrap, so the
              panel wants the full terminal width.
            */}
            {!uiState.dialogsVisible && (
              <LiveAgentPanel
                width={uiState.terminalWidth}
                maxRows={
                  uiState.useTerminalBuffer
                    ? getLiveAgentPanelVpMaxRows(uiState.terminalHeight)
                    : undefined
                }
              />
            )}
          </Box>
        </ScrollContext.Provider>
      )}

      {/* Tab bar: visible whenever in-process agents exist and input is active */}
      {hasAgents && !uiState.dialogsVisible && <AgentTabBar />}

      {floatingDialog && (
        <Box
          position="absolute"
          top={0}
          left={0}
          width={terminalWidth}
          height={uiState.terminalHeight}
          alignItems="center"
          justifyContent="center"
        >
          <Box
            flexDirection="column"
            width={dialogWidth}
            maxHeight={floatingDialogMaxHeight}
            overflow="hidden"
            // Ink fills the box with unstyled spaces for the default color,
            // keeping the overlay opaque in NO_COLOR and native themes too.
            backgroundColor={getDialogSurfaceColor() ?? 'default'}
          >
            <DialogSizeProvider
              value={{ columns: dialogWidth, rows: floatingDialogMaxHeight }}
            >
              <DialogManager
                terminalWidth={dialogWidth}
                availableTerminalHeight={floatingDialogMaxHeight}
                addItem={uiState.historyManager.addItem}
              />
            </DialogSizeProvider>
          </Box>
        </Box>
      )}

      {/* Right-click context menu: absolutely-positioned overlay, drawn last
          so it paints over the transcript. Renders nothing while closed. */}
      <ContextMenuOverlay />
    </Box>
  );
};
