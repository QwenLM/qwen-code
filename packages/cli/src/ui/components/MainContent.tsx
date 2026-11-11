/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useCallback, type ReactNode } from 'react';
import { Box } from 'ink';
import { useConversationContent } from '../hooks/useConversationContent.js';
import { AppHeader } from './AppHeader.js';
import { McpAuthHeaderNotice } from './McpAuthHeaderNotice.js';
import { useAppContext } from '../contexts/AppContext.js';
import { ScrollableList } from './shared/ScrollableList.js';
import { SCROLL_TO_ITEM_END } from './shared/VirtualizedList.js';
import { AgentTranscriptView } from './AgentTranscriptView.js';
import { FoldStateProvider } from '../contexts/FoldStateContext.js';
import { FoldLevel } from '../constants/messageLayout.js';

const MemoizedAppHeader = memo(AppHeader);

const MainContentComponent = () => {
  const { version } = useAppContext();
  const content = useConversationContent();
  const {
    uiState,
    mainAreaWidth,
    staticAreaMaxItemHeight,
    isDetailedTranscript,
    isAlternateBufferOrTerminalBuffer,
    useTerminalBuffer,
    isAlternateBuffer,
    scrollableListRef,
    virtualizedData,
    staticHistoryItems,
    lastResponseHistoryItems,
    pendingItems,
    estimatedItemHeight,
    keyExtractor,
    isStaticItem,
    shouldRenderAgentTranscript,
    viewedAgentTask,
  } = content;
  const renderItem = useCallback(
    ({ item }: { item: (typeof virtualizedData)[number] }) => {
      if (item.type === 'header') {
        return (
          <Box flexDirection="column">
            <MemoizedAppHeader
              key="app-header"
              version={version}
              showDetails={uiState.cleanUiDetailsVisible}
            />
            <McpAuthHeaderNotice message={uiState.mcpAuthNotice} />
          </Box>
        );
      }
      return item.type === 'history' ? item.element : pendingItems;
    },
    [
      version,
      uiState.cleanUiDetailsVisible,
      uiState.mcpAuthNotice,
      pendingItems,
    ],
  );
  const renderForConversationScreen = (node: ReactNode) =>
    isDetailedTranscript ? (
      <FoldStateProvider initialFoldLevel={FoldLevel.FullyExpanded}>
        {node}
      </FoldStateProvider>
    ) : (
      node
    );
  if (shouldRenderAgentTranscript && viewedAgentTask) {
    return renderForConversationScreen(
      <AgentTranscriptView
        task={viewedAgentTask}
        terminalWidth={mainAreaWidth}
        availableTerminalHeight={
          uiState.constrainHeight && !isDetailedTranscript
            ? staticAreaMaxItemHeight
            : undefined
        }
      />,
    );
  }
  if (!uiState.isConfigInitialized) {
    return renderForConversationScreen(
      isAlternateBufferOrTerminalBuffer ? null : (
        <>
          <Box flexDirection="column" key={uiState.conversationKey}>
            <MemoizedAppHeader key="app-header" version={version} />
          </Box>
        </>
      ),
    );
  }
  if (isAlternateBufferOrTerminalBuffer) {
    return renderForConversationScreen(
      <ScrollableList
        ref={scrollableListRef}
        hasFocus={!uiState.isEditorDialogOpen}
        width={uiState.terminalWidth}
        data={virtualizedData}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        initialScrollOffsetInIndex={SCROLL_TO_ITEM_END}
        renderStatic={useTerminalBuffer}
        isStaticItem={useTerminalBuffer ? isStaticItem : undefined}
        overflowToBackbuffer={useTerminalBuffer && !isAlternateBuffer}
        scrollbar={isAlternateBuffer}
      />,
    );
  }
  return renderForConversationScreen(
    <>
      <Box flexDirection="column" key={uiState.conversationKey}>
        <MemoizedAppHeader key="app-header" version={version} />
        <McpAuthHeaderNotice message={uiState.mcpAuthNotice} />
        {staticHistoryItems}
        {lastResponseHistoryItems}
      </Box>
      {pendingItems}
    </>,
  );
};
MainContentComponent.displayName = 'MainContent';
export const MainContent = memo(MainContentComponent);
