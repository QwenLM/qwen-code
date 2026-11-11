/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MessageType,
  StreamingState,
  type HistoryItemWithoutId,
  type ModelQueueProps,
} from '../types.js';

export function getSessionStreamingState({
  pendingApprovalCount,
  pendingAssistantText,
  workerStatus,
  isSubmitting,
}: {
  pendingApprovalCount: number;
  pendingAssistantText: string;
  workerStatus: string;
  isSubmitting: boolean;
}): StreamingState {
  if (pendingApprovalCount > 0) return StreamingState.WaitingForConfirmation;
  if (pendingAssistantText || workerStatus === 'running' || isSubmitting) {
    return StreamingState.Responding;
  }
  return StreamingState.Idle;
}

export function getActiveModelQueue(
  pendingHistory: HistoryItemWithoutId[] | null,
): ModelQueueProps | null {
  const queueItem = pendingHistory?.find(
    (item) => item.type === MessageType.MODEL_QUEUE,
  );
  return queueItem?.type === MessageType.MODEL_QUEUE
    ? queueItem.modelQueue
    : null;
}
