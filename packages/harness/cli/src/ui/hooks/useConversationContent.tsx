/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, useApp } from 'ink';
import {
  HistoryItemDisplay,
  areHistoryItemPropsEqual,
} from '../components/HistoryItemDisplay.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { usePendingHistory } from '../contexts/PendingHistoryContext.js';
import { useSettings } from '../contexts/SettingsContext.js';

import { useAlternateBuffer } from './useAlternateBuffer.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { type VirtualizedListRef } from '../components/shared/VirtualizedList.js';
import {
  useMemo,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  MAIN_SCREEN_HISTORY_WINDOW_STEP,
  MAX_MAIN_SCREEN_HISTORY_ITEMS,
  MAX_MAIN_SCREEN_HISTORY_ITEM_HEIGHT,
  MAX_MAIN_SCREEN_MODEL_MESSAGE_LINES,
  MAX_MAIN_SCREEN_RAW_HISTORY_ITEMS,
  MAX_MODEL_MESSAGE_LINES,
} from '../constants.js';
import { isTopicTool } from '../components/messages/TopicMessage.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { collapseReadOnlyGroups } from '../utils/collapseReadOnlyGroups.js';
import { reorderHistoryItems } from '../utils/reorderHistoryItems.js';
import {
  computeSuppressNarrationFlags,
  projectHistoryForDisplay,
  type ProjectedHistoryItem,
} from '../utils/historyProjection.js';
import {
  createStablePendingHistoryState,
  reconcileStablePendingHistory,
} from '../utils/stablePendingHistory.js';
import { isAgentSessionsEnabled, isAgentTask } from '@qwen-code/core';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { useTaskRegistryVersion } from './useTaskRegistryState.js';
import { useAnchoredWindow } from './useAnchoredWindow.js';
import type { HistoryItem } from '../types.js';

const MemoizedHistoryItemDisplay = memo(
  HistoryItemDisplay,
  areHistoryItemPropsEqual,
);
const getRawHistoryItemKey = (item: HistoryItem) => item.id;
const getProjectedHistoryItemKey = (entry: ProjectedHistoryItem) =>
  entry.item.id;

// Stable "narration disabled" flags. Returning a shared constant (instead of
// a freshly allocated array) keeps the downstream augmentedHistory /
// historyItems / virtualizedData memos valid while pending items churn once
// per streamed token batch — otherwise every token batch rebuilds the whole
// static-history projection and element array (O(history) per frame on long
// sessions, the streaming CPU spikes reported as "CPU 占用动不动 80%").
const EMPTY_SUPPRESS_NARRATION_FLAGS: readonly boolean[] = [];

export function useConversationContent() {
  const uiState = useUIState();
  const isDetailedTranscript = uiState.conversationScreen === 'transcript';
  const isAlternateBufferOrTerminalBuffer = useAlternateBuffer();
  const config = useConfig();
  const useTerminalBuffer = config.getUseTerminalBuffer();
  const isAlternateBuffer = config.getUseAlternateBuffer();

  const scrollableListRef = useRef<VirtualizedListRef<unknown>>(null);
  const pendingHistoryStateRef = useRef(
    createStablePendingHistoryState(uiState.conversationKey),
  );

  useEffect(() => {
    const handleScroll = () => {
      scrollableListRef.current?.scrollToEnd();
    };
    appEvents.on(AppEvent.ScrollToBottom, handleScroll);
    return () => {
      appEvents.off(AppEvent.ScrollToBottom, handleScroll);
    };
  }, []);

  const { pendingHistoryItems } = usePendingHistory();
  const { mainAreaWidth, staticAreaMaxItemHeight, availableTerminalHeight } =
    uiState;

  const settings = useSettings();
  const topicUpdateNarrationEnabled =
    settings.merged.experimental?.topicUpdateNarration === true;
  const rawHistoryWindow = useAnchoredWindow(
    uiState.history,
    uiState.conversationKey,
    {
      capacity: MAX_MAIN_SCREEN_RAW_HISTORY_ITEMS,
      step: MAIN_SCREEN_HISTORY_WINDOW_STEP,
      keyOf: getRawHistoryItemKey,
      enabled: !isAlternateBufferOrTerminalBuffer && !isDetailedTranscript,
    },
  );
  const previousRawHistoryItem =
    rawHistoryWindow.startIndex > 0
      ? uiState.history[rawHistoryWindow.startIndex - 1]
      : undefined;

  // Collapse consecutive read-only tool groups into single merged groups
  // to reduce visual clutter during exploration sequences.
  const collapsedHistory = useMemo(
    () =>
      collapseReadOnlyGroups(
        reorderHistoryItems(Array.from(rawHistoryWindow.items)),
      ),
    [rawHistoryWindow.items],
  );

  const suppressNarrationFlags = useMemo(() => {
    if (!topicUpdateNarrationEnabled) {
      return EMPTY_SUPPRESS_NARRATION_FLAGS;
    }
    const combinedHistory = [...collapsedHistory, ...pendingHistoryItems];
    return computeSuppressNarrationFlags(
      combinedHistory,
      topicUpdateNarrationEnabled,
      isTopicTool,
    );
  }, [collapsedHistory, pendingHistoryItems, topicUpdateNarrationEnabled]);

  const augmentedHistory = useMemo(
    () =>
      projectHistoryForDisplay(
        collapsedHistory,
        suppressNarrationFlags,
        previousRawHistoryItem,
      ),
    [collapsedHistory, suppressNarrationFlags, previousRawHistoryItem],
  );
  const lastUserPromptIndex = useMemo(() => {
    for (let i = collapsedHistory.length - 1; i >= 0; i--) {
      const type = collapsedHistory[i].type;
      if (type === 'user' || type === 'user_shell') {
        return i;
      }
    }
    return -1;
  }, [collapsedHistory]);

  const mainScreenHistoryWindow = useAnchoredWindow(
    augmentedHistory,
    uiState.conversationKey,
    {
      capacity: MAX_MAIN_SCREEN_HISTORY_ITEMS,
      step: MAIN_SCREEN_HISTORY_WINDOW_STEP,
      keyOf: getProjectedHistoryItemKey,
      enabled: !isAlternateBufferOrTerminalBuffer && !isDetailedTranscript,
    },
  );

  const mainScreenHistoryStartIndex = mainScreenHistoryWindow.startIndex;
  const renderedAugmentedHistory = mainScreenHistoryWindow.items;

  const pendingHistoryState = useMemo(
    () =>
      reconcileStablePendingHistory(
        pendingHistoryStateRef.current,
        pendingHistoryItems,
        uiState.conversationKey,
      ),
    [pendingHistoryItems, uiState.conversationKey],
  );
  // Do not let an abandoned concurrent render advance pending item identities.
  useLayoutEffect(() => {
    pendingHistoryStateRef.current = pendingHistoryState;
  }, [pendingHistoryState]);
  const stablePendingHistoryItems = pendingHistoryState.items;

  const renderedLastUserPromptIndex =
    lastUserPromptIndex >= mainScreenHistoryStartIndex
      ? lastUserPromptIndex - mainScreenHistoryStartIndex
      : -1;

  const mainScreenHistoryItemHeight = Math.min(
    staticAreaMaxItemHeight,
    MAX_MAIN_SCREEN_HISTORY_ITEM_HEIGHT,
  );
  const assistantLineLimit = isDetailedTranscript
    ? undefined
    : isAlternateBufferOrTerminalBuffer
      ? MAX_MODEL_MESSAGE_LINES
      : MAX_MAIN_SCREEN_MODEL_MESSAGE_LINES;

  const historyItems = useMemo(
    () =>
      renderedAugmentedHistory.map(
        ({
          item,
          isFirstThinking,
          isToolGroupBoundary,
          suppressNarration,
          category,
          prevCategory,
        }) => (
          <MemoizedHistoryItemDisplay
            terminalWidth={mainAreaWidth}
            availableTerminalHeight={
              uiState.constrainHeight && !isDetailedTranscript
                ? mainScreenHistoryItemHeight
                : undefined
            }
            availableTerminalHeightAssistant={assistantLineLimit}
            key={item.id}
            item={item}
            isPending={false}
            isStatic={true}
            isExpandable={true}
            isFirstThinking={isFirstThinking}
            isToolGroupBoundary={isToolGroupBoundary}
            suppressNarration={suppressNarration}
            category={category}
            prevCategory={prevCategory}
          />
        ),
      ),
    [
      renderedAugmentedHistory,
      mainAreaWidth,
      mainScreenHistoryItemHeight,
      uiState.constrainHeight,
      isDetailedTranscript,
      assistantLineLimit,
    ],
  );

  const staticHistoryItems = useMemo(
    () => historyItems.slice(0, renderedLastUserPromptIndex + 1),
    [historyItems, renderedLastUserPromptIndex],
  );

  const lastResponseHistoryItems = useMemo(
    () => historyItems.slice(renderedLastUserPromptIndex + 1),
    [historyItems, renderedLastUserPromptIndex],
  );

  const pendingProjection = useMemo(
    () =>
      projectHistoryForDisplay(
        stablePendingHistoryItems.map((entry) => entry.item),
        suppressNarrationFlags.slice(collapsedHistory.length),
        collapsedHistory.at(-1),
      ),
    [stablePendingHistoryItems, suppressNarrationFlags, collapsedHistory],
  );

  const pendingItems = useMemo(
    () => (
      <Box flexDirection="column" key="pending-items-group">
        {stablePendingHistoryItems.map(({ item, key, id }, i) => {
          const {
            isFirstThinking,
            isToolGroupBoundary,
            suppressNarration,
            category,
            prevCategory,
          } = pendingProjection[i];

          return (
            <HistoryItemDisplay
              key={key}
              availableTerminalHeight={
                uiState.constrainHeight && !isDetailedTranscript
                  ? availableTerminalHeight
                  : undefined
              }
              terminalWidth={mainAreaWidth}
              item={{ ...item, id }}
              isPending={true}
              isStatic={false}
              isExpandable={true}
              isFirstThinking={isFirstThinking}
              isToolGroupBoundary={isToolGroupBoundary}
              suppressNarration={suppressNarration}
              category={category}
              prevCategory={prevCategory}
            />
          );
        })}
      </Box>
    ),
    [
      stablePendingHistoryItems,
      pendingProjection,
      uiState.constrainHeight,
      isDetailedTranscript,
      availableTerminalHeight,
      mainAreaWidth,
    ],
  );

  const virtualizedData = useMemo(
    () => [
      { type: 'header' as const },
      ...renderedAugmentedHistory.map((data, index) => ({
        type: 'history' as const,
        item: data.item,
        element: historyItems[index],
      })),
      { type: 'pending' as const },
    ],
    [renderedAugmentedHistory, historyItems],
  );

  const estimatedItemHeight = useCallback(() => 100, []);

  const keyExtractor = useCallback(
    (item: (typeof virtualizedData)[number], _index: number) => {
      if (item.type === 'header') return 'header';
      if (item.type === 'history') return item.item.id.toString();
      return 'pending';
    },
    [],
  );

  // TODO(jacobr): we should return true for all messages that are not
  // interactive. Assistant messages and Tool results that are not scrollable,
  // collapsible, or clickable should also be tagged as static in the future.
  const isStaticItem = useCallback(
    (item: (typeof virtualizedData)[number]) => item.type === 'header',
    [],
  );

  // Agent transcript view: when viewing a subagent, replace main content
  const registry = useTaskRegistry();
  const registryVersion = useTaskRegistryVersion(registry);
  const viewedAgentTask = useMemo(() => {
    // `registryVersion` intentionally invalidates this memo when TaskRegistry emits.
    void registryVersion;
    if (!uiState.viewedAgentTaskId || !registry) return undefined;
    const task = registry.get(uiState.viewedAgentTaskId);
    return task && isAgentTask(task) ? task : undefined;
  }, [uiState.viewedAgentTaskId, registry, registryVersion]);
  const shouldRenderAgentTranscript =
    isAgentSessionsEnabled() && viewedAgentTask !== undefined;
  const activeTranscriptKey = shouldRenderAgentTranscript
    ? `${uiState.conversationScreen}:agent:${viewedAgentTask.id}`
    : `${uiState.conversationScreen}:main`;
  const previousTranscriptKeyRef = useRef(activeTranscriptKey);
  const { requestTranscriptReplacement } = useApp();
  useLayoutEffect(() => {
    if (previousTranscriptKeyRef.current === activeTranscriptKey) return;
    previousTranscriptKeyRef.current = activeTranscriptKey;
    requestTranscriptReplacement?.();
  }, [activeTranscriptKey, requestTranscriptReplacement]);

  return {
    uiState,
    mainAreaWidth,
    staticAreaMaxItemHeight,
    isDetailedTranscript,
    isAlternateBufferOrTerminalBuffer,
    useTerminalBuffer,
    isAlternateBuffer,
    scrollableListRef,
    virtualizedData,
    historyItems,
    staticHistoryItems,
    lastResponseHistoryItems,
    pendingItems,
    estimatedItemHeight,
    keyExtractor,
    isStaticItem,
    shouldRenderAgentTranscript,
    viewedAgentTask,
    renderedLastUserPromptIndex,
  };
}
