/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSpacingCategory } from '../constants/messageLayout.js';
import type { SpacingCategory } from '../constants/messageLayout.js';
import {
  MessageType,
  type HistoryItem,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  type ThoughtSummary,
} from '../types.js';

export interface ProjectedHistoryItem<T = HistoryItem> {
  item: T;
  isFirstThinking: boolean;
  isToolGroupBoundary: boolean;
  suppressNarration: boolean;
  category: SpacingCategory;
  prevCategory: SpacingCategory | undefined;
}

export function computeSuppressNarrationFlags(
  history: readonly HistoryItemWithoutId[],
  enabled: boolean,
  isTopicTool: (name: string) => boolean,
): boolean[] {
  const flags = new Array<boolean>(history.length).fill(false);
  if (!enabled) return flags;

  let toolGroupInTurn = false;
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (item.type === 'user' || item.type === 'user_shell') {
      toolGroupInTurn = false;
    } else if (item.type === 'tool_group') {
      toolGroupInTurn = item.tools.some((tool) => isTopicTool(tool.name));
    } else if (
      (item.type === 'thinking' ||
        item.type === 'gemini' ||
        item.type === 'gemini_content' ||
        item.type === 'custom_content') &&
      toolGroupInTurn
    ) {
      flags[index] = true;
    }
  }

  return flags;
}

/**
 * Computes boundary-sensitive display metadata before a render window is cut.
 * The first visible item therefore retains context from its hidden predecessor.
 */
export function projectHistoryForDisplay<T extends HistoryItemWithoutId>(
  history: readonly T[],
  suppressNarrationFlags: readonly boolean[],
  previousHistoryItem?: HistoryItemWithoutId,
): Array<ProjectedHistoryItem<T>> {
  return history.map((item, index) => {
    const previousItem =
      index === 0 ? previousHistoryItem : history[index - 1];
    const previousType = previousItem?.type;

    return {
      item,
      isFirstThinking:
        item.type === 'thinking' && previousType !== 'thinking',
      isToolGroupBoundary:
        item.type === 'tool_group' || previousType === 'tool_group',
      suppressNarration: suppressNarrationFlags[index] ?? false,
      category: getSpacingCategory(item.type),
      prevCategory: previousItem
        ? getSpacingCategory(previousItem.type)
        : undefined,
    };
  });
}

/** Builds pending terminal items while preserving display snapshot precedence. */
export function buildPendingHistoryItems({
  pendingDisplayHistory,
  pendingAssistantText,
  pendingApprovalTools,
  thought,
}: {
  pendingDisplayHistory: HistoryItemWithoutId[] | null;
  pendingAssistantText: string;
  pendingApprovalTools: IndividualToolCallDisplay[];
  thought: ThoughtSummary | null;
}): HistoryItemWithoutId[] {
  const approvalItem =
    pendingApprovalTools.length > 0
      ? ({
          type: 'tool_group',
          tools: pendingApprovalTools,
        } as HistoryItemWithoutId)
      : null;

  if (pendingDisplayHistory !== null) {
    const visiblePendingDisplayHistory = pendingDisplayHistory.filter(
      (item) => item.type !== MessageType.MODEL_QUEUE,
    );
    if (!approvalItem) {
      return visiblePendingDisplayHistory;
    }
    const displayTools = visiblePendingDisplayHistory
      .filter(
        (item): item is Extract<HistoryItemWithoutId, { type: 'tool_group' }> =>
          item.type === 'tool_group',
      )
      .flatMap((item) => item.tools);
    const missingTools = pendingApprovalTools.filter(
      (tool) =>
        !displayTools.some((display) =>
          tool.correlationId || display.correlationId
            ? tool.correlationId === display.correlationId
            : tool.callId === display.callId,
        ),
    );
    if (missingTools.length === 0) {
      return visiblePendingDisplayHistory;
    }
    return [
      ...visiblePendingDisplayHistory,
      {
        type: 'tool_group',
        tools: missingTools,
      },
    ];
  }

  const items: HistoryItemWithoutId[] = [];
  if (thought) {
    items.push({
      type: 'thinking',
      thought,
    });
  }
  if (pendingAssistantText) {
    items.push({
      type: MessageType.GEMINI,
      text: pendingAssistantText,
    });
  }
  if (approvalItem) {
    items.push(approvalItem);
  }
  return items;
}
