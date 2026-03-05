/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useRef } from 'react';
import { Box } from 'ink';
import { MainContent } from '../components/MainContent.js';
import { DialogManager } from '../components/DialogManager.js';
import { Composer } from '../components/Composer.js';
import { ExitWarning } from '../components/ExitWarning.js';
import { AgentTabBar } from '../components/agent-view/AgentTabBar.js';
import { AgentChatView } from '../components/agent-view/AgentChatView.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useAgentViewState } from '../contexts/AgentViewContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
  const { refreshStatic } = useUIActions();
  const { activeView, agents } = useAgentViewState();
  const { columns: terminalWidth } = useTerminalSize();
  const hasAgents = agents.size > 0;

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
      {/* Content area: only the active view is rendered.
          Conditional rendering avoids Ink's <Static> display="none" bug
          where Static items remain visible even when the parent is hidden.
          Each mount gets a fresh <Static> instance that re-renders items
          on the cleared terminal. */}
      {activeView !== 'main' && agents.has(activeView) ? (
        <AgentChatView agentId={activeView} />
      ) : (
        <MainContent />
      )}

      {/* Shared footer — single instance keeps mainControlsRef attached
          regardless of which tab is active so height measurement stays
          current. */}
      <Box flexDirection="column" ref={uiState.mainControlsRef}>
        {uiState.dialogsVisible ? (
          <Box marginX={2} flexDirection="column" width={uiState.mainAreaWidth}>
            <DialogManager
              terminalWidth={uiState.terminalWidth}
              addItem={uiState.historyManager.addItem}
            />
          </Box>
        ) : (
          <Composer />
        )}
        <ExitWarning />
      </Box>

      {/* Tab bar: visible whenever in-process agents exist */}
      {hasAgents && <AgentTabBar />}
    </Box>
  );
};
