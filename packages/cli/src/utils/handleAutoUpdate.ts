/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateObject } from '../ui/utils/updateCheck.js';
import { updateEventEmitter } from './updateEventEmitter.js';
import { MessageType, type HistoryItem } from '../ui/types.js';
import {
  appEvents,
  AppEvent,
  LONG_TRANSIENT_MESSAGE_DURATION_MS,
  TransientMessageType,
} from './events.js';

export function setUpdateHandler(
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
  setUpdateInfo: (
    info:
      | UpdateObject
      | null
      | ((prev: UpdateObject | null) => UpdateObject | null),
  ) => void,
) {
  const handleUpdateReceived = (info: UpdateObject) => {
    if (info.isUpdating) {
      setUpdateInfo({ ...info, status: 'updating' });
    } else {
      // No auto-update — store info but don't show updating spinner
      setUpdateInfo({ ...info });
    }
  };

  const handleUpdateFailed = (data: { message: string }) => {
    setUpdateInfo((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        status: 'failed' as const,
        message: data.message,
        isUpdating: false,
      };
    });
  };

  const handleUpdateSuccess = (data: { message: string }) => {
    setUpdateInfo(null);
    appEvents.emit(AppEvent.TransientMessage, {
      id: 'auto-update-success',
      message: data.message,
      type: TransientMessageType.Success,
      durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
    });
  };

  const handleUpdateInfo = (data: { message: string }) => {
    addItem(
      {
        type: MessageType.INFO,
        text: data.message,
      },
      Date.now(),
    );
  };

  updateEventEmitter.on('update-received', handleUpdateReceived);
  updateEventEmitter.on('update-failed', handleUpdateFailed);
  updateEventEmitter.on('update-success', handleUpdateSuccess);
  updateEventEmitter.on('update-info', handleUpdateInfo);

  return () => {
    updateEventEmitter.off('update-received', handleUpdateReceived);
    updateEventEmitter.off('update-failed', handleUpdateFailed);
    updateEventEmitter.off('update-success', handleUpdateSuccess);
    updateEventEmitter.off('update-info', handleUpdateInfo);
  };
}
