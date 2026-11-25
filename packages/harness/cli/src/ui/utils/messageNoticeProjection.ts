/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType, type HistoryItemWithoutId } from '../types.js';

interface MessageResetTarget {
  addHistoryItem: (item: HistoryItemWithoutId) => void;
  setIdle: () => void;
  clearAssistantText: () => void;
  clearThinkingText: () => void;
  clearThought: () => void;
}

export function appendMessageError(
  text: string,
  addHistoryItem: MessageResetTarget['addHistoryItem'],
): void {
  addHistoryItem({ type: MessageType.ERROR, text });
}

function clearActiveMessage(target: MessageResetTarget): void {
  target.setIdle();
  target.clearAssistantText();
  target.clearThinkingText();
  target.clearThought();
}

export function applyMessageError(
  text: string,
  target: MessageResetTarget,
): void {
  appendMessageError(text, target.addHistoryItem);
  clearActiveMessage(target);
}

export function applyMessageInterruption(
  {
    message,
    historyAvailable,
    permissionOnly,
  }: {
    message: string;
    historyAvailable: boolean;
    permissionOnly: boolean;
  },
  target: MessageResetTarget & {
    clearApprovals: () => void;
    clearPendingHistory: () => void;
  },
): void {
  if (!historyAvailable && message) {
    target.addHistoryItem({ type: MessageType.INFO, text: message });
  }
  if (permissionOnly) {
    target.clearApprovals();
  } else {
    clearActiveMessage(target);
    target.clearPendingHistory();
  }
}
