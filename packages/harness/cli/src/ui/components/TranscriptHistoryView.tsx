/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { memo, useCallback, useMemo } from 'react';
import {
  CoreToolCallStatus,
  isTerminalStatus,
  type Message,
  type TaskStatus,
} from '@qwen-code/core';
import {
  HistoryItemDisplay,
  areHistoryItemPropsEqual,
} from './HistoryItemDisplay.js';
import {
  convertMessagesToIdentifiedHistoryFormats,
  type IdentifiedHistoryItemWithoutId,
} from '../../utils/sessionUtils.js';
import { collapseReadOnlyGroups } from '../utils/collapseReadOnlyGroups.js';
import { reorderHistoryItems } from '../utils/reorderHistoryItems.js';
import {
  MAIN_SCREEN_HISTORY_WINDOW_STEP,
  MAX_MAIN_SCREEN_HISTORY_ITEMS,
  MAX_MAIN_SCREEN_MODEL_MESSAGE_LINES,
  MAX_MAIN_SCREEN_RAW_HISTORY_ITEMS,
} from '../constants.js';
import type { HistoryItem } from '../types.js';
import {
  projectHistoryForDisplay,
  type ProjectedHistoryItem,
} from '../utils/historyProjection.js';
import { useAnchoredWindow } from '../hooks/useAnchoredWindow.js';

const MemoizedHistoryItemDisplay = memo(
  HistoryItemDisplay,
  areHistoryItemPropsEqual,
);

type IdentifiedHistoryItem = HistoryItem & { renderKey: string };

function assignIds(
  items: IdentifiedHistoryItemWithoutId[],
): IdentifiedHistoryItem[] {
  return items.map((item, index) => ({ ...item, id: index + 1 }));
}

function markInProgressToolUses(
  items: IdentifiedHistoryItemWithoutId[],
  inProgressToolUseIds: Set<string>,
): IdentifiedHistoryItemWithoutId[] {
  if (inProgressToolUseIds.size === 0) {
    return items;
  }

  return items.map((item) => {
    if (item.type !== 'tool_group') {
      return item;
    }

    let changed = false;
    const tools = item.tools.map((tool) => {
      if (!inProgressToolUseIds.has(tool.callId)) {
        return tool;
      }
      changed = true;
      return {
        ...tool,
        status: CoreToolCallStatus.Executing,
      };
    });

    return changed ? { ...item, tools } : item;
  });
}

function collectResolvedToolUseIds(messages: Message[]): Set<string> {
  const resolvedIds = new Set<string>();

  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user') {
      continue;
    }

    const content =
      'blocks' in message.message
        ? message.message.blocks
        : message.message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (block.type === 'tool_result') {
        resolvedIds.add(block.tool_use_id);
      }
    }
  }

  return resolvedIds;
}

function filterTerminalUnresolvedTools(
  items: IdentifiedHistoryItemWithoutId[],
  resolvedToolUseIds: Set<string>,
  shouldFilter: boolean,
): IdentifiedHistoryItemWithoutId[] {
  if (!shouldFilter) {
    return items;
  }

  const filteredItems: IdentifiedHistoryItemWithoutId[] = [];

  for (const item of items) {
    if (item.type !== 'tool_group') {
      filteredItems.push(item);
      continue;
    }

    const tools = item.tools.filter((tool) =>
      resolvedToolUseIds.has(tool.callId),
    );
    if (tools.length === 0) {
      continue;
    }

    filteredItems.push(
      tools.length === item.tools.length ? item : { ...item, tools },
    );
  }

  return filteredItems;
}

function hasInProgressTool(item: HistoryItem): boolean {
  return (
    item.type === 'tool_group' &&
    item.tools.some((tool) => tool.status === CoreToolCallStatus.Executing)
  );
}

function findPreviousHistoryItem(
  messages: Message[],
  startIndex: number,
): HistoryItem | undefined {
  for (let index = startIndex - 1; index >= 0; index--) {
    const { uiHistory } = convertMessagesToIdentifiedHistoryFormats([
      messages[index],
    ]);
    const item = uiHistory.at(-1);
    if (item) {
      return { ...item, id: 0 };
    }
  }
  return undefined;
}

export interface TranscriptHistoryViewProps {
  conversationKey: string;
  messages: Message[];
  terminalWidth: number;
  taskStatus?: TaskStatus;
  inProgressToolUseIds?: string[];
  availableTerminalHeight?: number;
  /** Render the complete transcript instead of the anchored main-screen window. */
  showAll?: boolean;
}

export const TranscriptHistoryView: React.FC<TranscriptHistoryViewProps> = ({
  conversationKey,
  messages,
  terminalWidth,
  taskStatus,
  inProgressToolUseIds: rawInProgressToolUseIds,
  availableTerminalHeight,
  showAll = false,
}) => {
  const taskIsTerminal = taskStatus ? isTerminalStatus(taskStatus) : false;
  const inProgressToolUseIds = useMemo(
    () => new Set(rawInProgressToolUseIds ?? []),
    [rawInProgressToolUseIds],
  );
  const getRawMessageKey = useCallback((message: Message) => message.uuid, []);
  const rawMessageWindow = useAnchoredWindow(messages, conversationKey, {
    capacity: MAX_MAIN_SCREEN_RAW_HISTORY_ITEMS,
    step: MAIN_SCREEN_HISTORY_WINDOW_STEP,
    keyOf: getRawMessageKey,
    enabled: !showAll,
  });
  const windowMessages = useMemo(
    () => Array.from(rawMessageWindow.items),
    [rawMessageWindow.items],
  );
  const previousRawHistoryItem = useMemo(
    () => findPreviousHistoryItem(messages, rawMessageWindow.startIndex),
    [messages, rawMessageWindow.startIndex],
  );
  const resolvedToolUseIds = useMemo(
    () => collectResolvedToolUseIds(windowMessages),
    [windowMessages],
  );

  const history = useMemo(() => {
    const { uiHistory } =
      convertMessagesToIdentifiedHistoryFormats(windowMessages);
    const withInProgressTools = markInProgressToolUses(
      uiHistory,
      inProgressToolUseIds,
    );
    const filteredHistory = filterTerminalUnresolvedTools(
      withInProgressTools,
      resolvedToolUseIds,
      taskIsTerminal && inProgressToolUseIds.size === 0,
    );
    return collapseReadOnlyGroups(
      reorderHistoryItems(assignIds(filteredHistory)),
    ) as IdentifiedHistoryItem[];
  }, [
    windowMessages,
    inProgressToolUseIds,
    resolvedToolUseIds,
    taskIsTerminal,
  ]);

  const augmentedHistory = useMemo(
    () => projectHistoryForDisplay(history, [], previousRawHistoryItem),
    [history, previousRawHistoryItem],
  );
  const getHistoryItemKey = useCallback(
    (entry: ProjectedHistoryItem) =>
      entry.item.renderKey ?? String(entry.item.id),
    [],
  );
  const historyWindow = useAnchoredWindow(augmentedHistory, conversationKey, {
    capacity: MAX_MAIN_SCREEN_HISTORY_ITEMS,
    step: MAIN_SCREEN_HISTORY_WINDOW_STEP,
    keyOf: getHistoryItemKey,
    enabled: !showAll,
  });

  return (
    <>
      {historyWindow.items.map(
        ({
          item,
          isFirstThinking,
          isToolGroupBoundary,
          suppressNarration,
          category,
          prevCategory,
        }) => {
          const hasInProgressTools = hasInProgressTool(item);
          return (
            <MemoizedHistoryItemDisplay
              key={item.renderKey ?? item.id}
              terminalWidth={terminalWidth}
              availableTerminalHeight={availableTerminalHeight}
              availableTerminalHeightAssistant={
                showAll
                  ? Number.MAX_SAFE_INTEGER
                  : MAX_MAIN_SCREEN_MODEL_MESSAGE_LINES
              }
              item={item}
              isPending={hasInProgressTools}
              isStatic={!hasInProgressTools}
              isExpandable={true}
              isFirstThinking={isFirstThinking}
              isToolGroupBoundary={isToolGroupBoundary}
              suppressNarration={suppressNarration}
              category={category}
              prevCategory={prevCategory}
            />
          );
        },
      )}
    </>
  );
};
