/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreToolCallStatus } from '../types.js';
import type {
  HistoryItemWithoutId,
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';

export function isToolExecuting(
  pendingHistoryItems: HistoryItemWithoutId[],
): boolean {
  return pendingHistoryItems.some((item) => {
    if (item && item.type === 'tool_group') {
      return item.tools.some(
        (tool) => CoreToolCallStatus.Executing === tool.status,
      );
    }
    return false;
  });
}

export function isToolAwaitingConfirmation(
  pendingHistoryItems: HistoryItemWithoutId[],
): boolean {
  return pendingHistoryItems
    .filter((item): item is HistoryItemToolGroup => item.type === 'tool_group')
    .some((item) =>
      item.tools.some(
        (tool) => CoreToolCallStatus.AwaitingApproval === tool.status,
      ),
    );
}

export function getAllToolCalls(
  historyItems: HistoryItemWithoutId[],
): IndividualToolCallDisplay[] {
  return historyItems
    .filter((item): item is HistoryItemToolGroup => item.type === 'tool_group')
    .flatMap((group) => group.tools);
}
