/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from 'ink';
import { MainContent } from '../components/MainContent.js';
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
import { FleetView } from '../components/fleet-view/FleetView.js';
import { getLiveAgentPanelVpMaxRows } from '../components/background-view/liveAgentPanelVisibility.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { StreamingState } from '../types.js';
import { getStickyTodoMaxVisibleItemsForMode } from '../utils/todoSnapshot.js';
import { getDialogMaxHeight } from '../utils/layoutUtils.js';
import { useFleetViewSessions } from '../hooks/use-fleet-view-sessions.js';

const FleetViewContainer: React.FC = () => {
  const uiState = useUIState();
  const uiActions = useUIActions();
  const config = useConfig();
  const settings = useSettings();
  const { sessions, loading, error, refresh } = useFleetViewSessions({
    isOpen: uiState.isFleetViewOpen,
    currentSessionId: config.getSessionId() ?? null,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const initialGroupMode =
    (settings.merged.ui?.fleetViewGroupMode as 'state' | 'directory') ||
    'state';
  const [groupMode, setGroupMode] = useState<'state' | 'directory'>(
    initialGroupMode,
  );

  const handleAttach = useCallback(
    (sessionId: string) => {
      uiActions.setFleetDoubleTapPending(false);
      uiActions.closeFleetView();
      if (sessionId === config.getSessionId()) return;
      void uiActions.handleResume(sessionId);
    },
    [uiActions, config],
  );

  const handleClose = useCallback(() => {
    uiActions.setFleetDoubleTapPending(false);
    uiActions.closeFleetView();
  }, [uiActions]);

  const handleDelete = useCallback(
    (sessionId: string): boolean => {
      if (sessionId === config.getSessionId()) return false;
      void config
        .getSessionService()
        .removeSession(sessionId)
        .then(() => refresh())
        .catch(() => refresh());
      return true;
    },
    [refresh, config],
  );

  const handleCreateNew = useCallback(() => {
    uiActions.setFleetDoubleTapPending(false);
    uiActions.closeFleetView();
  }, [uiActions]);

  const handleDispatch = useCallback(
    (prompt: string) => {
      uiActions.setFleetDoubleTapPending(false);
      uiActions.closeFleetView();
      uiActions.handleFinalSubmit(prompt);
    },
    [uiActions],
  );

  const handleCycleGroupMode = useCallback(
    () => setGroupMode((prev) => (prev === 'state' ? 'directory' : 'state')),
    [],
  );

  return (
    <FleetView
      sessions={sessions}
      selectedIndex={selectedIndex}
      loading={loading}
      error={error}
      groupMode={groupMode}
      onSelect={setSelectedIndex}
      onAttach={handleAttach}
      onClose={handleClose}
      onDelete={handleDelete}
      onCreateNew={handleCreateNew}
      onCycleGroupMode={handleCycleGroupMode}
      onDispatch={handleDispatch}
      workspaceCwd={config.getWorkingDir()}
      sessionService={config.getSessionService()}
      onRefresh={refresh}
      disableAlternateScreen={uiState.useTerminalBuffer}
    />
  );
};

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
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
  const dialogHeight = uiState.constrainHeight ? dialogMaxHeight : undefined;
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

  return (
    <Box flexDirection="column" width={terminalWidth}>
      {uiState.isFleetViewOpen ? (
        <FleetViewContainer />
      ) : isAgentTab ? (
        <>
          {/* Agent view: chat history + agent-specific composer */}
          <AgentChatView agentId={activeView} />
          <Box flexDirection="column" ref={uiState.mainControlsRef}>
            {!uiState.dialogsVisible && uiState.updateInfo && (
              <UpdateNotification message={uiState.updateInfo.message} />
            )}
            <AgentComposer key={activeView} agentId={activeView} />
            <ExitWarning />
          </Box>
        </>
      ) : (
        <>
          {/* Main view: conversation history + main composer / dialogs */}
          <MainContent />
          <Box flexDirection="column" ref={uiState.mainControlsRef}>
            {!uiState.dialogsVisible && uiState.updateInfo && (
              <UpdateNotification message={uiState.updateInfo.message} />
            )}
            {uiState.dialogsVisible ? (
              <Box
                marginX={2}
                flexDirection="column"
                width={uiState.mainAreaWidth}
                height={dialogHeight}
                overflow={uiState.constrainHeight ? 'hidden' : undefined}
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
                    />
                  </Box>
                )}
                <Composer />
              </>
            )}
            <ExitWarning />
            {/*
              LiveAgentPanel — always-on roster of running subagents,
              anchored beneath the input footer (mirrors Claude Code's
              CoordinatorAgentStatus position). Hidden whenever any
              dialog is open (auth / permission / background tasks /
              etc.) so the modal surface doesn't compete with the
              live roster, and the panel's internal self-hide logic
              handles the empty-roster case.

              The panel renders INSIDE `mainControlsRef` so its rows
              are picked up by `measureElement` in `AppContainer`'s
              `controlsHeight` useLayoutEffect — `availableTerminalHeight`
              then subtracts the panel's footprint and pending history
              items in MainContent stop racing it for screen real
              estate. (Pre-fix: the panel rendered outside the ref,
              long Read/Bash output could push the composer + panel
              off-screen — a regression vs PR #3768 which suppressed
              the inline frame in the live phase.)

              Panel uses `terminalWidth`, not `mainAreaWidth` —
              `mainAreaWidth` is hard-capped at 100 cols (intended
              for markdown / code blocks where soft-wrap matters);
              live progress lines have no reason to soft-wrap, so the
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
        </>
      )}

      {/* Tab bar: visible whenever in-process agents exist and input is active */}
      {hasAgents && !uiState.dialogsVisible && !uiState.isFleetViewOpen && (
        <AgentTabBar />
      )}
    </Box>
  );
};
